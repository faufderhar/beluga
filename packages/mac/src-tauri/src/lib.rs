//! Beluga's native shell around the web view: macOS first, and Linux and Windows (what only a
//! Mac has, such as vibrancy, the Dock, Focus and widgets, is left out there).
//!
//! The app owns only what the operating system is for: the window (vibrancy, traffic lights),
//! the menu bar, the tray, notifications, `beluga://` (and the older `klaud://`) links, and
//! keeping Beluga's daemon running. Everything Beluga does happens in the daemon.

mod daemon;
mod export;
mod focus;
mod i18n;
mod menu;
mod call_float;
mod call_overlay;
mod shared_window;
mod popup;
#[cfg(target_os = "macos")]
mod power;
mod privacy;
mod quit;
mod rename;
mod requests;
mod sounds;
mod spout;
mod update_rules;
mod updater;
mod widgets;

use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;

/// What the app keeps track of while it runs.
pub struct AppState {
    /// Held while Beluga is started or restarted, so two requests never start two daemons.
    pub lock: tokio::sync::Mutex<()>,
    /// The daemon this app started (it stops it on quit), if any.
    pub child: Mutex<Option<Child>>,
    /// Links that arrived before the window was listening.
    pub pending_links: Mutex<Vec<String>>,
    /// Whether the window has asked for those links yet.
    pub links_taken: AtomicBool,
}

#[tauri::command]
async fn daemon_endpoint(app: tauri::AppHandle) -> Result<daemon::Endpoint, String> {
    daemon::ensure(&app, &[]).await
}

/// Start Beluga again with these arguments (joining a friend's room from a link): the current
/// room is left first. Only `["join", "<invite link>"]` is accepted.
#[tauri::command]
async fn restart_daemon(
    app: tauri::AppHandle,
    args: Vec<String>,
) -> Result<daemon::Endpoint, String> {
    daemon::restart(&app, &args).await
}

/// The beluga:// (and klaud://) links that opened the app before the window was ready to hear about them
/// (handed over once).
#[tauri::command]
fn take_pending_links(state: tauri::State<'_, AppState>) -> Vec<String> {
    state.links_taken.store(true, Ordering::SeqCst);
    std::mem::take(&mut *daemon::locked(&state.pending_links))
}

/// The window's blur behind the sidebar, on or off (Settings › Appearance › Reduce transparency, BLG-409).
/// Off, the content is solid and macOS has no blur to keep redrawing. macOS's own Reduce transparency
/// makes the blur solid by itself.
#[cfg(target_os = "macos")]
fn window_vibrancy(window: &tauri::WebviewWindow, on: bool) {
    use window_vibrancy::{
        apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
    };
    if on {
        let _ = apply_vibrancy(
            window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        );
    } else {
        let _ = clear_vibrancy(window);
    }
}

#[tauri::command]
fn set_vibrancy(app: tauri::AppHandle, on: bool) {
    #[cfg(target_os = "macos")]
    if let Some(window) = app.get_webview_window("main") {
        let _ = app.run_on_main_thread(move || window_vibrancy(&window, on));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, on);
}

/// Grey out menu-bar items that can't run right now, check toggles, rename Run/Stop Running.
#[tauri::command]
fn set_menu_state(
    app: tauri::AppHandle,
    enabled: HashMap<String, bool>,
    checked: HashMap<String, bool>,
    labels: HashMap<String, String>,
) {
    if let Some(m) = app.menu() {
        menu::apply_state(
            &m,
            &menu::MenuState {
                enabled,
                checked,
                labels,
            },
        );
    }
}

/// Give menu-bar items your keys (Settings › Keyboard): an accelerator each, or none.
#[tauri::command]
fn set_menu_keys(app: tauri::AppHandle, keys: HashMap<String, Option<String>>) {
    if let Some(m) = app.menu() {
        menu::apply_keys(&m, &keys);
    }
}

/// What the menu-bar icon and the Dock icon say: how many things are new for you (unread
/// notifications and what waits on you), and how many Claudes are working. `title` is what the
/// menu bar shows beside the whale (Settings › Menu Bar picks it; "" shows nothing); without
/// one, the count of what's new.
#[tauri::command]
fn set_tray_status(
    app: tauri::AppHandle,
    waiting: u32,
    working: u32,
    unread: Option<u32>,
    title: Option<String>,
) {
    let unread = unread.unwrap_or(waiting);
    if let Some(tray) = app.tray_by_id("beluga") {
        let title = title.unwrap_or_else(|| {
            if unread > 0 {
                unread.to_string()
            } else {
                String::new()
            }
        });
        let _ = tray.set_title((!title.is_empty()).then_some(title));
        let _ = tray.set_tooltip(Some(tray_tip(waiting, working, unread)));
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count((unread > 0).then_some(i64::from(unread)));
    }
}

