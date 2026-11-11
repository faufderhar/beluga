//! Keeping Beluga's daemon running: find the one that runs (`beluga daemon` run by hand, say),
//! else start the bundled one, and tell the web view where it is.

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
#[cfg(unix)]
use std::sync::{mpsc, OnceLock};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};

use crate::AppState;

/// How long Beluga gets to start before we give up.
const START_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a daemon gets to quit on its own before it's forced.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// How long your shell gets to say what your PATH is.
#[cfg(unix)]
const SHELL_TIMEOUT: Duration = Duration::from_secs(4);
const PATH_MARK: &str = "__BELUGA_PATH__";

#[derive(Serialize, Clone)]
pub struct Endpoint {
    pub url: String,
    pub token: String,
}

#[derive(Deserialize)]
struct Info {
    pid: u32,
    port: u16,
    token: String,
    /// The Beluga version it runs (missing only in daemon.json files from very old versions).
    #[serde(default)]
    version: Option<String>,
    /// Started to stay up for the Mac app (`--keep-alive`), not run by hand.
    #[serde(default, rename = "keepAlive")]
    keep_alive: bool,
}

impl From<Info> for Endpoint {
    fn from(info: Info) -> Self {
        Endpoint {
            url: format!("ws://127.0.0.1:{}", info.port),
            token: info.token,
        }
    }
}

