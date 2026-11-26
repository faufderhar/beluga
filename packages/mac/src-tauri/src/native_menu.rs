//! The app's menus as the Mac's own (packages/mac/src/lib/native-menu.ts): a right-click menu, a
//! button's pull-down, a pop-up button's choices.
//!
//! Built here as an NSMenu rather than through Tauri's menu API, for what that API doesn't give:
//! a second line under an item (macOS 14.4's subtitle), section headers (macOS 14), icons drawn
//! as template images (so the system tints them, white on the highlight and in dark mode), and a
//! pop-up button's menu opened with the chosen item over the button. The menu is shown on the main
//! thread and waits there while it's open, as every Mac menu does; what was picked comes back as
//! the item's id, and the page runs it.

use serde::Deserialize;

/// One row of a menu, as the page sends it. Only the Mac builds the menu from it: elsewhere
/// the command says no without reading a field.
#[derive(Debug, Deserialize)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(rename_all = "camelCase")]
pub struct NativeItem {
    /// "item" (the default), "separator" or "header".
    #[serde(default)]
    kind: Option<String>,
    /// What comes back when it's picked.
    #[serde(default)]
    id: Option<i64>,
    #[serde(default)]
    text: String,
    /// The line under it (macOS 14.4 and later; earlier, a tooltip).
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    checked: Option<bool>,
    /// A shortcut shown on the right: its key ("c", "\r", an arrow's character)…
    #[serde(default)]
    key: Option<String>,
    /// …and its modifiers: 1 ⌘, 2 ⇧, 4 ⌥, 8 ⌃.
    #[serde(default)]
    modifiers: Option<u32>,
    /// A PNG, drawn 16 pt.
    #[serde(default)]
    icon: Option<Vec<u8>>,
    /// The icon is a shape the system tints (true), or has colours of its own (false).
    #[serde(default)]
    template: Option<bool>,
    #[serde(default)]
    items: Option<Vec<NativeItem>>,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::NativeItem;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{define_class, msg_send, sel, AnyThread, ClassType, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSControlStateValueOn, NSEvent, NSEventModifierFlags, NSImage, NSMenu, NSMenuItem, NSScreen, NSView};
    use objc2_foundation::{NSData, NSPoint, NSSize, NSString};
    use std::cell::Cell;

    thread_local! {
        static PICKED: Cell<Option<i64>> = const { Cell::new(None) };
    }

    define_class!(
        /// Each item's target: notes which one was picked.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "BelugaNativeMenuTarget"]
        struct Target;

        impl Target {
            #[unsafe(method(pick:))]
            fn pick(&self, sender: &NSMenuItem) {
                PICKED.with(|p| p.set(Some(sender.tag() as i64)));
            }
        }
    );

