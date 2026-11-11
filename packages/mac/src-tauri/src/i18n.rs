//! The language of what the app shell draws itself: the menu bar and the menu-bar (tray) menu.
//! The window picks the language (Settings › General › Language, src/i18n in the web view) and
//! tells the shell with `set_ui_language`; the shell keeps it in a file so the next launch builds
//! its menus in that language from the start. The words come from the window's own catalog
//! (src/i18n/zh-CN.json), keyed by the English text, so there is one place to translate.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use tauri::menu::{Menu, MenuItemKind};
use tauri::{AppHandle, Manager, Runtime};

const ZH_CN: &str = include_str!("../../src/i18n/zh-CN.json");

static CATALOG: RwLock<Option<HashMap<String, String>>> = RwLock::new(None);
static LOCALE: RwLock<String> = RwLock::new(String::new());

fn use_locale(locale: &str) {
    let catalog = match locale {
        "zh-CN" => serde_json::from_str::<HashMap<String, String>>(ZH_CN).ok(),
        _ => None,
    };
    if let Ok(mut c) = CATALOG.write() {
        *c = catalog;
    }
    if let Ok(mut l) = LOCALE.write() {
        *l = locale.to_string();
    }
}

/// `text` in the window's language (itself when English, or when the catalog doesn't have it).
pub fn tr(text: &str) -> String {
    let key = text.replace('&', "");
    CATALOG
        .read()
        .ok()
        .and_then(|c| c.as_ref().and_then(|m| m.get(&key).cloned()))
        .unwrap_or_else(|| text.to_string())
}

/// A template ("{0} Requests Waiting for You") filled in after it's translated.
pub fn tr_fmt(template: &str, args: &[&str]) -> String {
    let mut out = tr(template);
    for (i, a) in args.iter().enumerate() {
        out = out.replace(&format!("{{{i}}}"), a);
    }
    out
}

fn saved_at<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("ui-language"))
}

/// At launch, before the menus are built: the language the window last asked for.
pub fn load<R: Runtime>(app: &AppHandle<R>) {
    let saved = saved_at(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    use_locale(&saved);
}

/// Every item's words in the current language, submenus included.
pub fn localize_items<R: Runtime>(items: Vec<MenuItemKind<R>>) {
    for it in items {
        match it {
            MenuItemKind::MenuItem(i) => {
                if let Ok(t) = i.text() {
                    let _ = i.set_text(tr(&t));
                }
            }
            MenuItemKind::Check(i) => {
                if let Ok(t) = i.text() {
                    let _ = i.set_text(tr(&t));
                }
            }
            MenuItemKind::Predefined(i) => {
                if let Ok(t) = i.text() {
                    if !t.is_empty() {
                        let _ = i.set_text(tr(&t));
                    }
                }
            }
            MenuItemKind::Submenu(s) => {
                if let Ok(t) = s.text() {
                    let _ = s.set_text(tr(&t));
                }
                if let Ok(inner) = s.items() {
                    localize_items(inner);
                }
            }
            MenuItemKind::Icon(i) => {
                if let Ok(t) = i.text() {
                    let _ = i.set_text(tr(&t));
                }
            }
        }
    }
}

/// The menu bar, built and in the current language (lib.rs's `.menu(…)`).
pub fn menu_bar<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = crate::menu::build(app)?;
    if let Ok(items) = menu.items() {
        localize_items(items);
    }
    Ok(menu)
}

/// The window chose a language ("en", "zh-CN"): keep it, and redraw the menu bar and the
/// menu-bar (tray) menu in it. Errs when it can't be kept for next time or a menu can't be redrawn,
/// so the window knows the native side isn't in step.
#[tauri::command]
pub fn set_ui_language(app: AppHandle, locale: String) -> Result<(), String> {
    // Nothing saved yet (a first launch) built the menus in English already: no redraw for "en".
    let same = LOCALE
        .read()
        .map(|l| *l == locale || (l.is_empty() && locale == "en"))
        .unwrap_or(false);
    let mut problems: Vec<String> = Vec::new();
    match saved_at(&app) {
        Some(p) => {
            if let Some(dir) = p.parent() {
                if let Err(e) = std::fs::create_dir_all(dir) {
                    problems.push(format!("can't make {}: {e}", dir.display()));
                }
            }
            if let Err(e) = std::fs::write(&p, &locale) {
                problems.push(format!("can't save the language to {}: {e}", p.display()));
            }
        }
        None => problems.push("no app config folder to save the language in".into()),
    }
    if !same {
        use_locale(&locale);
        // The old menu bar comes off the window without a word from GTK (menu::clear_keys); the
        // window gives the new one your keys again as it reloads.
        #[cfg(target_os = "linux")]
        if let Some(Ok(items)) = app.menu().map(|m| m.items()) {
            crate::menu::clear_keys(items);
        }
        match menu_bar(&app).and_then(|menu| app.set_menu(menu).map(|_| ())) {
            Ok(()) => {}
            Err(e) => problems.push(format!("can't redraw the menu bar: {e}")),
        }
        crate::requests::rebuild(&app);
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}
