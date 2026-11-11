//! Quitting Beluga for good (#426). The menu's Quit Beluga and the tray's do the same thing here:
//! Beluga leaves the screen at once, then stops the daemon it started, puts a downloaded update
//! in place and exits (lib.rs, `RunEvent::Exit`). Closing the window only hides it.
//!
//! All of that runs on the window's thread, and any step can hang (the engine, Windows tearing
//! the web view down), which left Beluga running until Task Manager ended it. So a watchdog
//! waits beside it: past the deadline it notes where quitting stuck (with the black box's
//! incidents) and ends the process itself.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager, Runtime};

/// How long quitting gets: the daemon's own stop (3 s, then forced) fits well inside.
const DEADLINE: Duration = Duration::from_secs(12);
/// Putting a downloaded update in place gets longer: cut short, it could leave half an app.
const INSTALL_DEADLINE: Duration = Duration::from_secs(120);
/// How often the watchdog looks.
const TICK: Duration = Duration::from_millis(100);

/// Where quitting is, for the note if it sticks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Stage {
    /// Asked; the window's event loop is winding down.
    Asked = 0,
    /// Stopping the daemon this app started.
    StoppingEngine = 1,
    /// Putting a downloaded update in place.
    InstallingUpdate = 2,
    /// Everything done; the process is ending.
    Leaving = 3,
}

impl Stage {
    fn from_u8(n: u8) -> Self {
        match n {
            1 => Stage::StoppingEngine,
            2 => Stage::InstallingUpdate,
            3 => Stage::Leaving,
            _ => Stage::Asked,
        }
    }

    fn words(self) -> &'static str {
        match self {
            Stage::Asked => "closing the window",
            Stage::StoppingEngine => "stopping the engine",
            Stage::InstallingUpdate => "installing the update",
            Stage::Leaving => "ending the process",
        }
    }

    /// How long quitting may take while here.
    fn deadline(self) -> Duration {
        if self == Stage::InstallingUpdate {
            INSTALL_DEADLINE
        } else {
            DEADLINE
        }
    }
}

/// Whether quitting has begun, and where it is.
#[derive(Default)]
pub struct Quitting {
    begun: AtomicBool,
    stage: AtomicU8,
}

impl Quitting {
    /// True the first time only: a second Quit while the first is under way adds nothing.
    fn begin(&self) -> bool {
        !self.begun.swap(true, Ordering::SeqCst)
    }

    fn set(&self, stage: Stage) {
        self.stage.store(stage as u8, Ordering::SeqCst);
    }

    fn stage(&self) -> Stage {
        Stage::from_u8(self.stage.load(Ordering::SeqCst))
    }
}

/// Quit Beluga (the menu's Quit Beluga, the tray's): gone from the screen now, ended for sure.
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    if !guard(app) {
        return;
    }
    // Stopping the engine can take a few seconds: nothing of Beluga stays on screen meanwhile.
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
    if let Some(tray) = app.tray_by_id("beluga") {
        let _ = tray.set_visible(false);
    }
    app.exit(0);
}

/// Start the watchdog for this exit, once (`false` only when a quit is already under way).
/// Every way out goes through here, the update's relaunch and the system's logout too, so none
/// of them can hang.
pub fn guard<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(state) = app.try_state::<Quitting>() else {
        return true;
    };
    if !state.begin() {
        return false;
    }
    let app = app.clone();
    let started = Instant::now();
    std::thread::spawn(move || {
        let state = app.state::<Quitting>();
        watch(
            started,
            Stage::deadline,
            || state.stage(),
            |stage| {
                note_stuck(stage, started.elapsed());
                end_now();
            },
        );
    });
    true
}

/// Say where quitting is now.
pub fn at<R: Runtime>(app: &AppHandle<R>, stage: Stage) {
    if let Some(state) = app.try_state::<Quitting>() {
        state.set(stage);
    }
}

/// Wait while quitting is within its deadline (by the stage it's at); past it, `force`.
fn watch(
    started: Instant,
    deadline: impl Fn(Stage) -> Duration,
    stage: impl Fn() -> Stage,
    force: impl FnOnce(Stage),
) {
    loop {
        let now = stage();
        if started.elapsed() >= deadline(now) {
            force(now);
            return;
        }
        std::thread::sleep(TICK);
    }
}