    impl Target {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            unsafe { msg_send![Self::alloc(mtm), init] }
        }
    }

    fn responds(obj: &AnyObject, selector: objc2::runtime::Sel) -> bool {
        unsafe { msg_send![obj, respondsToSelector: selector] }
    }

    fn image(png: &[u8], template: bool) -> Option<Retained<NSImage>> {
        let data = NSData::with_bytes(png);
        let image = NSImage::initWithData(NSImage::alloc(), &data)?;
        image.setSize(NSSize::new(16.0, 16.0));
        image.setTemplate(template);
        Some(image)
    }

    fn build(items: &[NativeItem], target: &Target, mtm: MainThreadMarker) -> Retained<NSMenu> {
        let menu = NSMenu::new(mtm);
        // Enabled is what the page says, not what the responder chain finds.
        menu.setAutoenablesItems(false);
        let headers = responds(NSMenuItem::class().as_ref(), sel!(sectionHeaderWithTitle:));
        for item in items {
            match item.kind.as_deref() {
                Some("separator") => {
                    let line = NSMenuItem::separatorItem(mtm);
                    // Only the rows that do something carry an id (0 up): the rest -1, so
                    // itemWithTag never finds a header or a line for the chosen row.
                    line.setTag(-1);
                    menu.addItem(&line);
                }
                Some("header") => {
                    let title = NSString::from_str(&item.text);
                    let row = if headers {
                        NSMenuItem::sectionHeaderWithTitle(&title, mtm)
                    } else {
                        let row = NSMenuItem::new(mtm);
                        row.setTitle(&title);
                        row.setEnabled(false);
                        row
                    };
                    row.setTag(-1);
                    menu.addItem(&row);
                }
                _ => menu.addItem(&row(item, target, mtm)),
            }
        }
        menu
    }

    fn row(item: &NativeItem, target: &Target, mtm: MainThreadMarker) -> Retained<NSMenuItem> {
        let row = NSMenuItem::new(mtm);
        row.setTag(-1);
        row.setTitle(&NSString::from_str(&item.text));
        row.setEnabled(item.enabled.unwrap_or(true));
        if item.checked == Some(true) {
            row.setState(NSControlStateValueOn);
        }
        if let Some(subtitle) = item.subtitle.as_deref().filter(|s| !s.is_empty()) {
            let text = NSString::from_str(subtitle);
            if responds(row.as_ref(), sel!(setSubtitle:)) {
                row.setSubtitle(Some(&text));
            } else {
                row.setToolTip(Some(&text));
            }
        }
        if let (Some(key), Some(modifiers)) = (item.key.as_deref(), item.modifiers) {
            row.setKeyEquivalent(&NSString::from_str(key));
            let mut flags = NSEventModifierFlags::empty();
            if modifiers & 1 != 0 {
                flags |= NSEventModifierFlags::Command;
            }
            if modifiers & 2 != 0 {
                flags |= NSEventModifierFlags::Shift;
            }
            if modifiers & 4 != 0 {
                flags |= NSEventModifierFlags::Option;
            }
            if modifiers & 8 != 0 {
                flags |= NSEventModifierFlags::Control;
            }
            row.setKeyEquivalentModifierMask(flags);
        }
        if let Some(png) = item.icon.as_deref() {
            row.setImage(image(png, item.template.unwrap_or(true)).as_deref());
        }
        if let Some(children) = item.items.as_deref() {
            row.setSubmenu(Some(&build(children, target, mtm)));
        } else if let Some(id) = item.id {
            row.setTag(id as isize);
            unsafe {
                row.setTarget(Some(target));
                row.setAction(Some(sel!(pick:)));
            }
        }
        row
    }

    /// Shows the menu and waits until it closes: the picked item's id, if one was.
    ///
    /// `at` is in the window's points from its top-left; with `selected`, that item is put there
    /// (a pop-up button: its chosen value over the button), else the menu's top-left corner is.
    /// Without `at`, the menu opens at the pointer. `above` is the y (same points) of the button's
    /// top edge, for a pull-down that doesn't fit below it: it then opens above the button.
    ///
    /// A menu is never squeezed into a scrolling one while the screen has room for all of it:
    /// AppKit only scrolls a menu that runs off the screen, so one that wouldn't fit where it
    /// opens is moved first (up over the pointer, above its button, or as far as it needs).
    pub fn show(view: *mut std::ffi::c_void, items: &[NativeItem], at: Option<(f64, f64)>, selected: Option<i64>, above: Option<f64>) -> Option<i64> {
        let mtm = MainThreadMarker::new()?;
        let target = Target::new(mtm);
        let menu = build(items, &target, mtm);
        PICKED.with(|p| p.set(None));
        let mut positioning = selected.and_then(|id| menu.itemWithTag(id as isize));
        // SAFETY: the window's own content view, alive while its window is.
        let view: Option<&NSView> = unsafe { view.cast::<NSView>().as_ref() };
        // Where it opens, in screen points (y up), and the edge it can flip above.
        let (point, flip) = match (view, at) {
            (Some(view), Some((x, y))) => {
                let to_screen = |y: f64| -> Option<NSPoint> {
                    let height = view.frame().size.height;
                    let local = if view.isFlipped() { NSPoint::new(x, y) } else { NSPoint::new(x, height - y) };
                    let window = view.window()?;
                    Some(window.convertPointToScreen(view.convertPoint_toView(local, None)))
                };
                match to_screen(y) {
                    Some(point) => (point, above.and_then(to_screen).map(|p| p.y)),
                    None => (NSEvent::mouseLocation(), None),
                }
            }
            _ => {
                let point = NSEvent::mouseLocation();
                // At the pointer, a menu that doesn't fit below opens upward from it, as a Mac's
                // context menu does.
                (point, Some(point.y))
            }
        };
        let room = screen_room(point, mtm);
        let height = menu.size().height;
        let top = match (room, positioning.as_deref()) {
            (None, _) => None,
            (Some((low, high)), Some(item)) => {
                // Where the chosen row puts the menu's top: rows taken as alike, which is close
                // enough to tell whether it would run off the screen.
                let count = menu.numberOfItems().max(1) as f64;
                let row = height / count;
                let top = point.y + (menu.indexOfItem(item).max(0) as f64 + 1.0) * row;
                if top <= high && top - height >= low {
                    None
                } else {
                    positioning = None;
                    Some(fit(top, height, low, high))
                }
            }
            (Some((low, high)), None) => {
                if point.y - height >= low {
                    None
                } else {
                    let top = flip.map(|edge| edge + height).unwrap_or(point.y);
                    Some(fit(top, height, low, high))
                }
            }
        };
        let point = top.map(|y| NSPoint::new(point.x, y)).unwrap_or(point);
        menu.popUpMenuPositioningItem_atLocation_inView(positioning.as_deref(), point, None);
        // The item's action runs before the menu returns: read what it noted.
        let picked = PICKED.with(|p| p.take());
        drop(target);
        picked
    }

    /// The bottom and top (screen points) of the visible part of the screen the point is on.
    fn screen_room(point: NSPoint, mtm: MainThreadMarker) -> Option<(f64, f64)> {
        let screens = NSScreen::screens(mtm);
        let on = screens.iter().find(|s| {
            let f = s.frame();
            point.x >= f.origin.x && point.x <= f.origin.x + f.size.width && point.y >= f.origin.y && point.y <= f.origin.y + f.size.height
        });
        let screen = on.or_else(|| NSScreen::mainScreen(mtm))?;
        let v = screen.visibleFrame();
        Some((v.origin.y, v.origin.y + v.size.height))
    }

    /// The menu's top moved as little as it takes for all of it to be on the screen; only a menu
    /// taller than the screen still starts at the top and scrolls.
    fn fit(top: f64, height: f64, low: f64, high: f64) -> f64 {
        top.max(low + height).min(high)
    }
}

/// Shows a menu built from `items` (see `NativeItem`) and returns the id of the item picked.
#[tauri::command]
pub async fn native_menu(window: tauri::Window, items: Vec<NativeItem>, x: Option<f64>, y: Option<f64>, selected: Option<i64>, above: Option<f64>) -> Result<Option<i64>, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let at = x.zip(y);
        let on = window.clone();
        window
            .run_on_main_thread(move || {
                // The view's pointer, read here on the main thread, where it's used.
                let picked = on.ns_view().ok().and_then(|view| mac::show(view, &items, at, selected, above));
                let _ = tx.send(picked);
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, items, x, y, selected, above);
        Err("native menus are the Mac's".into())
    }
}
