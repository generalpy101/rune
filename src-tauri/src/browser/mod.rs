//! Embedded browser panes: native child webviews (WKWebView / WebView2 /
//! WebKitGTK) placed inside the main window over a placeholder rectangle that
//! React measures. Each pane owns at most one webview, labelled
//! `browser-<pane id>`; React creates it when the pane becomes visible and
//! closes it when the pane is hidden or removed, so hidden pages hold no RAM.
//!
//! These webviews load untrusted remote pages. They never reach Rune's
//! commands: `lib.rs` rejects every app command whose caller is not the
//! `main` webview, capabilities are scoped to the `main` webview, and
//! [`deliver_channel_payload`] keeps channel data (PTY output, AI streams) out
//! of Tauri's app-global fetch queue that any webview could drain. Large command
//! responses on platforms that fall back to postMessage may still use that
//! queue in Tauri 2.11.2; keep this in mind when upgrading Tauri.

pub mod cookies;
pub mod import;

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::{CallbackFn, InvokeResponseBody};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview,
    WebviewBuilder, WebviewUrl, Window,
};

/// Label of Rune's own UI webview — the only webview allowed to invoke commands.
pub const MAIN_WEBVIEW: &str = "main";
const LABEL_PREFIX: &str = "browser-";
/// Temporary webview used to reach the browser data store when no pane is open.
const STORE_LABEL: &str = "browser-store";
/// Fixed WKWebsiteDataStore id so browser site data stays out of Rune's UI
/// store (macOS 14+; older macOS falls back to the default store).
const DATA_STORE_ID: [u8; 16] = *b"rune-browser-v1!";
/// Id of the macOS menu item that replaces "Close Window" (see `app_menu`).
pub const CLOSE_PANE_MENU_ID: &str = "rune-close-pane";
/// Bumped each time Rune's UI (re)loads, so a `browser_open` that started
/// under the previous page can't leave an orphaned webview behind.
static UI_GENERATION: AtomicU64 = AtomicU64::new(0);

fn label(pane: u32) -> String {
    format!("{LABEL_PREFIX}{pane}")
}

/// Accept only absolute http(s) URLs for embedded browsing.
pub fn parse_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("Invalid URL: {e}"))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        "http" | "https" => Err("URL has no host".into()),
        s => Err(format!(
            "Only http and https pages can open in Rune (got {s}:)"
        )),
    }
}

/// Navigations a page may perform inside the pane. Sub-frames legitimately use
/// `about:`/`data:`/`blob:`; everything else (file:, app schemes, custom
/// protocols) is refused and surfaced so the user can open it externally.
fn allowed_in_pane(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "data" | "blob")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserEvent {
    pane: u32,
    /// `loading` | `loaded` | `title` | `blocked` | `download`
    kind: &'static str,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

fn emit<R: Runtime>(app: &AppHandle<R>, ev: BrowserEvent) {
    // Only Rune's UI listens; never broadcast page state to other webviews.
    let _ = app.emit_to(MAIN_WEBVIEW, "browser-event", ev);
}

/// Logical (CSS px) rectangle relative to the window's content area.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Bounds {
    /// Bounds arrive in Rune-UI coordinates (CSS px from the UI webview's
    /// top-left) while child frames are relative to the window's content
    /// view. Offset by where the UI webview really sits, so the page lands
    /// exactly on its placeholder and never over the pane's toolbar.
    fn rect<R: Runtime>(self, app: &AppHandle<R>) -> tauri::Rect {
        let (dx, dy) = app
            .get_webview(MAIN_WEBVIEW)
            .and_then(|ui| {
                let scale = ui.window().scale_factor().ok()?;
                let p = ui.position().ok()?.to_logical::<f64>(scale);
                Some((p.x, p.y))
            })
            .unwrap_or((0.0, 0.0));
        tauri::Rect {
            position: LogicalPosition::new(self.x + dx, self.y + dy).into(),
            size: LogicalSize::new(self.width.max(1.0), self.height.max(1.0)).into(),
        }
    }
}

