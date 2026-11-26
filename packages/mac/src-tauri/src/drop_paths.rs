//! Where dropped files are, on Windows.
//!
//! Tauri's file drop is off on Windows (tauri.windows.conf.json: `dragDropEnabled: false`): it
//! replaces WebView2's own drop target with one that only takes files, so the page never saw a
//! drag of its own and a panel tab let go over another group went nowhere (Dockview's HTML5 drag
//! and drop; drag_inside.rs is the Mac's answer to the same thing). Without it the page gets the
//! drop, as a browser would, but a page's files carry no path. So the page hands the files it was
//! given back here (`chrome.webview.postMessageWithAdditionalObjects`, src/lib/file-drop.ts), and
//! WebView2 says where each one is.

use serde::Serialize;
use tauri::{Emitter, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
    ICoreWebView2WebMessageReceivedEventArgs2,
};
use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
use windows_core::{Interface, PWSTR};

/// What the page hears back: its own number for the drop, and the paths in the order it gave the files.
#[derive(Clone, Serialize)]
struct Dropped {
    id: u64,
    paths: Vec<String>,
}

/// The page's number for a drop, from its message (`beluga-drop:7`); nothing for any other message.
///
/// The message is a string because Tauri's own handler for the page's messages comes first and
/// fails on anything else, and WebView2 then calls no handler after it. Tauri doesn't know this
/// one, so it writes one line to the page's console for it; nothing else comes of that.
fn drop_id(message: &str) -> Option<u64> {
    message.strip_prefix("beluga-drop:")?.parse().ok()
}

/// The paths of the files that came with the message (folders too), in order.
///
/// SAFETY: `args` is the live argument of a WebMessageReceived event, on the webview's thread.
unsafe fn paths_of(
    args: &ICoreWebView2WebMessageReceivedEventArgs,
) -> windows_core::Result<Vec<String>> {
    let objects = args
        .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?
        .AdditionalObjects()?;
    let mut count = 0u32;
    objects.Count(&mut count)?;
    let mut paths = Vec::new();
    for index in 0..count {
        let Ok(file) = objects
            .GetValueAtIndex(index)
            .and_then(|object| object.cast::<ICoreWebView2File>())
        else {
            continue;
        };
        let mut path = PWSTR::null();
        if file.Path(&mut path).is_ok() {
            let path = take_pwstr(path);
            if !path.is_empty() {
                paths.push(path);
            }
        }
    }
    Ok(paths)
}

/// Answer the window's page when it asks where its dropped files are.
pub fn install(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.with_webview(move |webview| {
        // SAFETY: with_webview runs this on the main thread with the window's live WebView2.
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
            return;
        };
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut message = PWSTR::null();
            // SAFETY: `args` is this event's own, and the string is freed by take_pwstr.
            if unsafe { args.TryGetWebMessageAsString(&mut message) }.is_err() {
                return Ok(());
            }
            let Some(id) = drop_id(&take_pwstr(message)) else {
                return Ok(());
            };
            // SAFETY: as above.
            let paths = unsafe { paths_of(&args) }.unwrap_or_default();
            let _ = target.emit_to(target.label(), "file-drop-paths", Dropped { id, paths });
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: `core` is live; the handler stays for the webview's life.
        let _ = unsafe { core.add_WebMessageReceived(&handler, &mut token) };
    });
}

#[cfg(test)]
mod tests {
    use super::drop_id;

    #[test]
    fn reads_only_its_own_message() {
        assert_eq!(drop_id("beluga-drop:7"), Some(7));
        assert_eq!(drop_id("beluga-drop:"), None);
        assert_eq!(drop_id("beluga-drop:x"), None);
        assert_eq!(drop_id(r#"{"cmd":"x"}"#), None);
        assert_eq!(drop_id("__WEBVIEW_CREATED__"), None);
    }
}