/// What a stuck quit leaves with the incidents (src/core/blackbox/report.ts shows its reason).
fn stuck_note(stage: Stage, took: Duration, at: u128) -> serde_json::Value {
    serde_json::json!({
        "kind": "quit",
        "at": at,
        "stage": stage.words(),
        "reason": format!(
            "Quitting Beluga stuck while {} ({} s): Beluga ended itself",
            stage.words(),
            took.as_secs()
        ),
    })
}

fn note_stuck(stage: Stage, took: Duration) {
    eprintln!("beluga: quitting stuck while {}; ending now", stage.words());
    let dir = crate::daemon::beluga_home().join("logs").join("incidents");
    let at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    if std::fs::create_dir_all(&dir).is_ok() {
        let note = stuck_note(stage, took, at);
        let _ = std::fs::write(dir.join(format!("{at}-quit.json")), note.to_string());
    }
}

/// End this process now, without the teardown that hung (on Windows the daemon then stops by
/// itself: its input closes with us, src/daemon/stop-on-input.ts).
fn end_now() -> ! {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
        // SAFETY: the current process's pseudo-handle needs no closing; this doesn't return.
        unsafe {
            TerminateProcess(GetCurrentProcess(), 0);
        }
    }
    #[cfg(unix)]
    {
        // SAFETY: _exit(2) ends the process at once, skipping the handlers that may have hung.
        unsafe { libc::_exit(0) }
    }
    #[allow(unreachable_code)]
    std::process::exit(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU8;
    use std::sync::{mpsc, Arc};

    #[test]
    fn quitting_begins_once() {
        let q = Quitting::default();
        assert!(q.begin());
        assert!(!q.begin());
    }

    #[test]
    fn says_where_it_is() {
        let q = Quitting::default();
        assert_eq!(q.stage(), Stage::Asked);
        q.set(Stage::StoppingEngine);
        assert_eq!(q.stage(), Stage::StoppingEngine);
        q.set(Stage::InstallingUpdate);
        assert_eq!(q.stage(), Stage::InstallingUpdate);
        q.set(Stage::Leaving);
        assert_eq!(q.stage(), Stage::Leaving);
    }

    #[test]
    fn an_update_going_in_gets_longer() {
        assert_eq!(Stage::Asked.deadline(), DEADLINE);
        assert_eq!(Stage::StoppingEngine.deadline(), DEADLINE);
        // Once the update is in (or failed), the short deadline again.
        assert_eq!(Stage::Leaving.deadline(), DEADLINE);
        assert!(Stage::InstallingUpdate.deadline() > DEADLINE);
        // The daemon's stop (3 s, then forced) must finish well before the watchdog steps in.
        assert!(DEADLINE >= Duration::from_secs(10));
    }

    /// The report: Quit asked, then the exit hung. The watchdog ends it, and says where.
    #[test]
    fn a_stuck_quit_is_ended() {
        let (tx, rx) = mpsc::channel();
        let started = Instant::now();
        std::thread::spawn(move || {
            watch(
                started,
                |_| Duration::from_millis(150),
                || Stage::StoppingEngine,
                move |stage| tx.send((stage, started.elapsed())).unwrap(),
            );
        });
        let (stage, after) = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the watchdog never ended a stuck quit");
        assert_eq!(stage, Stage::StoppingEngine);
        assert!(after >= Duration::from_millis(150));
    }

    #[test]
    fn an_update_going_in_is_not_cut_short() {
        let stage = Arc::new(AtomicU8::new(Stage::InstallingUpdate as u8));
        let seen = stage.clone();
        let (tx, rx) = mpsc::channel();
        let started = Instant::now();
        std::thread::spawn(move || {
            watch(
                started,
                |s| match s {
                    Stage::InstallingUpdate => Duration::from_secs(60),
                    _ => Duration::from_millis(100),
                },
                move || Stage::from_u8(seen.load(Ordering::SeqCst)),
                move |s| tx.send(s).unwrap(),
            );
        });
        // Well past the short deadline, still installing: left alone.
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
        // Installed, still not gone: ended.
        stage.store(Stage::StoppingEngine as u8, Ordering::SeqCst);
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            Stage::StoppingEngine
        );
    }

    #[test]
    fn the_note_says_where_it_stuck() {
        let note = stuck_note(Stage::StoppingEngine, Duration::from_secs(12), 7);
        assert_eq!(note["kind"], "quit");
        assert_eq!(note["at"], 7);
        assert_eq!(
            note["reason"],
            "Quitting Beluga stuck while stopping the engine (12 s): Beluga ended itself"
        );
    }
}
