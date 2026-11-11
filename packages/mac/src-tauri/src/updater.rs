//! Keeping Beluga up to date: look for a new version on GitHub at launch and every few hours,
//! download it in the background, and install it when you say so: right away, when
//! you've stepped away and nothing is running, or the next time you quit.
//!
//! The window shows what's happening (`update-state` events, see lib/updates.ts); the
//! decisions about when are in update_rules.rs.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::daemon::{self, locked};
use crate::update_rules::{self, Activity, Blocker, IdleInputs, Occasion};

/// How often the background loop wakes up (cheap: no network unless a look is due).
const TICK: Duration = Duration::from_secs(60);
/// Let the window and the daemon start before the first look.
const FIRST_TICK: Duration = Duration::from_secs(20);
/// Passed to the relaunched app when it should come back without its window.
pub const BACKGROUND_ARG: &str = "--beluga-background";
/// The same, from a Klaud that installed the update to Beluga.
const OLD_BACKGROUND_ARG: &str = "--klaud-background";

/// Automatically when idle / Ask me / Off (Settings › General › Updates). `Ask` stays the
/// default for a saved file without a mode: only a new install starts on `NEW_INSTALL_MODE`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Idle,
    #[default]
    Ask,
    Off,
}

/// When a downloaded update goes in: when you're idle, or when you quit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Idle,
    Quit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Idle,
    Checking,
    Downloading,
    Ready,
    Installing,
    Current,
    Error,
}

/// A downloaded (and verified) update waiting to be installed.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pending {
    version: String,
    notes: Option<String>,
    date: Option<String>,
    /// The release's latest.json, to rebuild the update after a relaunch (re-verified then).
    raw: serde_json::Value,
    file: PathBuf,
    choice: Choice,
}

/// What Beluga was updated to, shown once after the relaunch ("What's new").
#[derive(Clone, Serialize, Deserialize)]
struct News {
    version: String,
    notes: Option<String>,
}

/// Kept in ~/Library/Application Support/io.github.kayraucklnc.beluga/updates.json (Klaud's
/// sh.klaud.mac one is brought over on the first launch: rename.rs).
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Saved {
    mode: Mode,
    last_check: Option<u64>,
    pending: Option<Pending>,
    news: Option<News>,
}

struct Inner {
    saved: Saved,
    phase: Phase,
    progress: Option<f64>,
    error: Option<String>,
    update: Option<Update>,
    activity: Option<Activity>,
    waiting: Vec<Blocker>,
    last_try: Option<u64>,
    unfocused_since: Option<Instant>,
}

impl Default for Inner {
    fn default() -> Self {
        Inner {
            saved: Saved::default(),
            phase: Phase::Idle,
            progress: None,
            error: None,
            update: None,
            activity: None,
            waiting: Vec::new(),
            last_try: None,
            unfocused_since: None,
        }
    }
}

#[derive(Default)]
pub struct Updates(Mutex<Inner>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Available {
    version: String,
    notes: Option<String>,
    date: Option<String>,
    /// The app protocol it speaks (BLG-777), for the sheet to warn about computers left behind.
    ipc: Option<u32>,
}

/// What the window shows (lib/updates.ts › UpdateState).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct View {
    current: String,
    mode: Mode,
    phase: Phase,
    last_check: Option<u64>,
    available: Option<Available>,
    progress: Option<f64>,
    choice: Option<Choice>,
    error: Option<String>,
    waiting_on: Vec<Blocker>,
    news: Option<News>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// What a new install starts on (BLG-99): update automatically when idle.
const NEW_INSTALL_MODE: Mode = Mode::Idle;
const SAVED_FILE: &str = "updates.json";

fn saved_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(SAVED_FILE))
}

/// Whether Beluga ran here before without saving its update settings: it left something else in
/// its folder (the window's place, .window-state.json, written when it quits). Nothing else
/// writes there during launch, so a new install finds the folder missing or empty.
fn ran_before(dir: &Path) -> bool {
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|e| !e.file_name().to_string_lossy().starts_with(SAVED_FILE))
    })
}

