//! The call on the sharer's own screen (BLG-717). While you share your screen and you're in
//! another app, a see-through window covers that screen: a soft frame that says it's on show, the
//! others' sketches, pointers and clicks where they made them, and what they write in the chat,
//! bottom right. Clicks and keys go straight through it to the app under it.
//!
//! The window decides what it shows (it hands over the whole state, or none to hide it); this side
//! only owns the window: which screen it covers (or, sharing one window, that window: BLG-743), that
//! it floats over everything, that it never takes the mouse, and that it asks macOS to leave it out
//! of screen captures.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::shared_window::{self, Rect};

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "call-overlay";

/// What the overlay shows now; where the shared window was last found; where the overlay is.
#[derive(Debug, Default)]
pub struct CallOverlayState {
    state: Mutex<Option<serde_json::Value>>,
    found: Mutex<Option<Found>>,
    /// Over a shared window (its place), or over a whole screen (None).
    over: Mutex<Option<Rect>>,
}

/// The shared window as last looked up: for a picture this size, at this time.
#[derive(Debug, Clone, Copy)]
struct Found {
    at: Instant,
    width: f64,
    height: f64,
    rect: Option<Rect>,
}

/// How long a lookup holds (the overlay is updated many times a second while someone draws).
const LOOK_EVERY: Duration = Duration::from_millis(400);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The shared window's place, looked up again when the last look is old or the picture changed size.
fn shared_window_at<R: Runtime>(
    app: &AppHandle<R>,
    width: f64,
    height: f64,
    label: Option<&str>,
) -> Option<Rect> {
    let s = app.try_state::<CallOverlayState>()?;
    let mut found = lock(&s.found);
    if let Some(f) = *found {
        if f.width == width && f.height == height && f.at.elapsed() < LOOK_EVERY {
            return f.rect;
        }
    }
    let monitors = app.available_monitors().unwrap_or_default();
    let scale_at = |r: &Rect| {
        let (cx, cy) = (r.x + r.width / 2.0, r.y + r.height / 2.0);
        monitors
            .iter()
            .find(|m| {
                let scale = m.scale_factor();
                let pos = m.position().to_logical::<f64>(scale);
                let size = m.size().to_logical::<f64>(scale);
                cx >= pos.x && cx < pos.x + size.width && cy >= pos.y && cy < pos.y + size.height
            })
            .map_or(2.0, tauri::Monitor::scale_factor)
    };
    let rect = shared_window::pick(&shared_window::windows(), width, height, label, scale_at);
    *found = Some(Found {
        at: Instant::now(),
        width,
        height,
        rect,
    });
    rect
}

/// The screen whose size (in pixels) is closest to the shared picture's; else the main one.
fn screen_for<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) -> Option<tauri::Monitor> {
    let monitors = app.available_monitors().ok()?;
    monitors
        .into_iter()
        .min_by(|a, b| {
            let d = |m: &tauri::Monitor| {
                let s = m.size();
                (f64::from(s.width) - width).abs() + (f64::from(s.height) - height).abs()
            };
            d(a).total_cmp(&d(b))
        })
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn place<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) {
    let (Some(window), Some(m)) = (
        app.get_webview_window(LABEL),
        screen_for(app, width, height),
    ) else {
        return;
    };
    let scale = m.scale_factor();
    let pos = m.position().to_logical::<f64>(scale);
    let size = m.size().to_logical::<f64>(scale);
    let _ = window.set_position(LogicalPosition::new(pos.x, pos.y));
    let _ = window.set_size(LogicalSize::new(size.width, size.height));
}

fn ensure<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<bool> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(false);
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title("Beluga")
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
        .focusable(false)
        .visible(false);
    let window = crate::menu::without_menu_bar(app, builder).build()?;
    // The mouse and keyboard go through to whatever is under it.
    let _ = window.set_ignore_cursor_events(true);
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = app.run_on_main_thread(move || {
            crate::popup::float_over_everything(&w);
            leave_out_of_captures(&w);
        });
    }
    crate::menu::drop_menu_bar(&window);
    Ok(true)
}

/// `NSWindowSharingNone`: macOS leaves the window out of screenshots and screen captures, so
/// the others don't get their own ink back in the picture.
#[cfg(target_os = "macos")]
pub(crate) fn leave_out_of_captures<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let Ok(ptr) = window.ns_window() else {
        return;
    };
    let ns = ptr.cast::<AnyObject>();
    if ns.is_null() {
        return;
    }
    // SAFETY: `ns` is this window's live NSWindow, and this runs on the main thread.
    unsafe {
        let _: () = msg_send![ns, setSharingType: 0usize];
    }
}

/// Show the overlay with this state over what's being shared (`width`×`height` pixels; `surface`
/// "window" for one window, titled `label`), or hide it (`None`). Over one window, the overlay
/// covers that window and follows it; when it can't be found, only the chat shows.
#[tauri::command]
pub fn set_call_overlay(
    app: AppHandle,
    state: Option<serde_json::Value>,
    width: f64,
    height: f64,
    surface: Option<String>,
    label: Option<String>,
) {
    let window_share = surface.as_deref() == Some("window");
    let over = if window_share && state.is_some() {
        shared_window_at(&app, width, height, label.as_deref())
    } else {
        None
    };
    let state = state.map(|mut st| {
        // One window, not found: nothing can be put where it was made.
        if window_share && over.is_none() {
            if let Some(o) = st.as_object_mut() {
                o.remove("ink");
                o.insert("frame".into(), serde_json::Value::Bool(false));
            }
        }
        st
    });
    let Some(s) = app.try_state::<CallOverlayState>() else {
        return;
    };
    *lock(&s.state) = state.clone();
    let Some(state) = state else {
        *lock(&s.over) = None;
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = app.emit_to(LABEL, "call-overlay", serde_json::Value::Null);
            let _ = w.hide();
        }
        return;
    };
    let Ok(made) = ensure(&app) else {
        return;
    };
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    let hidden = made || !w.is_visible().unwrap_or(false);
    let mut was = lock(&s.over);
    match over {
        // Over the shared window, wherever it went since.
        Some(r) if hidden || *was != Some(r) => {
            let _ = w.set_position(LogicalPosition::new(r.x, r.y));
            let _ = w.set_size(LogicalSize::new(r.width, r.height));
            *was = Some(r);
        }
        // A whole screen (or a window not found): the screen.
        None if hidden || was.is_some() => {
            place(&app, width, height);
            *was = None;
        }
        _ => {}
    }
    drop(was);
    let _ = app.emit_to(LABEL, "call-overlay", &state);
    if hidden {
        let _ = w.show();
    }
}

/// What the overlay shows now (asked once it has loaded).
#[tauri::command]
pub fn call_overlay_state(app: AppHandle) -> Option<serde_json::Value> {
    app.try_state::<CallOverlayState>()
        .and_then(|s| lock(&s.state).clone())
}