/// Lock a mutex even if another thread panicked while holding it (the data is still fine here).
pub fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Where Beluga keeps its things, as the core decides it (src/core/home.ts): $BELUGA_HOME (or the
/// $KLAUD_HOME / $KLAUDE_HOME of before the rename), else ~/.beluga. Until the core has moved an
/// older ~/.klaud there (it does on its first start), that one is read.
pub fn beluga_home() -> PathBuf {
    let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
    let set = var("BELUGA_HOME")
        .or_else(|| var("KLAUD_HOME"))
        .or_else(|| var("KLAUDE_HOME"));
    home_in(
        set.map(PathBuf::from),
        &dirs::home_dir().unwrap_or_default(),
    )
}

fn home_in(set: Option<PathBuf>, user_home: &std::path::Path) -> PathBuf {
    if let Some(dir) = set {
        return dir;
    }
    let home = user_home.join(".beluga");
    if home.exists() {
        return home;
    }
    [".klaud", ".klaude"]
        .iter()
        .map(|name| user_home.join(name))
        .find(|old| old.exists())
        .unwrap_or(home)
}

/// The signals the app sends: only checking, asking to quit and forcing.
#[cfg(unix)]
pub mod sig {
    pub const CHECK: i32 = 0;
    pub const TERM: i32 = libc::SIGTERM;
    pub const KILL: i32 = libc::SIGKILL;
}

/// Windows has no signals: checking opens the process, and quitting ends it outright (the daemon
/// writes everything as it goes, and a stale daemon.json is told apart by its port).
#[cfg(windows)]
pub mod sig {
    pub const CHECK: i32 = 0;
    pub const TERM: i32 = 15;
    pub const KILL: i32 = 9;
}

/// Send a signal to a process (0 only checks that it's there and ours).
#[cfg(unix)]
pub fn signal(pid: u32, sig: i32) -> bool {
    // Never 0 (our whole process group) or 1 (the system's first process).
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 1 {
        return false;
    }
    // SAFETY: kill(2) takes plain integers and has no memory effects; a bad pid just fails.
    unsafe { libc::kill(pid, sig) == 0 }
}

#[cfg(windows)]
pub fn signal(pid: u32, sig: i32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    };
    if pid <= 4 {
        return false;
    }
    let access = if sig == sig::CHECK {
        PROCESS_QUERY_LIMITED_INFORMATION
    } else {
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE
    };
    // SAFETY: plain Win32 calls on a handle we open and close here; a bad pid just fails.
    unsafe {
        let handle = OpenProcess(access, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let running = GetExitCodeProcess(handle, &mut code) != 0 && code == STILL_ACTIVE as u32;
        let done = if sig == sig::CHECK || !running {
            running
        } else {
            TerminateProcess(handle, 1) != 0
        };
        CloseHandle(handle);
        done
    }
}

fn alive(pid: u32) -> bool {
    signal(pid, sig::CHECK)
}

/// Whether something answers on Beluga's port (a leftover pid could belong to anything).
fn listening(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn read_info() -> Option<Info> {
    let text = std::fs::read_to_string(beluga_home().join("daemon.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// The daemon that's really up: its process is there and it answers on its port.
fn up() -> Option<Info> {
    read_info().filter(|info| alive(info.pid) && listening(info.port))
}

/// The running daemon's process id (to look at its terminals), if one runs.
pub fn running_pid() -> Option<u32> {
    up().map(|info| info.pid)
}

/// The Beluga version bundled in this app (its package.json), `None` in development.
fn bundled_version(app: &AppHandle) -> Option<String> {
    let resources = app.path().resource_dir().ok()?;
    let text = std::fs::read_to_string(resources.join("daemon").join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(str::to_owned)
}

/// Whether a running daemon is an older (or other) Beluga this app should replace with its
/// own: only a kept-alive one (a Mac app started it, maybe the version before an update),
/// never one started by hand.
fn outdated(running: Option<&str>, keep_alive: bool, bundled: Option<&str>) -> bool {
    keep_alive && matches!((running, bundled), (Some(r), Some(b)) if r != b)
}

/// The process that started `pid` (1 once that one is gone), if it can be told. Windows doesn't
/// hand orphans to a first process, but there a daemon stops by itself once the app that started
/// it is gone (its input closes: stop-on-input.ts), so none is left behind.
#[cfg(windows)]
fn parent_of(_pid: u32) -> Option<u32> {
    None
}

#[cfg(unix)]
fn parent_of(pid: u32) -> Option<u32> {
    let out = Command::new("/bin/ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let parent: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    // A Linux desktop hands orphans to your session's systemd (a "subreaper"), not to process 1.
    #[cfg(target_os = "linux")]
    if adopted(std::fs::read_to_string(format!("/proc/{parent}/comm")).ok().as_deref()) {
        return Some(1);
    }
    Some(parent)
}

/// Whether a process by this name only adopts orphans (systemd, for your session or the system).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn adopted(comm: Option<&str>) -> bool {
    comm.is_some_and(|c| c.trim() == "systemd")
}

/// Whether a running daemon was left behind by a Mac app that's gone (it crashed, was force
/// quit or killed): kept alive for an app, now launchd's. Quitting never stops one this app
/// didn't start, and such a daemon can lose your login session (its terminals can't read the
/// Keychain, so Claude Code isn't signed in, nor open a browser or copy), so it's replaced.
/// One started by hand is left alone.
fn orphaned(keep_alive: bool, parent: Option<u32>) -> bool {
    keep_alive && parent == Some(1)
}

/// If the daemon this app started has quit, let go of it (so it doesn't linger) and say how.
fn reap(app: &AppHandle) -> Option<ExitStatus> {
    let state = app.try_state::<AppState>()?;
    let mut slot = locked(&state.child);
    let status = slot.as_mut()?.try_wait().ok().flatten()?;
    *slot = None;
    if !status.success() {
        note_exit(&status);
    }
    Some(status)
}

/// A daemon that died on its own (a crash, a kill), kept with the black box's incidents so a
/// problem report says how it ended (src/core/blackbox/report.ts, BLG-673). Stopping it on
/// purpose takes the child first, so never comes through here.
fn note_exit(status: &ExitStatus) {
    let dir = beluga_home().join("logs").join("incidents");
    let at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let note = serde_json::json!({ "kind": "exit", "at": at, "status": status.to_string() });
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join(format!("{at}-exit.json")), note.to_string());
    }
}

fn running(app: &AppHandle) -> Option<Info> {
    reap(app);
    up()
}

/// Apps opened from Finder get a bare PATH; Beluga needs yours (git, gh, claude, node tools).
/// Windows starts apps with your PATH already.
#[cfg(windows)]
async fn login_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

/// Linux desktops start apps with the session's PATH, without what your shell's profile adds
/// (nvm, volta, ~/.local/bin, npm's global folder): your shell's first, then the rest.
#[cfg(all(unix, not(target_os = "macos")))]
async fn login_path() -> String {
    static PATH: OnceLock<String> = OnceLock::new();
    if let Some(path) = PATH.get() {
        return path.clone();
    }
    let found = tauri::async_runtime::spawn_blocking(shell_path)
        .await
        .ok()
        .flatten();
    let session = std::env::var("PATH").unwrap_or_default();
    PATH.get_or_init(|| merge_paths(found.as_deref().unwrap_or(""), &session))
        .clone()
}

/// `first`'s folders, then `then`'s not already there.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn merge_paths(first: &str, then: &str) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for dir in first.split(':').chain(then.split(':')) {
        if !dir.is_empty() && !seen.contains(&dir) {
            seen.push(dir);
        }
    }
    seen.join(":")
}

#[cfg(target_os = "macos")]
async fn login_path() -> String {
    static PATH: OnceLock<String> = OnceLock::new();
    if let Some(path) = PATH.get() {
        return path.clone();
    }
    let found = tauri::async_runtime::spawn_blocking(shell_path)
        .await
        .ok()
        .flatten();
    PATH.get_or_init(|| found.unwrap_or_else(fallback_path))
        .clone()
}

/// Ask your login shell for its PATH, giving up (and stopping it) if it takes too long.
#[cfg(unix)]
fn shell_path() -> Option<String> {
    let fallback = if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| fallback.into());
    let script = format!("printf '{PATH_MARK}%s{PATH_MARK}' \"$PATH\"");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut seen = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stdout.read(&mut chunk) {
            if n == 0 {
                break;
            }
            seen.extend_from_slice(&chunk[..n]);
            if parse_path(&String::from_utf8_lossy(&seen)).is_some() {
                break;
            }
        }
        let _ = tx.send(seen);
    });
    let seen = rx.recv_timeout(SHELL_TIMEOUT).ok();
    let _ = child.kill();
    let _ = child.wait();
    parse_path(&String::from_utf8_lossy(&seen?))
}