/// The saved settings, and whether to write them now. `text`: updates.json, `None` when it isn't
/// there. A saved file is kept as it is (an unreadable one, or one without a mode, is "Ask me" as
/// before), and so is an earlier install that never saved one: its mode was "Ask me". Only a new
/// install starts on `NEW_INSTALL_MODE`, written right away so the next launch reads it back.
fn first_saved(text: Option<&str>, ran_before: bool) -> (Saved, bool) {
    match text {
        Some(t) => (serde_json::from_str(t).unwrap_or_default(), false),
        None if ran_before => (Saved::default(), false),
        None => (
            Saved {
                mode: NEW_INSTALL_MODE,
                ..Saved::default()
            },
            true,
        ),
    }
}

fn download_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_cache_dir().ok()?.join("updates"))
}

fn load(app: &AppHandle) -> Saved {
    let Some(path) = saved_path(app) else {
        return Saved::default();
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        // There but unreadable: someone's settings, not a new install.
        Err(_) => Some(String::new()),
    };
    let before = text.is_none() && path.parent().is_some_and(ran_before);
    let (saved, write) = first_saved(text.as_deref(), before);
    if write {
        save(app, &saved);
    }
    saved
}

fn save(app: &AppHandle, saved: &Saved) {
    let Some(path) = saved_path(app) else { return };
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(saved)?)?;
        std::fs::rename(tmp, &path)
    };
    if let Err(e) = write() {
        eprintln!("beluga: couldn't save the update settings: {e}");
    }
}

fn view(app: &AppHandle, i: &Inner) -> View {
    View {
        current: app.package_info().version.to_string(),
        mode: i.saved.mode,
        phase: i.phase,
        last_check: i.saved.last_check,
        available: i.saved.pending.as_ref().map(|p| Available {
            version: p.version.clone(),
            notes: p.notes.clone(),
            date: p.date.clone(),
            ipc: crate::update_rules::manifest_ipc(&p.raw),
        }),
        progress: i.progress,
        choice: i.saved.pending.as_ref().map(|p| p.choice),
        error: i.error.clone(),
        waiting_on: i.waiting.clone(),
        news: i.saved.news.clone(),
    }
}

fn with<T>(app: &AppHandle, f: impl FnOnce(&mut Inner) -> T) -> T {
    let state = app.state::<Updates>();
    let mut inner = locked(&state.0);
    f(&mut inner)
}

/// Change the state and tell the window.
fn change(app: &AppHandle, f: impl FnOnce(&mut Inner)) {
    let v = with(app, |i| {
        f(i);
        view(app, i)
    });
    let _ = app.emit("update-state", v);
}

fn forget_download(pending: Option<&Pending>) {
    if let Some(p) = pending {
        let _ = std::fs::remove_file(&p.file);
    }
}

/// Whether this launch is the quiet relaunch after an idle install.
pub fn launched_in_background() -> bool {
    std::env::args().any(|a| a == BACKGROUND_ARG || a == OLD_BACKGROUND_ARG)
}

/// Load what's saved, pick up an update downloaded before, and start looking now and then.
pub fn start(app: &AppHandle) {
    let current = app.package_info().version.to_string();
    let mut saved = load(app);
    // "What's new" only once the new version really runs.
    if saved.news.as_ref().is_some_and(|n| n.version != current) {
        saved.news = None;
    }
    with(app, |i| i.saved = saved);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        restore_pending(&handle).await;
        run_loop(handle).await;
    });
}

/// A development setting: BELUGA_<name>, else the KLAUD_<name> it had before the rename.
#[cfg(debug_assertions)]
fn env(name: &str) -> Option<String> {
    std::env::var(format!("BELUGA_{name}"))
        .or_else(|_| std::env::var(format!("KLAUD_{name}")))
        .ok()
}