/// Your Beluga network status in the menu-bar menu (`None`: the network is off, no status items).
#[tauri::command]
fn set_tray_presence(app: tauri::AppHandle, presence: Option<menu::TrayPresence>) {
    requests::set_presence(&app, presence);
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
}

/// Seconds since you last used the keyboard, mouse or trackpad anywhere on the Mac (for Away
/// when idle); `None` where the system can't say.
#[tauri::command]
fn system_idle_seconds() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        // The combined session state (0) and any input event (all bits set): what macOS itself
        // uses for idle time. SAFETY: a pure query with plain-number arguments.
        let secs = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
        secs.is_finite().then_some(secs)
    }
    // Windows: the last input anywhere in this session, against the time since it started (both
    // wrap after 49 days, together). SAFETY: a struct of the size the call is told, and a pure query.
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::GetTickCount;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return None;
        }
        let ms = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
        Some(f64::from(ms) / 1000.0)
    }
    // Linux: X11 and Wayland each keep it to themselves; nothing reliable to ask.
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

/// "Beluga · 2 waiting for you · 3 new · 1 Claude working", leaving out what's zero.
fn tray_tip(waiting: u32, working: u32, unread: u32) -> String {
    let mut parts = vec!["Beluga".to_string()];
    if waiting > 0 {
        parts.push(format!("{waiting} waiting for you"));
    }
    let news = unread.saturating_sub(waiting);
    if news > 0 {
        parts.push(format!("{news} new"));
    }
    if working > 0 {
        parts.push(format!(
            "{working} Claude{} working",
            if working == 1 { "" } else { "s" }
        ));
    }
    parts.join(" · ")
}

