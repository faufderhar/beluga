//! The floating call card (BLG-706): while Beluga isn't the app you're in, the call you're in (or
//! one ringing for you) floats over everything, small, at the top of the screen: who's talking,
//! mute and leave, or join and decline. While you share, it says so and stops it, and you can hide
//! it for that share (the frame around your screen stays). Back in Beluga it goes away; the call
//! lives in its chat.
//!
//! The window decides what the card shows (it hands over the whole state, or none to hide it);
//! this side only owns the floating window, and passes its buttons back to the window. A click on
//! the card never brings Beluga forward (BLG-743): its buttons work while you stay in your app.
//! The card says how wide it is (it grows when you point at it and shrinks to a pill of faces when
//! you don't), and you can drag it where you like: it comes back there, after a restart too.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "call-float";
/// The window before the card says how wide it is, and the most and least it may be.
const WIDTH: f64 = 392.0;
const MIN_WIDTH: f64 = 60.0;
const MAX_WIDTH: f64 = 520.0;
/// The card (56) and see-through room around it for its shadow: a shadow cut off at the window's
/// edge shows as a faint rectangle (call/callfloat.module.css keeps the same room).
const HEIGHT: f64 = 90.0;
const MENU_BAR: f64 = 30.0;
const MARGIN: f64 = 2.0;

/// What the card shows now (kept for when it loads), how wide it is, and where you put it.
#[derive(Debug, Default)]
pub struct CallFloatState {
    state: Mutex<Option<serde_json::Value>>,
    width: Mutex<Option<f64>>,
    /// Where you left it (the middle of its top edge, in points), read from disk the first time.
    spot: Mutex<Option<Option<Spot>>>,
    /// You dragged it since Beluga started: where it moves to from now on is yours to keep.
    dragged: AtomicBool,
    /// Bumped on each move: only the last one in a short while is written down.
    moves: AtomicU64,
}

/// Where the card sits: the middle of its top edge, in points on the whole desktop.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
struct Spot {
    x: f64,
    y: f64,
}

fn spot_file() -> PathBuf {
    crate::daemon::beluga_home().join("call-float.json")
}

/// Where you left the card (from disk, once), if you ever moved it.
fn spot_of<R: Runtime>(app: &AppHandle<R>) -> Option<Spot> {
    let s = app.try_state::<CallFloatState>()?;
    let mut spot = s
        .spot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *spot.get_or_insert_with(|| {
        std::fs::read_to_string(spot_file())
            .ok()
            .and_then(|t| serde_json::from_str::<Spot>(&t).ok())
            .filter(|p| p.x.is_finite() && p.y.is_finite())
    })
}

/// The card moved. Once you've dragged it, that's where it lives: kept now, written down a
/// moment after it stops moving.
fn moved_to<R: Runtime>(app: &AppHandle<R>, window: &tauri::WebviewWindow<R>) {
    let Some(s) = app.try_state::<CallFloatState>() else {
        return;
    };
    if !s.dragged.load(Ordering::Relaxed) {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    let spot = Spot {
        x: pos.x + size.width / 2.0,
        y: pos.y,
    };
    *s.spot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Some(spot));
    let this = s.moves.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        let latest = app
            .try_state::<CallFloatState>()
            .is_some_and(|s| s.moves.load(Ordering::Relaxed) == this);
        if latest {
            if let Ok(text) = serde_json::to_string(&spot) {
                let _ = std::fs::write(spot_file(), text);
            }
        }
    });
}

fn width_of<R: Runtime>(app: &AppHandle<R>) -> f64 {
    app.try_state::<CallFloatState>()
        .and_then(|s| {
            *s.width
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        })
        .unwrap_or(WIDTH)
}

fn place<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let width = width_of(app);
    let _ = window.set_size(LogicalSize::new(width, HEIGHT));
    // Where you left it, while that spot is still on a screen.
    if let Some(spot) = spot_of(app) {
        let on_screen = app.available_monitors().ok().is_some_and(|ms| {
            ms.iter().any(|m| {
                let scale = m.scale_factor();
                let pos = m.position().to_logical::<f64>(scale);
                let size = m.size().to_logical::<f64>(scale);
                spot.x >= pos.x
                    && spot.x < pos.x + size.width
                    && spot.y >= pos.y
                    && spot.y < pos.y + size.height - HEIGHT / 2.0
            })
        });
        if on_screen {
            let _ = window.set_position(LogicalPosition::new(spot.x - width / 2.0, spot.y));
            return;
        }
    }
    // Top middle of the screen Beluga is on (else the main one), just under the menu bar.
    let monitor = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let pos = m.position().to_logical::<f64>(scale);
        let size = m.size().to_logical::<f64>(scale);
        let _ = window.set_position(LogicalPosition::new(
            pos.x + (size.width - width) / 2.0,
            pos.y + MENU_BAR + MARGIN,
        ));
    }
}