/// What a relaunch keeps from this one's environment: a custom home (and, in development, the
/// test endpoint), under the names from before the rename too.
pub fn kept_env() -> Vec<&'static str> {
    let mut keep = vec!["BELUGA_HOME", "KLAUD_HOME"];
    if cfg!(debug_assertions) {
        keep.extend([
            "BELUGA_UPDATE_ENDPOINT",
            "BELUGA_UPDATE_IDLE_SECS",
            "KLAUD_UPDATE_ENDPOINT",
            "KLAUD_UPDATE_IDLE_SECS",
        ]);
    }
    keep
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    #[allow(unused_mut)]
    let mut builder = app.updater_builder();
    // Development only: try a release served from this computer (see docs/updates.md).
    #[cfg(debug_assertions)]
    if let Some(url) = env("UPDATE_ENDPOINT") {
        let url = url
            .parse()
            .map_err(|e| format!("BELUGA_UPDATE_ENDPOINT: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| e.to_string())
}

/// An update downloaded before Beluga was quit (or crashed): still newer, file still intact?
async fn restore_pending(app: &AppHandle) {
    let Some(pending) = with(app, |i| i.saved.pending.clone()) else {
        return;
    };
    let restored = updater(app)
        .ok()
        .and_then(|u| u.restore_update(pending.raw.clone()).ok().flatten());
    let file = pending.file.clone();
    let ok = match restored.clone() {
        Some(update) => tauri::async_runtime::spawn_blocking(move || {
            std::fs::read(&file)
                .ok()
                .is_some_and(|bytes| update.verify(&bytes).is_ok())
        })
        .await
        .unwrap_or(false),
        None => false,
    };
    change(app, |i| {
        if ok {
            i.update = restored;
            i.phase = Phase::Ready;
        } else {
            forget_download(i.saved.pending.as_ref());
            i.saved.pending = None;
            save(app, &i.saved);
        }
    });
}

async fn run_loop(app: AppHandle) {
    tokio::time::sleep(FIRST_TICK).await;
    let mut occasion = Occasion::Launch;
    let (mut wall, mut mono) = (SystemTime::now(), Instant::now());
    loop {
        tick(&app, occasion).await;
        tokio::time::sleep(TICK).await;
        let (w, m) = (SystemTime::now(), Instant::now());
        let asleep = update_rules::slept(w.duration_since(wall).unwrap_or_default(), m - mono);
        occasion = if asleep {
            Occasion::Wake
        } else {
            Occasion::Running
        };
        (wall, mono) = (w, m);
    }
}

async fn tick(app: &AppHandle, occasion: Occasion) {
    let (mode, phase, last_ok, last_try, choice) = with(app, |i| {
        (
            i.saved.mode,
            i.phase,
            i.saved.last_check,
            i.last_try,
            i.saved.pending.as_ref().map(|p| p.choice),
        )
    });
    if mode == Mode::Off {
        return;
    }
    let settled = matches!(phase, Phase::Idle | Phase::Current | Phase::Error);
    if settled && update_rules::check_due(now_ms(), last_ok, last_try, occasion) {
        check(app, false).await;
    }
    let ready = with(app, |i| i.phase == Phase::Ready);
    if ready && (choice == Some(Choice::Idle) || mode == Mode::Idle) {
        install_if_idle(app).await;
    }
}

/// Look for an update; download it when there's one. `manual`: you asked (errors are shown).
pub async fn check(app: &AppHandle, manual: bool) {
    let busy = with(app, |i| {
        let busy = matches!(
            i.phase,
            Phase::Checking | Phase::Downloading | Phase::Installing
        );
        if !busy {
            i.last_try = Some(now_ms());
        }
        busy
    });
    if busy {
        return;
    }
    let had_ready = with(app, |i| i.phase == Phase::Ready);
    change(app, |i| {
        i.phase = Phase::Checking;
        i.error = None;
    });
    let found = match updater(app) {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e),
    };
    match found {
        Ok(None) => change(app, |i| {
            i.saved.last_check = Some(now_ms());
            // A newer one may have been pulled from GitHub; one downloaded before still counts.
            i.phase = if had_ready {
                Phase::Ready
            } else {
                Phase::Current
            };
            save(app, &i.saved);
        }),
        Ok(Some(update)) => {
            let same = with(app, |i| {
                i.saved.last_check = Some(now_ms());
                had_ready
                    && i.saved
                        .pending
                        .as_ref()
                        .is_some_and(|p| p.version == update.version)
            });
            if same {
                change(app, |i| {
                    i.phase = Phase::Ready;
                    save(app, &i.saved);
                });
            } else {
                download(app, update).await;
            }
        }
        Err(e) => {
            eprintln!("beluga: looking for an update failed: {e}");
            change(app, |i| {
                i.phase = if had_ready {
                    Phase::Ready
                } else if manual {
                    Phase::Error
                } else {
                    Phase::Idle
                };
                i.error = manual.then(|| friendly(&e));
            });
        }
    }
}

fn friendly(e: &str) -> String {
    if e.contains("error sending request") || e.contains("dns") || e.contains("connect") {
        "Couldn't reach GitHub. Check your connection and try again.".into()
    } else {
        format!("Couldn't check for updates ({e}).")
    }
}

async fn download(app: &AppHandle, update: Update) {
    change(app, |i| {
        i.phase = Phase::Downloading;
        i.progress = Some(0.0);
    });
    let mut got = 0usize;
    let mut shown = 0.0f64;
    let progress_app = app.clone();
    let result = update
        .download(
            |chunk, total| {
                got += chunk;
                let Some(total) = total.filter(|t| *t > 0) else {
                    return;
                };
                let p = (got as f64 / total as f64).min(1.0);
                if p - shown >= 0.02 {
                    shown = p;
                    change(&progress_app, |i| i.progress = Some(p));
                }
            },
            || {},
        )
        .await;
    let stored = result.map_err(|e| e.to_string()).and_then(|bytes| {
        let dir = download_dir(app).ok_or("no cache folder")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(format!("Beluga-{}.app.tar.gz", update.version));
        std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
        Ok(file)
    });
    match stored {
        Ok(file) => change(app, |i| {
            let choice = if i.saved.mode == Mode::Idle {
                Choice::Idle
            } else {
                Choice::Quit
            };
            let old = i.saved.pending.take();
            if old.as_ref().is_some_and(|p| p.file != file) {
                forget_download(old.as_ref());
            }
            i.saved.pending = Some(Pending {
                version: update.version.clone(),
                notes: update.body.clone(),
                date: update
                    .raw_json
                    .get("pub_date")
                    .and_then(|d| d.as_str())
                    .map(str::to_owned),
                raw: update.raw_json.clone(),
                file,
                choice,
            });
            i.update = Some(update);
            i.phase = Phase::Ready;
            i.progress = None;
            save(app, &i.saved);
        }),
        Err(e) => {
            eprintln!("beluga: downloading the update failed: {e}");
            change(app, |i| {
                i.phase = Phase::Error;
                i.progress = None;
                i.error = Some("The update didn't download. Beluga will try again later.".into());
            });
        }
    }
}

/// Seconds since the window lost focus (tracked tick by tick), `None` while it has it.
fn unfocused_secs(app: &AppHandle, focused: bool) -> Option<f64> {
    with(app, |i| {
        if focused {
            i.unfocused_since = None;
            return None;
        }
        let since = *i.unfocused_since.get_or_insert_with(Instant::now);
        Some(since.elapsed().as_secs_f64())
    })
}

/// How long you must be away before an idle install (development can shorten it to try it).
fn idle_for() -> f64 {
    #[cfg(debug_assertions)]
    if let Some(secs) = env("UPDATE_IDLE_SECS").and_then(|s| s.parse().ok()) {
        return secs;
    }
    update_rules::IDLE_FOR_SECS
}

/// Beluga's terminals running a program right now (`None`: couldn't tell).
#[cfg(windows)]
async fn terminal_programs(daemon_pid: u32) -> Option<usize> {
    let procs = tauri::async_runtime::spawn_blocking(windows_processes)
        .await
        .ok()??;
    Some(update_rules::busy_terminals_windows(&procs, daemon_pid))
}

/// Every process on this PC, from a ToolHelp snapshot (`None`: couldn't take one).
#[cfg(windows)]
fn windows_processes() -> Option<Vec<update_rules::WinProc>> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: a snapshot handle we open and close here, and an entry of the size the calls are
    // told; a failed call just ends the walk.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut procs = Vec::new();
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            procs.push(update_rules::WinProc {
                pid: entry.th32ProcessID,
                ppid: entry.th32ParentProcessID,
                exe: String::from_utf16_lossy(&entry.szExeFile[..len]),
            });
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
        Some(procs)
    }
}