fn builder<R: Runtime>(
    app: &AppHandle<R>,
    label: String,
    url: Url,
    pane: u32,
) -> WebviewBuilder<R> {
    let mut b =
        WebviewBuilder::new(label, WebviewUrl::External(url)).data_store_identifier(DATA_STORE_ID);
    if let Ok(dir) = app.path().app_local_data_dir() {
        // WebView2 / WebKitGTK: a separate profile directory from Rune's UI.
        b = b.data_directory(dir.join("browser"));
    }
    let nav_app = app.clone();
    let win_app = app.clone();
    let dl_app = app.clone();
    let load_app = app.clone();
    let title_app = app.clone();
    b.on_navigation(move |url| {
        let ok = allowed_in_pane(url);
        if !ok {
            emit(
                &nav_app,
                BrowserEvent {
                    pane,
                    kind: "blocked",
                    url: url.to_string(),
                    title: None,
                },
            );
        }
        ok
    })
    .on_new_window(move |url, _| {
        // target=_blank / window.open: keep it in this pane rather than
        // spawning an unmanaged window.
        if parse_url(url.as_str()).is_ok() {
            let app = win_app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(wv) = app.get_webview(&self::label(pane)) {
                    let _ = wv.navigate(url);
                }
            });
        } else {
            emit(
                &win_app,
                BrowserEvent {
                    pane,
                    kind: "blocked",
                    url: url.to_string(),
                    title: None,
                },
            );
        }
        NewWindowResponse::Deny
    })
    .on_download(move |_, ev| {
        if let DownloadEvent::Requested { url, .. } = ev {
            emit(
                &dl_app,
                BrowserEvent {
                    pane,
                    kind: "download",
                    url: url.to_string(),
                    title: None,
                },
            );
        }
        false
    })
    .on_page_load(move |_, payload| {
        let kind = match payload.event() {
            PageLoadEvent::Started => "loading",
            PageLoadEvent::Finished => "loaded",
        };
        emit(
            &load_app,
            BrowserEvent {
                pane,
                kind,
                url: payload.url().to_string(),
                title: None,
            },
        );
    })
    .on_document_title_changed(move |wv, title| {
        let url = wv.url().map(|u| u.to_string()).unwrap_or_default();
        emit(
            &title_app,
            BrowserEvent {
                pane,
                kind: "title",
                url,
                title: Some(title),
            },
        );
    })
}

fn pane_webview<R: Runtime>(app: &AppHandle<R>, pane: u32) -> Result<Webview<R>, String> {
    app.get_webview(&label(pane))
        .ok_or_else(|| format!("browser pane {pane} is not open"))
}