/// The PATH between the markers (your shell's startup files may print other things too).
#[cfg_attr(windows, allow(dead_code))]
fn parse_path(text: &str) -> Option<String> {
    let rest = &text[text.find(PATH_MARK)? + PATH_MARK.len()..];
    let path = rest[..rest.find(PATH_MARK)?].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// When the shell can't say: the PATH we have, plus where Homebrew puts things.
#[cfg(target_os = "macos")]
fn fallback_path() -> String {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let extra = PathBuf::from(extra);
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    std::env::join_paths(dirs)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin".into())
}

/// Past this the log is set aside as daemon.log.1 (src/daemon/files.ts LOG_LIMIT). The daemon
/// trims it while it runs too (src/daemon/log-size.ts).
const LOG_LIMIT: u64 = 5 * 1024 * 1024;

fn log_file() -> Option<std::fs::File> {
    let dir = beluga_home().join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("daemon.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_LIMIT) {
        let _ = std::fs::rename(&path, dir.join("daemon.log.1"));
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

/// The end of the daemon's log written since `from` (for saying why Beluga didn't start).
fn log_tail(from: u64) -> String {
    let read = || -> Option<String> {
        let mut file = std::fs::File::open(beluga_home().join("logs").join("daemon.log")).ok()?;
        let len = file.metadata().ok()?.len();
        file.seek(SeekFrom::Start(from.min(len).max(len.saturating_sub(2000))))
            .ok()?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        Some(String::from_utf8_lossy(&bytes).trim().to_string())
    };
    match read() {
        Some(tail) if !tail.is_empty() => format!("\n{tail}"),
        _ => String::new(),
    }
}

/// The command that runs Beluga's daemon, and whether its pid is the daemon's own pid (it isn't
/// when a launcher like `npx` sits in between).
fn base_command(app: &AppHandle) -> Result<(Command, bool), String> {
    if let Some((node, script)) = bundled(app) {
        let mut c = Command::new(node);
        c.arg(script);
        return Ok((c, true));
    }
    dev_command().map(|c| (c, false))
}

/// Development: run Beluga from the repository with tsx.
#[cfg(debug_assertions)]
fn dev_command() -> Result<Command, String> {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut c = Command::new(if cfg!(windows) { "npx.cmd" } else { "npx" });
    c.current_dir(&repo).args(["tsx", "src/cli.ts"]);
    c.env("BELUGA_ALLOW_ORIGINS", "http://localhost:1420");
    Ok(c)
}

#[cfg(not(debug_assertions))]
fn dev_command() -> Result<Command, String> {
    Err("Beluga's engine is missing from this app. Please reinstall Beluga.".into())
}

/// The bundled Node's name beside the app (tauri.*.conf.json externalBin): on Linux the packages
/// put it in /usr/bin, so it can't be a plain `node` there.
const NODE_NAME: &str = if cfg!(target_os = "linux") {
    "beluga-node"
} else {
    "node"
};

/// The Node binary and Beluga's bundled entry inside the app, when they're there.
fn bundled(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let resources = app.path().resource_dir().ok()?;
    let script = resources.join("daemon").join("dist").join("cli.js");
    let node = std::env::current_exe()
        .ok()?
        .parent()?
        .join(format!("{NODE_NAME}{}", std::env::consts::EXE_SUFFIX));
    (script.exists() && node.exists()).then_some((node, script))
}

/// Start the daemon and keep hold of it; wait until it's ready.
async fn start(app: &AppHandle, args: &[String]) -> Result<Endpoint, String> {
    let (mut cmd, own_pid) = base_command(app)?;
    cmd.arg("daemon").arg("--keep-alive").args(args);
    cmd.env("PATH", login_path().await);
    // Windows has no signal to ask it to finish: it stops cleanly once its input closes, when
    // this app quits or crashes (src/daemon/stop-on-input.ts).
    if cfg!(windows) {
        cmd.stdin(Stdio::piped());
        cmd.env("BELUGA_STOP_ON_INPUT_END", "1");
    } else {
        cmd.stdin(Stdio::null());
    }
    // No console window for it on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let log = log_file();
    let log_from = log
        .as_ref()
        .and_then(|f| f.metadata().ok())
        .map_or(0, |m| m.len());
    if let Some(f) = log {
        if let Ok(clone) = f.try_clone() {
            cmd.stdout(Stdio::from(clone));
        }
        cmd.stderr(Stdio::from(f));
    }
    let began = SystemTime::now();
    let child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start Beluga: {e}"))?;
    let pid = child.id();
    if let Some(state) = app.try_state::<AppState>() {
        *locked(&state.child) = Some(child);
    }
    // Only the daemon we just started counts: an old daemon.json must not satisfy the wait.
    let ours = |info: &Info| {
        if own_pid {
            info.pid == pid
        } else {
            std::fs::metadata(beluga_home().join("daemon.json"))
                .and_then(|m| m.modified())
                .is_ok_and(|t| t >= began)
        }
    };
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(status) = reap(app) {
            // Another Beluga may have won the start (only one daemon runs): use that one.
            if let Some(info) = up() {
                return Ok(info.into());
            }
            return Err(format!(
                "Beluga stopped while starting ({status}). See ~/.beluga/logs/daemon.log{}",
                log_tail(log_from)
            ));
        }
        if let Some(info) = up().filter(ours) {
            return Ok(info.into());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let child = app
        .try_state::<AppState>()
        .and_then(|state| locked(&state.child).take());
    if let Some(child) = child {
        terminate_child(child).await;
    }
    Err("Beluga didn't start in time. See ~/.beluga/logs/daemon.log".into())
}

/// Ask a daemon we started to finish: a signal, or on Windows closing its input.
fn ask_to_stop(child: &mut Child) {
    if cfg!(windows) {
        drop(child.stdin.take());
    } else {
        signal(child.id(), sig::TERM);
    }
}

/// Ask a daemon we started to quit; force it if it doesn't.
async fn terminate_child(mut child: Child) -> bool {
    ask_to_stop(&mut child);
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tauri::async_runtime::spawn_blocking(move || force(&mut child))
        .await
        .unwrap_or(false)
}

/// End a daemon we started that didn't stop when asked. On Windows, everything it started too
/// (its terminals, its Claudes): ending only the daemon there leaves them running.
fn force(child: &mut Child) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let root = std::env::var_os("SYSTEMROOT").unwrap_or_else(|| "C:\\Windows".into());
        let _ = Command::new(PathBuf::from(root).join("System32").join("taskkill.exe"))
            .args(tree_kill_args(child.id()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .status();
    }
    child.kill().is_ok() && child.wait().is_ok()
}

/// taskkill's words for "this process and all it started, now".
#[cfg_attr(not(windows), allow(dead_code))]
fn tree_kill_args(pid: u32) -> [String; 4] {
    ["/PID".into(), pid.to_string(), "/T".into(), "/F".into()]
}

/// Ask a daemon this app didn't start to quit; force it if it doesn't.
async fn terminate_pid(pid: u32) -> bool {
    if !signal(pid, sig::TERM) {
        return !alive(pid);
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    signal(pid, sig::KILL);
    for _ in 0..10 {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Stop whichever daemon runs, ours or another, and wait until it's gone.
async fn stop_running(app: &AppHandle) -> Result<(), String> {
    let child = app
        .try_state::<AppState>()
        .and_then(|state| locked(&state.child).take());
    if let Some(child) = child {
        terminate_child(child).await;
    }
    if let Some(info) = up() {
        if !terminate_pid(info.pid).await {
            return Err("Couldn't stop the Beluga that's running.".into());
        }
    }
    Ok(())
}

/// Stop the daemon before the Windows installer replaces the files it runs from (best effort:
/// the installer says so if something still holds them).
#[cfg(windows)]
pub async fn stop_for_update(app: &AppHandle) {
    let _ = stop_running(app).await;
}

/// Make sure Beluga runs, and say where it listens.
pub async fn ensure(app: &AppHandle, args: &[String]) -> Result<Endpoint, String> {
    let state = app.state::<AppState>();
    let _one_at_a_time = state.lock.lock().await;
    if let Some(info) = running(app) {
        let bundled = bundled_version(app);
        let old = outdated(info.version.as_deref(), info.keep_alive, bundled.as_deref());
        let left = !old && orphaned(info.keep_alive, parent_of(info.pid));
        if !old && !left {
            return Ok(info.into());
        }
        // After an update, or an app that's gone: the screens reconnect to the new one by themselves.
        if left {
            eprintln!(
                "beluga: replacing the Beluga a closed app left running (pid {})",
                info.pid
            );
        } else {
            eprintln!(
                "beluga: replacing Beluga {} with this app's {}",
                info.version.as_deref().unwrap_or("?"),
                bundled.as_deref().unwrap_or("?")
            );
        }
        stop_running(app).await?;
    }
    start(app, args).await
}

/// Start Beluga again with these arguments (a link to a friend's room): the running one stops first.
pub async fn restart(app: &AppHandle, args: &[String]) -> Result<Endpoint, String> {
    check_join(args)?;
    let state = app.state::<AppState>();
    let _one_at_a_time = state.lock.lock().await;
    stop_running(app).await?;
    start(app, args).await
}

/// Only joining a friend's room is allowed: `join <invite link>`.
fn check_join(args: &[String]) -> Result<(), String> {
    const PREFIXES: [&str; 7] = [
        "beluga://",
        "klaud://",
        "https://",
        "http://",
        "wss://",
        "ws://",
        "klaude:",
    ];
    let [verb, invite] = args else {
        return Err("That isn't something Beluga can start with.".into());
    };
    let plain = |c: char| c.is_ascii_alphanumeric() || "-._~:/?#=&%".contains(c);
    if verb != "join"
        || invite.len() > 2048
        || !PREFIXES.iter().any(|p| invite.starts_with(p))
        || !invite.chars().all(plain)
    {
        return Err("That doesn't look like a Beluga invite.".into());
    }
    Ok(())
}

/// Stop the daemon this app started (one started elsewhere is left alone).
pub fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(mut child) = locked(&state.child).take() else {
        return;
    };
    ask_to_stop(&mut child);
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    force(&mut child);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn accepts_the_join_flow() {
        let key = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1";
        for invite in [
            format!("klaud://{key}?relay=https%3A%2F%2Fcalm-river.trycloudflare.com#k3Jd-abc_123"),
            "https://calm-river.trycloudflare.com#k3Jd-abc_123".to_string(),
            "klaude:eyJ1cmwiOiJ3cyJ9".to_string(),
            format!("beluga://{key}?relay=https%3A%2F%2Fcalm-river.trycloudflare.com#k3Jd-abc_123"),
        ] {
            assert!(check_join(&args(&["join", &invite])).is_ok(), "{invite}");
        }
    }

    #[test]
    fn rejects_anything_else() {
        assert!(check_join(&args(&[])).is_err());
        assert!(check_join(&args(&["join"])).is_err());
        assert!(check_join(&args(&["daemon", "https://a.b#c"])).is_err());
        assert!(check_join(&args(&["join", "--home=/tmp"])).is_err());
        assert!(check_join(&args(&["join", "-x"])).is_err());
        assert!(check_join(&args(&["join", "https://a.b#c", "--flag"])).is_err());
        assert!(check_join(&args(&["join", "https://a.b#c d"])).is_err());
        assert!(check_join(&args(&["join", "https://a.b/;rm"])).is_err());
    }

    #[test]
    fn finds_the_path_between_the_markers() {
        let out = format!("welcome!\n{PATH_MARK}/usr/bin:/bin{PATH_MARK}");
        assert_eq!(parse_path(&out).as_deref(), Some("/usr/bin:/bin"));
        assert_eq!(parse_path("nothing here"), None);
        assert_eq!(parse_path(&format!("{PATH_MARK}/usr/bin")), None);
    }

    #[test]
    fn shell_path_comes_first_then_the_rest_once() {
        assert_eq!(
            merge_paths("/home/me/.nvm/bin:/usr/bin", "/usr/bin:/bin:"),
            "/home/me/.nvm/bin:/usr/bin:/bin"
        );
        assert_eq!(merge_paths("", "/usr/bin:/bin"), "/usr/bin:/bin");
    }

    #[test]
    fn replaces_only_a_kept_alive_daemon_of_another_version() {
        assert!(outdated(Some("0.4.0"), true, Some("0.5.0")));
        assert!(!outdated(Some("0.5.0"), true, Some("0.5.0")));
        // A daemon started by hand is left alone, whatever its version.
        assert!(!outdated(Some("0.4.0"), false, Some("0.5.0")));
        // Development (nothing bundled), or a daemon that doesn't say.
        assert!(!outdated(Some("0.4.0"), true, None));
        assert!(!outdated(None, true, Some("0.5.0")));
    }

    #[test]
    fn replaces_a_kept_alive_daemon_whose_app_is_gone() {
        assert!(orphaned(true, Some(1)));
        // Its app still runs, or we couldn't tell.
        assert!(!orphaned(true, Some(4730)));
        assert!(!orphaned(true, None));
        // A daemon started by hand stays, even under launchd.
        assert!(!orphaned(false, Some(1)));
        // Linux: your session's systemd takes orphans in.
        assert!(adopted(Some("systemd\n")));
        assert!(!adopted(Some("beluga\n")));
        assert!(!adopted(None));
    }

    #[cfg(unix)]
    #[test]
    fn tells_a_process_parent() {
        let me = std::process::id();
        assert_eq!(parent_of(me), Some(std::os::unix::process::parent_id()));
        assert_eq!(parent_of(u32::MAX), None);
    }

    #[test]
    fn reads_what_the_daemon_wrote() {
        let info: Info = serde_json::from_str(
            r#"{"pid":42,"port":5000,"token":"t","version":"0.4.0","ipc":3,"room":"r","keepAlive":true}"#,
        )
        .unwrap();
        assert_eq!(info.version.as_deref(), Some("0.4.0"));
        assert!(info.keep_alive);
        let old: Info = serde_json::from_str(r#"{"pid":42,"port":5000,"token":"t"}"#).unwrap();
        assert!(old.version.is_none() && !old.keep_alive);
    }

    #[test]
    fn forcing_on_windows_takes_what_the_daemon_started_too() {
        assert_eq!(tree_kill_args(4242), ["/PID", "4242", "/T", "/F"]);
    }

    #[test]
    fn never_signals_process_zero_or_one() {
        assert!(!signal(0, 0));
        assert!(!signal(1, 0));
    }

    #[test]
    fn home_follows_the_core() {
        let tmp = std::env::temp_dir().join(format!("beluga-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // A fresh Mac: ~/.beluga, even before it exists.
        assert_eq!(home_in(None, &tmp), tmp.join(".beluga"));
        // Before the core's first start moved it: the old ~/.klaud.
        std::fs::create_dir(tmp.join(".klaud")).unwrap();
        assert_eq!(home_in(None, &tmp), tmp.join(".klaud"));
        // Once ~/.beluga is there, always that.
        std::fs::create_dir(tmp.join(".beluga")).unwrap();
        assert_eq!(home_in(None, &tmp), tmp.join(".beluga"));
        // A home set in the environment wins.
        assert_eq!(
            home_in(Some(PathBuf::from("/x")), &tmp),
            PathBuf::from("/x")
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
