//! Drags that start in the window reach the page, as they would in a browser: a panel tab carried
//! to another group, an edge, or beside the chat (Dockview's HTML5 drag and drop).
//!
//! Tauri takes every drag over the window for its file drop (`onDragDropEvent`: a file or folder
//! from Finder, with its path) and tells WebKit it handled it, so WebKit never saw one: the page had
//! no dragover and no drop, and a tab let go over another group went nowhere. Here a drag whose
//! source is in this app goes to WebKit's own handling; one from elsewhere (Finder, another app)
//! still goes to Tauri, so dropping files keeps its paths.

use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{msg_send, sel};

/// The four methods of a drag's destination, as one class implements them.
#[derive(Clone, Copy)]
struct DragImps {
    entered: Imp,
    updated: Imp,
    perform: Imp,
    exited: Imp,
}

/// Tauri's (wry's) methods, for drags from elsewhere, and WebKit's own, for drags from here.
struct Routes {
    files: DragImps,
    page: DragImps,
}

static ROUTES: OnceLock<Routes> = OnceLock::new();

type OpFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;
type BoolFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool;
type VoidFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

/// The methods for this drag: WebKit's when it started in this app, Tauri's otherwise.
///
/// SAFETY: `info` is the NSDraggingInfo AppKit passed to the destination method.
unsafe fn route(info: *mut AnyObject) -> Option<DragImps> {
    let routes = ROUTES.get()?;
    if info.is_null() {
        return Some(routes.files);
    }
    // Nil for a drag from another app (Finder); the view it started in for one from this window.
    let source: *mut AnyObject = msg_send![info, draggingSource];
    Some(if source.is_null() {
        routes.files
    } else {
        routes.page
    })
}

unsafe extern "C-unwind" fn entered(this: *mut AnyObject, cmd: Sel, info: *mut AnyObject) -> usize {
    match route(info) {
        // SAFETY: both IMPs implement draggingEntered:, whose signature this is.
        Some(imps) => std::mem::transmute::<Imp, OpFn>(imps.entered)(this, cmd, info),
        None => 0,
    }
}

unsafe extern "C-unwind" fn updated(this: *mut AnyObject, cmd: Sel, info: *mut AnyObject) -> usize {
    match route(info) {
        // SAFETY: both IMPs implement draggingUpdated:, whose signature this is.
        Some(imps) => std::mem::transmute::<Imp, OpFn>(imps.updated)(this, cmd, info),
        None => 0,
    }
}

unsafe extern "C-unwind" fn perform(this: *mut AnyObject, cmd: Sel, info: *mut AnyObject) -> Bool {
    match route(info) {
        // SAFETY: both IMPs implement performDragOperation:, whose signature this is.
        Some(imps) => std::mem::transmute::<Imp, BoolFn>(imps.perform)(this, cmd, info),
        None => Bool::NO,
    }
}

unsafe extern "C-unwind" fn exited(this: *mut AnyObject, cmd: Sel, info: *mut AnyObject) {
    if let Some(imps) = route(info) {
        // SAFETY: both IMPs implement draggingExited:, whose signature this is.
        std::mem::transmute::<Imp, VoidFn>(imps.exited)(this, cmd, info);
    }
}

fn imps_of(class: &AnyClass) -> Option<DragImps> {
    let imp = |sel: Sel| class.instance_method(sel).map(|m| m.implementation());
    Some(DragImps {
        entered: imp(sel!(draggingEntered:))?,
        updated: imp(sel!(draggingUpdated:))?,
        perform: imp(sel!(performDragOperation:))?,
        exited: imp(sel!(draggingExited:))?,
    })
}

/// Route drags on the webviews of `webview`'s class (every Beluga window's), once.
///
/// SAFETY: `webview` is a live WKWebView (Tauri's `with_webview` gives it on the main thread).
pub unsafe fn install(webview: *mut AnyObject) {
    if webview.is_null() || ROUTES.get().is_some() {
        return;
    }
    let class = (*webview).class();
    let Some(kit) = AnyClass::get(c"WKWebView") else {
        return;
    };
    // A plain WKWebView (Tauri's file drop turned off): WebKit has the drags already.
    if std::ptr::eq(class, kit) {
        return;
    }
    let (Some(files), Some(page)) = (imps_of(class), imps_of(kit)) else {
        return;
    };
    if ROUTES.set(Routes { files, page }).is_err() {
        return;
    }
    let ours = [
        (
            sel!(draggingEntered:),
            std::mem::transmute::<OpFn, Imp>(entered),
        ),
        (
            sel!(draggingUpdated:),
            std::mem::transmute::<OpFn, Imp>(updated),
        ),
        (
            sel!(performDragOperation:),
            std::mem::transmute::<BoolFn, Imp>(perform),
        ),
        (
            sel!(draggingExited:),
            std::mem::transmute::<VoidFn, Imp>(exited),
        ),
    ];
    for (sel, imp) in ours {
        if let Some(method) = class.instance_method(sel) {
            method.set_implementation(imp);
        }
    }
}