/// Beluga's terminals running a program right now (`None`: couldn't tell).
#[cfg(unix)]
async fn terminal_programs(daemon_pid: u32) -> Option<usize> {
    let out = tauri::async_runtime::spawn_blocking(|| {
        Command::new("/bin/ps")
            .args(["-A", "-o", "pid=,ppid=,pgid=,tpgid="])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
    })
    .await
    .ok()?
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let procs = update_rules::parse_ps(&String::from_utf8_lossy(&out.stdout));
    Some(update_rules::busy_terminals(&procs, daemon_pid))
}

async fn install_if_idle(app: &AppHandle) {
    let daemon_pid = daemon::running_pid();
    let busy_terminals = match daemon_pid {
        Some(pid) => terminal_programs(pid).await,
        None => Some(0),
    };
    let window = app.get_webview_window("main");
    let focused = window
        .as_ref()
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    let inputs = IdleInputs {
        daemon_up: daemon_pid.is_some(),
        activity: with(app, |i| i.activity),
        busy_terminals,
        idle_secs: crate::system_idle_seconds(),
        unfocused_secs: unfocused_secs(app, focused),
        idle_for: idle_for(),
    };
    let waiting = update_rules::blockers(&inputs);
    if with(app, |i| i.waiting != waiting) {
        eprintln!("beluga: the update waits for {waiting:?}");
        change(app, |i| i.waiting.clone_from(&waiting));
    }
    if waiting.is_empty() {
        // Away from a window you weren't looking at: it comes back hidden, in the menu bar.
        if let Err(e) = install_and_relaunch(app, !focused).await {
            eprintln!("beluga: installing the update failed: {e}");
        }
    }
}

