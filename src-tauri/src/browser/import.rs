//! Chromium profile detection and bookmark import. Profiles are only ever read
//! from the browsers' standard user-data folders: commands take a profile
//! directory chosen in Settings and re-resolve it against this list, so they
//! can never be pointed at arbitrary files.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// A Chrome-family browser profile found on this machine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromiumProfile {
    pub browser: &'static str,
    /// Display name from the browser's `Local State` (falls back to the folder name).
    pub name: String,
    /// Absolute profile directory, e.g. `…/Google/Chrome/Default`.
    pub dir: String,
    pub has_bookmarks: bool,
    /// Cookie import is Chrome-only.
    pub has_cookies: bool,
}

/// (browser name, user-data directory) for every supported Chromium browser.
fn user_data_dirs() -> Vec<(&'static str, PathBuf)> {
    #[cfg(target_os = "macos")]
    let (base, list) = (
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support")),
        [
            ("Chrome", "Google/Chrome"),
            ("Chromium", "Chromium"),
            ("Brave", "BraveSoftware/Brave-Browser"),
            ("Edge", "Microsoft Edge"),
        ],
    );
    #[cfg(all(unix, not(target_os = "macos")))]
    let (base, list) = (
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))),
        [
            ("Chrome", "google-chrome"),
            ("Chromium", "chromium"),
            ("Brave", "BraveSoftware/Brave-Browser"),
            ("Edge", "microsoft-edge"),
        ],
    );
    #[cfg(windows)]
    let (base, list) = (
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        [
            ("Chrome", "Google/Chrome/User Data"),
            ("Chromium", "Chromium/User Data"),
            ("Brave", "BraveSoftware/Brave-Browser/User Data"),
            ("Edge", "Microsoft/Edge/User Data"),
        ],
    );
    base.map(|b| list.iter().map(|(n, p)| (*n, b.join(p))).collect())
        .unwrap_or_default()
}