/// Beluga to the front with its window: the app itself first (it may be hidden with ⌘H, and a
/// hidden app's window can't take focus), then the window.
fn focus_main(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The window to the front, asked by Beluga ("Open on your Mac" from the phone).
#[tauri::command]
fn focus_window(app: tauri::AppHandle) {
    focus_main(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The quiet relaunch after an update installed while you were away: no window, no focus.
    let background = updater::launched_in_background();
    // The update from Klaud lands in Klaud.app: it becomes Beluga.app and starts from there.
    let bundle = updater::bundle_path();
    if rename::move_bundle(bundle.as_deref(), &updater::kept_env()) {
        return;
    }
    let mut context = tauri::generate_context!();
    // Klaud's settings, window place and localStorage, before anything reads them.
    rename::migrate_data(&context.config().identifier, bundle.is_some());
    if background {
        for w in &mut context.config_mut().app.windows {
            w.visible = false;
        }
    }
    // Whether the window shows comes from the config (hidden only for the background relaunch),
    // never from the last run: quitting hides it first (quit.rs), so that would always say hidden.
    let window_state = tauri_plugin_window_state::StateFlags::all()
        - tauri_plugin_window_state::StateFlags::VISIBLE;
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(!background);
    let app = builder
        // A beluga:// link opened while Beluga runs is passed on to the link handler below.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state)
                // The request pop-up places itself (and is never restored visible).
                .with_denylist(&[popup::LABEL, call_float::LABEL, call_overlay::LABEL])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(quit::Quitting::default())
        .manage(updater::Updates::default())
        .manage(requests::TrayState::default())
        .manage(popup::PopupState::default())
        .manage(call_float::CallFloatState::default())
        .manage(call_overlay::CallOverlayState::default())
        .manage(AppState {
            lock: tokio::sync::Mutex::new(()),
            child: Mutex::new(None),
            pending_links: Mutex::new(Vec::new()),
            links_taken: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            daemon_endpoint,
            restart_daemon,
            set_menu_state,
            set_vibrancy,
            set_menu_keys,
            set_tray_status,
            set_tray_presence,
            requests::set_tray_requests,
            spout::set_tray_spout,
            spout::play_tray_spout,
            popup::set_request_popup,
            popup::request_popup_state,
            popup::request_popup_resize,
            popup::request_popup_dismiss,
            popup::request_popup_action,
            call_float::set_call_float,
            call_float::call_float_state,
            call_float::call_float_action,
            call_float::call_float_resize,
            call_float::call_float_drag,
            call_float::call_float_pointer,
            call_overlay::set_call_overlay,
            call_overlay::call_overlay_state,
            system_idle_seconds,
            take_pending_links,
            focus_window,
            export::save_export,
            sounds::sound_install,
            sounds::sound_prune,
            sounds::sound_play_system,
            sounds::notification_access,
            sounds::open_notification_settings,
            sounds::open_focus_settings,
            privacy::privacy_access,
            privacy::privacy_request,
            updater::update_state,
            updater::update_check,
            updater::update_set_mode,
            updater::update_choose,
            updater::update_activity,
            updater::update_dismiss_news,
            i18n::set_ui_language
        ])
        .menu(|app| {
            // The language the window last chose (src/i18n.rs), before the menus are built.
            i18n::load(app);
            i18n::menu_bar(app)
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "check-updates" => updater::check_from_menu(app),
            id => menu::on_event(app, id),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                window_vibrancy(&window, true);
            }
            menu::tray(&handle)?;
            spout::start(&handle);
            // The desktop widgets redraw when the boards' tiles change (BLG-309).
            widgets::start(&handle);
            // About to sleep: the daemon mails what friends haven't taken first (BLG-277).
            #[cfg(target_os = "macos")]
            power::watch();
            // Banners (and their sound) even while Beluga is in front.
            sounds::present_in_front();
            // A friend's request on a notification: Review… / Approve / Always Allow / Decline.
            requests::register_actions(&handle)?;
            // Clicking a notification brings the window back and tells it where to go.
            let taps = handle.clone();
            app.notification().on_action(move |performed| {
                if requests::on_notification(&taps, performed) {
                    return;
                }
                if performed.action_id() != "tap" {
                    return;
                }
                focus_main(&taps);
                let channel = performed
                    .notification()
                    .and_then(|n| n.extra().get("channel"))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                let _ = taps.emit("notification-tap", channel);
            })?;
            // beluga:// and klaud:// links: join a friend's room.
            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    focus_main(&links);
                    // Until the window has asked, keep the link for it: it can't hear us yet.
                    if let Some(state) = links.try_state::<AppState>() {
                        if !state.links_taken.load(Ordering::SeqCst) {
                            daemon::locked(&state.pending_links).push(url.to_string());
                        }
                    }
                    let _ = links.emit("deep-link", url.to_string());
                }
            });
            // On Windows and Linux a link that starts Beluga comes as an argument, read before the
            // handler above was there: keep it for the window too. An AppImage registers itself.
            #[cfg(not(target_os = "macos"))]
            {
                if std::env::var_os("APPIMAGE").is_some() {
                    let _ = app.deep_link().register_all();
                }
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let state = app.state::<AppState>();
                    daemon::locked(&state.pending_links).extend(urls.iter().map(|u| u.to_string()));
                }
            }
            // Start Beluga's daemon right away, so the window has something to show.
            tauri::async_runtime::spawn(async move {
                let _ = daemon::ensure(&handle, &[]).await;
            });
            updater::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Beluga (and your room) running in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(context)
        .expect("Beluga couldn't start");

    app.run(|app, event| match event {
        // Clicking the Dock icon brings the window back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => focus_main(app),
        // Quitting leaves the room (unless this app didn't start Beluga; it's left running then),
        // then puts a downloaded update in place. However it began, it ends: if a step hangs,
        // the watchdog ends Beluga itself (quit.rs, #426).
        RunEvent::Exit => {
            quit::guard(app);
            quit::at(app, quit::Stage::StoppingEngine);
            daemon::stop(app);
            updater::on_exit(app);
            quit::at(app, quit::Stage::Leaving);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::tray_tip;

    #[test]
    fn the_tray_tip_says_only_what_is_there() {
        assert_eq!(tray_tip(0, 0, 0), "Beluga");
        assert_eq!(tray_tip(2, 0, 2), "Beluga · 2 waiting for you");
        assert_eq!(
            tray_tip(1, 2, 4),
            "Beluga · 1 waiting for you · 3 new · 2 Claudes working"
        );
        assert_eq!(tray_tip(0, 1, 0), "Beluga · 1 Claude working");
    }
}