/// Create the pane's webview at `bounds` (or just reposition it if it already
/// exists). Async so creation never blocks the main thread — Tauri warns that
/// child-webview creation can deadlock in synchronous handlers on Windows.
#[tauri::command]
pub async fn browser_open<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    pane: u32,
    url: String,
    bounds: Bounds,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label(pane)) {
        return wv.set_bounds(bounds.rect(&app)).map_err(|e| e.to_string());
    }
    let url = parse_url(&url)?;
    let generation = UI_GENERATION.load(Ordering::SeqCst);
    let b = builder(&app, label(pane), url, pane);
    let rect = bounds.rect(&app);
    #[cfg(debug_assertions)]
    eprintln!("[browser] pane {pane}: placeholder {bounds:?} -> window {rect:?}");
    let wv = window
        .add_child(b, rect.position, rect.size)
        .map_err(|e| e.to_string())?;
    if UI_GENERATION.load(Ordering::SeqCst) != generation {
        // Rune's UI reloaded while this was being created.
        let _ = wv.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate<R: Runtime>(
    app: AppHandle<R>,
    pane: u32,
    url: String,
) -> Result<(), String> {
    let url = parse_url(&url)?;
    pane_webview(&app, pane)?
        .navigate(url)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Nav {
    Back,
    Forward,
    Reload,
}

#[tauri::command]
pub async fn browser_nav<R: Runtime>(
    app: AppHandle<R>,
    pane: u32,
    action: Nav,
) -> Result<(), String> {
    let wv = pane_webview(&app, pane)?;
    match action {
        Nav::Reload => wv.reload(),
        // Tauri exposes no history API; these one-liners are the only script
        // Rune ever runs in a page, and only on an explicit toolbar click.
        Nav::Back => wv.eval("history.back()"),
        Nav::Forward => wv.eval("history.forward()"),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_set_bounds<R: Runtime>(
    app: AppHandle<R>,
    pane: u32,
    bounds: Bounds,
) -> Result<(), String> {
    pane_webview(&app, pane)?
        .set_bounds(bounds.rect(&app))
        .map_err(|e| e.to_string())
}

/// Hide/show without destroying — used while a Rune modal or menu must sit
/// above the native webview (which always paints over the HTML UI).
#[tauri::command]
pub async fn browser_set_visible<R: Runtime>(
    app: AppHandle<R>,
    pane: u32,
    visible: bool,
) -> Result<(), String> {
    let wv = pane_webview(&app, pane)?;
    if visible { wv.show() } else { wv.hide() }.map_err(|e| e.to_string())
}

/// Destroy the pane's webview. Idempotent: closing a pane that has no live
/// webview is fine.
#[tauri::command]
pub async fn browser_close<R: Runtime>(app: AppHandle<R>, pane: u32) -> Result<(), String> {
    match app.get_webview(&label(pane)) {
        Some(wv) => wv.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Close every browser webview. Called when Rune's UI (re)loads so a dev
/// reload never leaves orphaned pages painted over the new UI.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    UI_GENERATION.fetch_add(1, Ordering::SeqCst);
    for (label, wv) in app.webviews() {
        if label.starts_with(LABEL_PREFIX) {
            let _ = wv.close();
        }
    }
}

/// macOS's default menu binds ⌘W to "Close Window" (in File and Window).
/// Rune's UI handles ⌘W itself (close pane), but while a browser page has
/// keyboard focus the key falls through to the menu and would close Rune
/// with every terminal. Swap those items for one "Close Pane" item that asks
/// the UI to close the focused pane instead.
#[cfg(target_os = "macos")]
pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, WINDOW_SUBMENU_ID};
    let menu = Menu::default(app)?;
    for item in menu.items()? {
        let MenuItemKind::Submenu(sub) = item else {
            continue;
        };
        let is_file = sub.text()? == "File";
        if !is_file && *sub.id() != WINDOW_SUBMENU_ID {
            continue;
        }
        // shortcut: relies on Tauri 2.11's default menu layout (File holds only
        // Close Window; Window ends with it); re-check when upgrading Tauri.
        let entries = sub.items()?;
        let close = if is_file {
            entries.first()
        } else {
            entries.last()
        };
        if let Some(close @ MenuItemKind::Predefined(_)) = close {
            sub.remove(close)?;
        }
        if is_file {
            let item = MenuItem::with_id(
                app,
                CLOSE_PANE_MENU_ID,
                "Close Pane",
                true,
                Some("CmdOrCtrl+W"),
            )?;
            sub.insert(&item, 0)?;
        }
    }
    Ok(menu)
}

#[cfg(target_os = "macos")]
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if *event.id() == CLOSE_PANE_MENU_ID {
        let _ = app.emit_to(MAIN_WEBVIEW, "close-focused-pane", ());
    }
}

/// True when browser site data lives in its own store, separate from Rune's UI
/// (localStorage holds Rune's settings and session). macOS < 14 has no custom
/// WKWebsiteDataStore, so browser panes share the default store there.
fn has_separate_store() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|v| v.trim().split('.').next()?.parse::<u32>().ok())
            .is_some_and(|major| major >= 14)
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Run `f` against a webview bound to the browser data store: an open pane if
/// there is one, otherwise a temporary hidden webview that is closed after.
pub(crate) async fn with_store<R: Runtime, T>(
    app: &AppHandle<R>,
    window: &Window<R>,
    f: impl FnOnce(&Webview<R>) -> Result<T, String>,
) -> Result<T, String> {
    if let Some(wv) = app
        .webviews()
        .into_iter()
        .find_map(|(l, wv)| l.starts_with(LABEL_PREFIX).then_some(wv))
    {
        return f(&wv);
    }
    let blank = Url::parse("about:blank").expect("static url");
    let b = WebviewBuilder::new(STORE_LABEL, WebviewUrl::External(blank))
        .data_store_identifier(DATA_STORE_ID);
    let b = match app.path().app_local_data_dir() {
        Ok(dir) => b.data_directory(dir.join("browser")),
        Err(_) => b,
    };
    let wv = window
        .add_child(
            b,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    let _ = wv.hide();
    let out = f(&wv);
    let _ = wv.close();
    out
}

/// Remove cookies, cache and site storage of embedded browser panes only.
#[tauri::command]
pub async fn browser_clear_data<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
) -> Result<(), String> {
    if !has_separate_store() {
        return Err("Clearing browser data needs macOS 14 or later: older macOS shares one data store between browser panes and Rune itself.".into());
    }
    with_store(&app, &window, |wv| {
        wv.clear_all_browsing_data().map_err(|e| e.to_string())
    })
    .await
}

/// Deliver a channel message straight to the webview that owns the channel.
///
/// Tauri parks payloads over ~8 KiB in an app-global queue keyed by a
/// sequential id and lets *any* webview fetch them via
/// `plugin:__TAURI_CHANNEL__|fetch` (that command bypasses the ACL). With
/// untrusted pages in browser panes, a page could race Rune's UI for PTY
/// output. Evaluating every payload directly keeps the queue empty.
pub fn deliver_channel_payload<R: Runtime>(
    webview: &Webview<R>,
    callback: CallbackFn,
    index: usize,
    body: &InvokeResponseBody,
) -> bool {
    let message = match body {
        InvokeResponseBody::Json(json) => json.clone(),
        InvokeResponseBody::Raw(bytes) => match serde_json::to_string(bytes) {
            Ok(arr) => format!("new Uint8Array({arr}).buffer"),
            Err(_) => return false,
        },
    };
    let id = callback.0;
    let _ = webview.eval(format!(
        "window.__TAURI_INTERNALS__.runCallback({id}, {{ message: {message}, index: {index} }})"
    ));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_url_accepts_only_http_and_https() {
        assert_eq!(
            parse_url(" https://react.dev/learn ").unwrap().as_str(),
            "https://react.dev/learn"
        );
        assert!(parse_url("http://localhost:5173/").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost/",
            "ipc://localhost/pty_spawn",
            "data:text/html,hi",
            "mailto:a@b.c",
            "react.dev",
            "https://",
        ] {
            assert!(parse_url(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn pane_navigation_allows_web_and_subframe_schemes_only() {
        let ok = |s: &str| allowed_in_pane(&Url::parse(s).unwrap());
        assert!(ok("https://example.com/"));
        assert!(ok("about:blank"));
        assert!(ok("blob:https://example.com/uuid"));
        assert!(!ok("file:///Users/me/.ssh/id_rsa"));
        assert!(!ok("tauri://localhost/"));
        assert!(!ok("zoommtg://zoom.us/join"));
    }
}