/// The update and its downloaded file, rebuilt from latest.json if needed.
fn ready_update(app: &AppHandle) -> Option<(Update, Pending)> {
    let (update, pending) = with(app, |i| (i.update.clone(), i.saved.pending.clone()));
    let pending = pending?;
    let update = match update {
        Some(u) => u,
        None => updater(app)
            .ok()?
            .restore_update(pending.raw.clone())
            .ok()??,
    };
    Some((update, pending))
}

/// Verify and put the new app in place of this one. The running app carries on from memory.
///
/// On Windows the installer takes over and this process ends inside `install`, so what a
/// finished install leaves behind ("what's new", no download waiting) is saved first, and put
/// back if the installer doesn't start. `reopen`: the Windows installer opens the new Beluga
/// when it's done (Restart Now, Update When Idle), never after you quit (#426).
fn install_files(
    app: &AppHandle,
    update: &Update,
    pending: &Pending,
    reopen: bool,
) -> Result<(), String> {
    let bytes = std::fs::read(&pending.file).map_err(|e| e.to_string())?;
    if cfg!(windows) {
        record_install(app, pending, true);
    }
    let result = update
        .clone()
        .restart_after_install(reopen)
        .install(bytes)
        .map_err(|e| e.to_string());
    record_install(app, pending, result.is_ok());
    result
}

/// What an install leaves saved: the news when it went in, and never the same download again.
fn record_install(app: &AppHandle, pending: &Pending, installed: bool) {
    let mut saved = with(app, |i| {
        if installed {
            i.saved.news = Some(News {
                version: pending.version.clone(),
                notes: pending.notes.clone(),
            });
        } else if i
            .saved
            .news
            .as_ref()
            .is_some_and(|n| n.version == pending.version)
        {
            // Said ahead of the Windows installer, which then didn't start: not true after all.
            i.saved.news = None;
        }
        // A package that doesn't verify or install is dropped (a fresh one comes next time).
        i.saved.pending = None;
        i.update = None;
        i.saved.clone()
    });
    forget_download(Some(pending));
    if !installed {
        saved.news = None;
    }
    save(app, &saved);
}

