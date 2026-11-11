//! A friend's request, on top of whatever you're doing: a small card in the top-right corner of
//! the screen ("Mia's Claude wants to take a screenshot of your desktop") with See more, Allow,
//! Allow Always and Decline. It floats above other apps without taking the keyboard from them.
//!
//! The window decides what's shown (it knows the requests) and what each answer means; this side
//! only owns the floating window, hands it the requests, and passes its buttons back to the
//! window as the same "notification-request" a notification's buttons send.

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "request-popup";
/// The card's width, and how far it stays from the screen's edge and the menu bar.
const WIDTH: f64 = 392.0;
const MARGIN: f64 = 12.0;
const MENU_BAR: f64 = 30.0;
const MIN_HEIGHT: f64 = 96.0;
const MAX_HEIGHT: f64 = 640.0;

/// What the pop-up shows (the window's requests, as it sent them) and the ones you closed.
#[derive(Debug, Default)]
pub struct PopupState(pub Mutex<PopupModel>);

#[derive(Debug, Default)]
pub struct PopupModel {
    pub requests: Vec<serde_json::Value>,
    /// The card's last height (it says when it changes), kept for the next time it shows.
    pub height: Option<f64>,
    /// Approvals whose pop-up you closed with ×: it stays away until something new comes.
    pub dismissed: HashSet<String>,
}

fn approval_of(r: &serde_json::Value) -> Option<String> {
    r.get("approval")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
}

/// The requests still worth showing: not closed, and only ids the window knows now.
pub fn visible(model: &PopupModel) -> Vec<serde_json::Value> {
    model
        .requests
        .iter()
        .filter(|r| approval_of(r).is_some_and(|id| !model.dismissed.contains(&id)))
        .cloned()
        .collect()
}

fn place<R: Runtime>(app: &AppHandle<R>, height: f64) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let _ = window.set_size(LogicalSize::new(WIDTH, height));
    // The screen you're on (the one with the pointer), else Beluga's, else the main one.
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| {
            app.get_webview_window("main")
                .and_then(|m| m.current_monitor().ok().flatten())
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let pos = m.position().to_logical::<f64>(scale);
        let size = m.size().to_logical::<f64>(scale);
        let _ = window.set_position(LogicalPosition::new(
            pos.x + size.width - WIDTH - MARGIN,
            pos.y + MENU_BAR + MARGIN,
        ));
    }
}

fn ensure<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("popup.html".into()))
        .title("Beluga")
        .inner_size(WIDTH, 160.0)
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
        // Never the key window: clicks reach its buttons, keystrokes stay with the app you're in.
        .focusable(false)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);
    let window = crate::menu::without_menu_bar(app, builder).build()?;
    #[cfg(target_os = "macos")]
    {
        let w = window.clone();
        let _ = app.run_on_main_thread(move || float_over_everything(&w));
    }
    // Windows and Linux give every new window the app's menu bar: not this small card.
    crate::menu::drop_menu_bar(&window);
    Ok(())
}

/// `NSWindowCollectionBehavior`: on every Space, the full-screen ones too, staying put when Spaces
/// change and out of ⌘` cycling.
#[cfg(target_os = "macos")]
const FLOAT_BEHAVIOR: usize = (1 << 0) /* canJoinAllSpaces */
    | (1 << 4) /* stationary */
    | (1 << 6) /* ignoresCycle */
    | (1 << 8) /* fullScreenAuxiliary */;
/// `NSPopUpMenuWindowLevel` (kCGPopUpMenuWindowLevel): above other apps' windows, a full-screen
/// video's Space included, and above Beluga's own.
#[cfg(target_os = "macos")]
const FLOAT_LEVEL: isize = 101;