fn ensure<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<bool> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(false);
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("call.html".into()))
        .title("Beluga call")
        .inner_size(width_of(app), HEIGHT)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .closable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        // Never the key window: you keep typing in the app you're in while you talk.
        .focusable(false)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);
    let window = crate::menu::without_menu_bar(app, builder).build()?;
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = app.run_on_main_thread(move || {
            crate::popup::float_over_everything(&w);
            never_activate(&w);
            // Sharing your whole screen, the card stays yours: the others don't see it.
            crate::call_overlay::leave_out_of_captures(&w);
        });
    }
    crate::menu::drop_menu_bar(&window);
    let handle = app.clone();
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Moved(_) = e {
            if let Some(w) = handle.get_webview_window(LABEL) {
                moved_to(&handle, &w);
            }
        }
    });
    Ok(true)
}

/// A click on the card leaves Beluga where it was. Without this, the click makes Beluga the
/// active app, its window takes focus, the card hides (call/float.ts) and the button never gets
/// the click. AppKit's own switch for this (what a non-activating panel uses), where it exists.
#[cfg(target_os = "macos")]
fn never_activate<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2::runtime::{AnyObject, Bool, Sel};
    use objc2::{msg_send, sel};
    let Ok(ptr) = window.ns_window() else {
        return;
    };
    let ns = ptr.cast::<AnyObject>();
    if ns.is_null() {
        return;
    }
    let prevent: Sel = sel!(_setPreventsActivation:);
    // SAFETY: `ns` is this window's live NSWindow, this runs on the main thread, and the private
    // method is only called once the window says it has it.
    unsafe {
        let has: Bool = msg_send![ns, respondsToSelector: prevent];
        if has.as_bool() {
            let _: () = msg_send![ns, _setPreventsActivation: Bool::YES];
        }
    }
}

/// Show the card with this state, or hide it (`None`).
#[tauri::command]
pub fn set_call_float(app: AppHandle, state: Option<serde_json::Value>) {
    if let Some(s) = app.try_state::<CallFloatState>() {
        *s.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = state.clone();
    }
    let Some(state) = state else {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = app.emit_to(LABEL, "call-float", serde_json::Value::Null);
            let _ = w.hide();
        }
        return;
    };
    let Ok(made) = ensure(&app) else {
        return;
    };
    let _ = app.emit_to(LABEL, "call-float", &state);
    if let Some(w) = app.get_webview_window(LABEL) {
        if made || !w.is_visible().unwrap_or(false) {
            place(&app);
            let _ = w.show();
        }
    }
}

/// What the card shows now (asked once it has loaded).
#[tauri::command]
pub fn call_float_state(app: AppHandle) -> Option<serde_json::Value> {
    app.try_state::<CallFloatState>().and_then(|s| {
        s.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    })
}

/// The card's width changed (its words did, or it grew or shrank): the window fits it, around the
/// same middle.
#[tauri::command]
pub fn call_float_resize(app: AppHandle, width: f64) {
    if !width.is_finite() {
        return;
    }
    let width = width.clamp(MIN_WIDTH, MAX_WIDTH);
    let Some(s) = app.try_state::<CallFloatState>() else {
        return;
    };
    let before = {
        let mut w = s
            .width
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = w.unwrap_or(WIDTH);
        *w = Some(width);
        before
    };
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    if (before - width).abs() < 0.5 {
        return;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    if let Ok(pos) = window.outer_position() {
        let pos = pos.to_logical::<f64>(scale);
        let _ = window.set_position(LogicalPosition::new(pos.x + (before - width) / 2.0, pos.y));
    }
    let _ = window.set_size(LogicalSize::new(width, HEIGHT));
}

/// You're dragging the card: macOS moves it with the pointer, and it stays where you leave it.
#[tauri::command]
pub fn call_float_drag(app: AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    if let Some(s) = app.try_state::<CallFloatState>() {
        s.dragged.store(true, Ordering::Relaxed);
    }
    let _ = window.start_dragging();
}

/// Where the pointer is over the card's window (points from its top-left), or nothing when it's
/// off it. The card's window is never the key one, so it asks rather than waiting for the mouse
/// to be reported to it.
#[tauri::command]
pub fn call_float_pointer(app: AppHandle) -> Option<[f64; 2]> {
    let window = app.get_webview_window(LABEL)?;
    let cursor = app.cursor_position().ok()?;
    let pos = window.inner_position().ok()?;
    let size = window.inner_size().ok()?;
    let x = cursor.x - f64::from(pos.x);
    let y = cursor.y - f64::from(pos.y);
    if x < 0.0 || y < 0.0 || x > f64::from(size.width) || y > f64::from(size.height) {
        return None;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    Some([x / scale, y / scale])
}

/// A button on the card: the window does it (Open and Join also bring Beluga forward).
#[tauri::command]
pub fn call_float_action(
    app: AppHandle,
    action: String,
    conversation: String,
) -> Result<(), String> {
    if !matches!(
        action.as_str(),
        "mute" | "unmute" | "leave" | "join" | "decline" | "open" | "stop-sharing" | "hide"
    ) {
        return Err(format!("Unknown action {action}"));
    }
    if action == "open" || action == "join" {
        crate::focus_main(&app);
    }
    app.emit_to(
        "main",
        "call-float-action",
        serde_json::json!({ "action": action, "conversation": conversation }),
    )
    .map_err(|e| e.to_string())
}