/// Install now and open the new Beluga (`background`: without its window, not taking focus).
async fn install_and_relaunch(app: &AppHandle, background: bool) -> Result<(), String> {
    let (update, pending) = ready_update(app).ok_or("No update is ready.")?;
    change(app, |i| i.phase = Phase::Installing);
    // Windows can't replace the bundled node.exe while the daemon runs it, and the installer
    // ends this process before quitting would stop it: stop it first.
    #[cfg(windows)]
    crate::daemon::stop_for_update(app).await;
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        install_files(&handle, &update, &pending, true)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    if let Err(e) = result {
        change(app, |i| {
            i.phase = Phase::Error;
            i.error = Some(format!("The update couldn't be installed ({e})."));
        });
        return Err(e);
    }
    // The old daemon goes with the old app (quitting stops it); the new app starts its own.
    relaunch(app, background);
    Ok(())
}

/// The .app this runs from (`None` when it isn't one: `tauri dev`).
pub fn bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let named = |p: &Path, n: &str| p.file_name().is_some_and(|f| f == n);
    (named(macos, "MacOS")
        && named(contents, "Contents")
        && bundle.extension().is_some_and(|e| e == "app"))
    .then(|| bundle.to_path_buf())
}

/// What `open` gets to start the new app once this one has quit.
fn open_args(bundle: &Path, background: bool) -> Vec<String> {
    let mut args = vec!["-n".to_string()];
    if background {
        args.push("-g".into());
    }
    for name in kept_env() {
        if let Ok(value) = std::env::var(name) {
            args.push("--env".into());
            args.push(format!("{name}={value}"));
        }
    }
    args.push(bundle.to_string_lossy().into_owned());
    if background {
        args.push("--args".into());
        args.push(BACKGROUND_ARG.into());
    }
    args
}

/// Quit, and start the new Beluga once this one is gone (so only one ever runs, and the menu-bar
/// icon and beluga:// links go to the new one).
fn relaunch(app: &AppHandle, background: bool) {
    let Some(bundle) = bundle_path() else {
        app.restart();
    };
    const WAIT_THEN_OPEN: &str = "pid=$1; shift; i=0; \
        while kill -0 \"$pid\" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done; \
        exec /usr/bin/open \"$@\"";
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(WAIT_THEN_OPEN)
        .arg("beluga-relaunch")
        .arg(std::process::id().to_string())
        .args(open_args(&bundle, background))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    if let Err(e) = cmd.spawn() {
        eprintln!("beluga: couldn't arrange the relaunch: {e}");
    }
    app.exit(0);
}

/// Quitting with an update downloaded: put it in place, so the next launch is the new Beluga.
pub fn on_exit(app: &AppHandle) {
    let off = with(app, |i| {
        i.saved.mode == Mode::Off || i.phase == Phase::Installing
    });
    if off {
        return;
    }
    if let Some((update, pending)) = ready_update(app) {
        crate::quit::at(app, crate::quit::Stage::InstallingUpdate);
        // Quit means quit: the new version opens the next time you open Beluga.
        if let Err(e) = install_files(app, &update, &pending, false) {
            eprintln!("beluga: installing the update on quit failed: {e}");
        }
    }
}

// ---- what the window can ask

#[tauri::command]
pub fn update_state(app: AppHandle) -> View {
    with(&app, |i| view(&app, i))
}

/// Settings › Check now, or the sheet's Check Again.
#[tauri::command]
pub fn update_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move { check(&app, true).await });
}

/// Beluga › Check for Updates…: look, and open the sheet to show what was found.
pub fn check_from_menu(app: &AppHandle) {
    let _ = app.emit("update-show", ());
    update_check(app.clone());
}

#[tauri::command]
pub fn update_set_mode(app: AppHandle, mode: Mode) {
    change(&app, |i| {
        i.saved.mode = mode;
        match mode {
            // Off: no updates unless you ask, and nothing installs behind your back.
            Mode::Off => {
                forget_download(i.saved.pending.as_ref());
                i.saved.pending = None;
                i.update = None;
                if i.phase == Phase::Ready {
                    i.phase = Phase::Idle;
                }
            }
            Mode::Idle => {
                if let Some(p) = i.saved.pending.as_mut() {
                    p.choice = Choice::Idle;
                }
            }
            Mode::Ask => {}
        }
        save(&app, &i.saved);
    });
}