/// The card shows wherever you are: over another app's full-screen Space (a video, a game),
/// with Beluga hidden or in the Dock, and it never hides when Beluga isn't the active app. It
/// still never takes the keyboard (the window isn't focusable). Needs no macOS permission.
#[cfg(target_os = "macos")]
pub(crate) fn float_over_everything<R: Runtime>(window: &tauri::WebviewWindow<R>) {
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
        let _: () = msg_send![ns, setCollectionBehavior: FLOAT_BEHAVIOR];
        let _: () = msg_send![ns, setLevel: FLOAT_LEVEL];
        let _: () = msg_send![ns, setHidesOnDeactivate: false];
        let _: () = msg_send![ns, setCanHide: false];
    }
}

/// Show what's left to show (or hide the card when nothing is).
fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<PopupState>() else {
        return;
    };
    let (shown, height) = {
        let model = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (visible(&model), model.height.unwrap_or(160.0))
    };
    if shown.is_empty() {
        if let Some(w) = app.get_webview_window(LABEL) {
            // Empty first, so old cards never flash when it shows again.
            let _ = app.emit_to(LABEL, "request-popup", &shown);
            let _ = w.hide();
        }
        return;
    }
    if ensure(app).is_err() {
        return;
    }
    let _ = app.emit_to(LABEL, "request-popup", &shown);
    if let Some(w) = app.get_webview_window(LABEL) {
        if !w.is_visible().unwrap_or(false) {
            place(app, height);
            // Shown without taking the keyboard: whatever you were typing in keeps it.
            let _ = w.show();
        }
    }
}

/// The friends' requests waiting for you changed (the window sends all of them, newest first;
/// an empty list hides the card).
#[tauri::command]
pub fn set_request_popup(app: AppHandle, requests: Vec<serde_json::Value>) {
    if let Some(state) = app.try_state::<PopupState>() {
        let mut model = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Forget closed ones that were answered, so the set doesn't grow. An empty list may only
        // mean Do Not Disturb: what you closed stays closed when it ends.
        if !requests.is_empty() {
            let ids: HashSet<String> = requests.iter().filter_map(approval_of).collect();
            model.dismissed.retain(|id| ids.contains(id));
        }
        model.requests = requests;
    }
    refresh(&app);
}

/// What the card shows now (asked once it has loaded).
#[tauri::command]
pub fn request_popup_state(app: AppHandle) -> Vec<serde_json::Value> {
    app.try_state::<PopupState>()
        .map(|s| {
            visible(
                &s.0.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            )
        })
        .unwrap_or_default()
}

/// The card's content changed height.
#[tauri::command]
pub fn request_popup_resize(app: AppHandle, height: f64) {
    if let Some(state) = app.try_state::<PopupState>() {
        state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .height = Some(height);
    }
    place(&app, height);
}

/// × on the card: these requests stay waiting (in Beluga, the menu bar) without the card.
#[tauri::command]
pub fn request_popup_dismiss(app: AppHandle, approvals: Vec<String>) {
    if let Some(state) = app.try_state::<PopupState>() {
        state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .dismissed
            .extend(approvals);
    }
    refresh(&app);
}

/// A button on the card: the window answers it, as it does a notification's.
#[tauri::command]
pub fn request_popup_action(
    app: AppHandle,
    action: String,
    approval: Option<String>,
    task: Option<String>,
) -> Result<(), String> {
    let action = match action.as_str() {
        "review" | "approve" | "always" | "allow_always" | "decline" => action,
        _ => return Err(format!("Unknown action {action}")),
    };
    if action == "review" {
        crate::focus_main(&app);
    }
    app.emit_to(
        "main",
        "notification-request",
        serde_json::json!({ "action": action, "approval": approval, "task": task }),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_requests_stay_away_until_something_new_comes() {
        let mut model = PopupModel {
            height: None,
            requests: vec![
                serde_json::json!({ "approval": "a1" }),
                serde_json::json!({ "approval": "a2" }),
                serde_json::json!({ "nothing": true }),
            ],
            dismissed: HashSet::new(),
        };
        assert_eq!(visible(&model).len(), 2);
        model.dismissed.insert("a1".into());
        let shown = visible(&model);
        assert_eq!(shown.len(), 1);
        assert_eq!(approval_of(&shown[0]).as_deref(), Some("a2"));
    }
}