/// Profile folder → display name, from `<user data>/Local State`.
fn profile_names(root: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(root.join("Local State"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.pointer("/profile/info_cache")?.as_object().cloned())
        .map(|m| {
            m.into_iter()
                .filter_map(|(k, v)| Some((k, v.get("name")?.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// The profile's cookie database (moved under `Network/` in Chrome 96).
pub fn cookie_db(profile: &Path) -> Option<PathBuf> {
    [
        profile.join("Network").join("Cookies"),
        profile.join("Cookies"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

pub fn detect_profiles() -> Vec<ChromiumProfile> {
    let mut out = Vec::new();
    for (browser, root) in user_data_dirs() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        let names = profile_names(&root);
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                n == "Default" || n.starts_with("Profile ")
            })
            .collect();
        dirs.sort();
        for dir in dirs {
            let has_bookmarks = dir.join("Bookmarks").is_file();
            let has_cookies = browser == "Chrome" && cookie_db(&dir).is_some();
            if !has_bookmarks && !has_cookies {
                continue;
            }
            let key = dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            out.push(ChromiumProfile {
                browser,
                name: names.get(&key).cloned().unwrap_or(key),
                dir: dir.to_string_lossy().into_owned(),
                has_bookmarks,
                has_cookies,
            });
        }
    }
    out
}

/// Look `dir` up among detected profiles; anything else is refused.
pub fn resolve_profile(dir: &str) -> Result<ChromiumProfile, String> {
    detect_profiles()
        .into_iter()
        .find(|p| p.dir == dir)
        .ok_or_else(|| "Unknown browser profile".to_string())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bookmark {
    pub title: String,
    pub url: String,
    /// Folder path inside the browser, e.g. `Bookmarks bar/Docs`.
    pub folder: String,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkImport {
    pub bookmarks: Vec<Bookmark>,
    /// Same normalized URL seen more than once in the file (kept once).
    pub duplicates: usize,
    /// Non-web bookmarks (bookmarklets, `chrome://`, `file:`) that can't open in a pane.
    pub skipped: usize,
}

/// Flatten Chromium's `Bookmarks` JSON (folders preserved as paths), keeping
/// http(s) URLs only and merging duplicates by normalized URL.
pub fn parse_bookmarks(json: &str) -> Result<BookmarkImport, String> {
    let v: Value =
        serde_json::from_str(json).map_err(|e| format!("Unreadable Bookmarks file: {e}"))?;
    let roots = v
        .get("roots")
        .and_then(Value::as_object)
        .ok_or("Bookmarks file has no roots")?;
    let mut out = BookmarkImport::default();
    let mut seen = HashSet::new();
    for key in ["bookmark_bar", "other", "synced"] {
        if let Some(node) = roots.get(key) {
            walk(node, "", &mut seen, &mut out);
        }
    }
    Ok(out)
}

fn walk(node: &Value, parent: &str, seen: &mut HashSet<String>, out: &mut BookmarkImport) {
    let name = node.get("name").and_then(Value::as_str).unwrap_or_default();
    match node.get("type").and_then(Value::as_str) {
        Some("folder") => {
            let path = if parent.is_empty() {
                name.to_string()
            } else {
                format!("{parent}/{name}")
            };
            for child in node
                .get("children")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                walk(child, &path, seen, out);
            }
        }
        Some("url") => {
            let raw = node.get("url").and_then(Value::as_str).unwrap_or_default();
            match super::parse_url(raw) {
                Ok(url) => {
                    let url = url.to_string();
                    if !seen.insert(url.clone()) {
                        out.duplicates += 1;
                        return;
                    }
                    out.bookmarks.push(Bookmark {
                        title: if name.is_empty() {
                            url.clone()
                        } else {
                            name.to_string()
                        },
                        url,
                        folder: parent.to_string(),
                    });
                }
                Err(_) => out.skipped += 1,
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub async fn browser_profiles() -> Vec<ChromiumProfile> {
    detect_profiles()
}

#[tauri::command]
pub async fn browser_import_bookmarks(dir: String) -> Result<BookmarkImport, String> {
    let profile = resolve_profile(&dir)?;
    let json = std::fs::read_to_string(Path::new(&profile.dir).join("Bookmarks"))
        .map_err(|e| format!("Could not read {} bookmarks: {e}", profile.browser))?;
    parse_bookmarks(&json)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "checksum": "x",
      "roots": {
        "bookmark_bar": { "type": "folder", "name": "Bookmarks bar", "children": [
          { "type": "url", "name": "React", "url": "https://React.dev/learn" },
          { "type": "folder", "name": "Docs", "children": [
            { "type": "url", "name": "Tauri", "url": "https://v2.tauri.app/" },
            { "type": "url", "name": "", "url": "http://localhost:5173" },
            { "type": "url", "name": "Bookmarklet", "url": "javascript:alert(1)" }
          ]}
        ]},
        "other": { "type": "folder", "name": "Other bookmarks", "children": [
          { "type": "url", "name": "React again", "url": "https://react.dev/learn" },
          { "type": "url", "name": "Settings", "url": "chrome://settings" }
        ]},
        "synced": { "type": "folder", "name": "Mobile bookmarks", "children": [] }
      },
      "version": 1
    }"#;

    #[test]
    fn parses_folders_skips_non_web_and_merges_duplicates() {
        let b = |title: &str, url: &str, folder: &str| Bookmark {
            title: title.into(),
            url: url.into(),
            folder: folder.into(),
        };
        assert_eq!(
            parse_bookmarks(SAMPLE).unwrap(),
            BookmarkImport {
                bookmarks: vec![
                    b("React", "https://react.dev/learn", "Bookmarks bar"),
                    b("Tauri", "https://v2.tauri.app/", "Bookmarks bar/Docs"),
                    b(
                        "http://localhost:5173/",
                        "http://localhost:5173/",
                        "Bookmarks bar/Docs"
                    ),
                ],
                duplicates: 1,
                skipped: 2,
            }
        );
    }

    #[test]
    fn rejects_files_without_roots() {
        assert!(parse_bookmarks("{}").is_err());
        assert!(parse_bookmarks("not json").is_err());
    }

    #[test]
    fn unknown_profiles_are_refused() {
        assert!(resolve_profile("/etc").is_err());
    }
}