/// The sheet's buttons: Restart Now ("now"), Update When Idle ("idle"), Later ("quit").
#[tauri::command]
pub async fn update_choose(app: AppHandle, choice: String) -> Result<(), String> {
    let choice = match choice.as_str() {
        "now" => return install_and_relaunch(&app, false).await,
        "idle" => Choice::Idle,
        "quit" => Choice::Quit,
        _ => return Err("Unknown choice".into()),
    };
    change(&app, |i| {
        if let Some(p) = i.saved.pending.as_mut() {
            p.choice = choice;
        }
        save(&app, &i.saved);
    });
    Ok(())
}

/// What's going on in Beluga, from the window (`None`: it isn't connected).
#[tauri::command]
pub fn update_activity(app: AppHandle, activity: Option<Activity>) {
    with(&app, |i| i.activity = activity);
}

/// The "What's new" note after an update was seen.
#[tauri::command]
pub fn update_dismiss_news(app: AppHandle) {
    change(&app, |i| {
        i.saved.news = None;
        save(&app, &i.saved);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relaunches_quietly_only_when_asked() {
        let bundle = Path::new("/Applications/Beluga.app");
        let loud = open_args(bundle, false);
        assert_eq!(loud.first().map(String::as_str), Some("-n"));
        assert!(!loud.iter().any(|a| a == "-g" || a == BACKGROUND_ARG));
        assert_eq!(
            loud.last().map(String::as_str),
            Some("/Applications/Beluga.app")
        );
        let quiet = open_args(bundle, true);
        assert!(quiet.iter().any(|a| a == "-g"));
        assert_eq!(quiet.last().map(String::as_str), Some(BACKGROUND_ARG));
    }

    #[test]
    fn old_settings_files_still_load() {
        let saved: Saved = serde_json::from_str(r#"{"mode":"idle"}"#).unwrap();
        assert_eq!(saved.mode, Mode::Idle);
        assert!(saved.pending.is_none());
        let empty: Saved = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.mode, Mode::Ask);
    }

    #[test]
    fn a_new_install_updates_automatically() {
        let (saved, write) = first_saved(None, false);
        assert_eq!(saved.mode, Mode::Idle);
        assert!(write, "saved right away, so the next launch keeps it");
        // What was written reads back the same, now that Beluga has run.
        let text = serde_json::to_string(&saved).unwrap();
        let (again, write) = first_saved(Some(&text), true);
        assert_eq!(again.mode, Mode::Idle);
        assert!(!write);
    }

    #[test]
    fn turning_it_off_stays_off() {
        for mode in [Mode::Ask, Mode::Off] {
            let saved = Saved {
                mode,
                ..Saved::default()
            };
            let text = serde_json::to_string(&saved).unwrap();
            assert_eq!(first_saved(Some(&text), true).0.mode, mode);
            assert_eq!(first_saved(Some(&text), false).0.mode, mode);
        }
    }

    #[test]
    fn earlier_installs_keep_what_they_had() {
        // Saved before, with "Ask me" or no mode at all: still "Ask me".
        assert_eq!(
            first_saved(Some(r#"{"mode":"ask"}"#), true).0.mode,
            Mode::Ask
        );
        assert_eq!(
            first_saved(Some(r#"{"lastCheck":1}"#), true).0.mode,
            Mode::Ask
        );
        assert_eq!(first_saved(Some("not json"), true).0.mode, Mode::Ask);
        // Ran before but never saved: it was "Ask me", and isn't written over.
        let (saved, write) = first_saved(None, true);
        assert_eq!(saved.mode, Mode::Ask);
        assert!(!write);
    }

    #[test]
    fn knows_an_earlier_install_by_what_it_left() {
        let dir = std::env::temp_dir().join(format!("beluga-ran-before-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!ran_before(&dir), "no folder: a new install");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!ran_before(&dir), "an empty folder: a new install");
        std::fs::write(dir.join("updates.json.tmp"), "{}").unwrap();
        assert!(!ran_before(&dir), "our own half-written file doesn't count");
        std::fs::write(dir.join(".window-state.json"), "{}").unwrap();
        assert!(ran_before(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
