//! Best-effort import of Chrome cookies into the browser-pane data store.
//!
//! Chrome encrypts cookie values with a key the OS guards: on macOS a
//! password in the login Keychain ("Chrome Safe Storage" — macOS asks the
//! user before releasing it), on Linux the desktop keyring or a fixed
//! fallback. Rune copies the profile's cookie database so a running Chrome is
//! never touched or blocked, decrypts each value, and hands the cookies to the
//! webview cookie store. Chrome on Windows encrypts with App-Bound Encryption
//! (`v20` values) that only Chrome's own elevation service can decrypt, so
//! import is refused there. Imported sessions may still be rejected by sites
//! that bind them to the original browser or device.
//!
//! Cookie values are never logged.

use super::import::{cookie_db, resolve_profile};
use super::with_store;
use serde::Serialize;
use std::path::Path;
use tauri::webview::cookie::{time::OffsetDateTime, Cookie, SameSite};
use tauri::{AppHandle, Runtime, Window};

/// Seconds between 1601-01-01 (Chrome's epoch) and 1970-01-01.
const CHROME_EPOCH_OFFSET: i64 = 11_644_473_600;
/// Chrome's fixed CBC IV: sixteen spaces.
const IV: [u8; 16] = [b' '; 16];

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieImport {
    pub found: usize,
    pub imported: usize,
    pub expired: usize,
    /// Values in a format Rune can't decrypt (e.g. Windows `v20`).
    pub unsupported: usize,
    /// Values that failed to decrypt with the profile key.
    pub failed: usize,
}

/// One row of Chrome's `cookies` table.
#[derive(Debug, Clone)]
struct Row {
    host: String,
    name: String,
    value: String,
    encrypted: Vec<u8>,
    path: String,
    expires_utc: i64,
    secure: bool,
    http_only: bool,
    same_site: i64,
}

#[derive(Debug, PartialEq)]
enum DecryptError {
    Unsupported,
    Failed,
}

/// AES-128 keys for Chrome's `v10` and `v11` value prefixes.
struct Keys {
    v10: [u8; 16],
    v11: [u8; 16],
}

#[cfg_attr(windows, allow(dead_code))]
fn derive_key(password: &[u8], iterations: u32) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", iterations, &mut key);
    key
}

#[cfg(target_os = "macos")]
fn keys() -> Result<Keys, String> {
    // macOS shows a Keychain prompt here; denying it ends the import.
    let password =
        security_framework::passwords::get_generic_password("Chrome Safe Storage", "Chrome")
            .map_err(|e| {
                format!("Could not read \"Chrome Safe Storage\" from the Keychain ({e}). Allow access when macOS asks to import cookies.")
            })?;
    let key = derive_key(&password, 1003);
    Ok(Keys { v10: key, v11: key })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn keys() -> Result<Keys, String> {
    // v10 uses Chrome's hard-coded fallback password; v11 uses the secret
    // stored in the desktop keyring (libsecret), when one is reachable.
    let secret = std::process::Command::new("secret-tool")
        .args(["lookup", "application", "chrome"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| o.stdout.trim_ascii_end().to_vec())
        .unwrap_or_default();
    Ok(Keys {
        v10: derive_key(b"peanuts", 1),
        v11: derive_key(&secret, 1),
    })
}

#[cfg(windows)]
fn keys() -> Result<Keys, String> {
    Err("Chrome on Windows protects cookies with App-Bound Encryption, which only Chrome itself can decrypt, so cookie import isn't available on Windows.".into())
}

/// Decrypt one `encrypted_value`. Cookie databases at schema version 24+
/// prefix the plaintext with SHA-256(host_key), which is dropped.
fn decrypt_value(enc: &[u8], keys: &Keys, has_host_hash: bool) -> Result<String, DecryptError> {
    use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let key = match enc.get(..3) {
        Some(b"v10") => &keys.v10,
        Some(b"v11") => &keys.v11,
        _ => return Err(DecryptError::Unsupported),
    };
    let mut buf = enc[3..].to_vec();
    let plain = cbc::Decryptor::<aes::Aes128>::new_from_slices(key, &IV)
        .map_err(|_| DecryptError::Failed)?
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| DecryptError::Failed)?;
    let plain = if has_host_hash {
        plain.get(32..).ok_or(DecryptError::Failed)?
    } else {
        plain
    };
    String::from_utf8(plain.to_vec()).map_err(|_| DecryptError::Failed)
}

/// Chrome stores expiry as microseconds since 1601; 0 means a session cookie.
fn expiry_unix(expires_utc: i64) -> Option<i64> {
    (expires_utc > 0).then(|| expires_utc / 1_000_000 - CHROME_EPOCH_OFFSET)
}

fn to_cookie(row: &Row, value: String) -> Cookie<'static> {
    // wry passes `cookie.domain()` to the platform store, and the cookie crate
    // strips one leading dot there. Chrome marks domain-wide cookies with a
    // leading dot, so prepend another to keep `.example.com` domain-wide
    // instead of collapsing it into a host-only `example.com` cookie.
    // shortcut: depends on cookie/wry domain handling; the test below catches a change on upgrade.
    let domain = if row.host.starts_with('.') {
        format!(".{}", row.host)
    } else {
        row.host.clone()
    };
    let mut b = Cookie::build((row.name.clone(), value))
        .domain(domain)
        .path(row.path.clone())
        .secure(row.secure)
        .http_only(row.http_only);
    if let Some(at) =
        expiry_unix(row.expires_utc).and_then(|s| OffsetDateTime::from_unix_timestamp(s).ok())
    {
        b = b.expires(at);
    }
    b = match row.same_site {
        0 => b.same_site(SameSite::None),
        1 => b.same_site(SameSite::Lax),
        2 => b.same_site(SameSite::Strict),
        _ => b,
    };
    b.build()
}

/// Read every row from a private copy of the database (plus its WAL/journal),
/// so Chrome's live profile is never opened, locked or modified.
fn read_rows(db: &Path) -> Result<(i64, Vec<Row>), String> {
    // A unique TempDir avoids overlapping imports colliding and removes the
    // plaintext copy automatically when this function returns.
    let tmp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let copy = tmp.path().join("Cookies");
    std::fs::copy(db, &copy)
        .map_err(|e| format!("Could not copy Chrome's cookie database: {e}"))?;
    for side in ["Cookies-wal", "Cookies-journal"] {
        let src = db.with_file_name(side);
        if src.is_file() {
            let _ = std::fs::copy(&src, tmp.path().join(side));
        }
    }
    let conn = rusqlite::Connection::open(&copy).map_err(|e| e.to_string())?;
    let version = conn
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut stmt = conn
        .prepare(
            "SELECT host_key, name, value, encrypted_value, path, expires_utc, \
             is_secure, is_httponly, samesite FROM cookies",
        )
        .map_err(|e| format!("Unrecognized cookie database: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Row {
                host: r.get(0)?,
                name: r.get(1)?,
                value: r.get(2)?,
                encrypted: r.get(3)?,
                path: r.get(4)?,
                expires_utc: r.get(5)?,
                secure: r.get::<_, i64>(6)? != 0,
                http_only: r.get::<_, i64>(7)? != 0,
                same_site: r.get(8)?,
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("Unrecognized cookie database: {e}"))?;
    Ok((version, rows))
}

fn decrypt_all(db: &Path) -> Result<(Vec<Cookie<'static>>, CookieImport), String> {
    let (version, rows) = read_rows(db)?;
    // Ask for the OS-guarded Chrome key only if an encrypted value needs it;
    // an all-plaintext or empty database should not show a Keychain prompt.
    let keys = if rows
        .iter()
        .any(|r| r.value.is_empty() && !r.encrypted.is_empty())
    {
        Some(keys()?)
    } else {
        None
    };
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let mut report = CookieImport {
        found: rows.len(),
        ..Default::default()
    };
    let mut cookies = Vec::new();
    for row in &rows {
        if expiry_unix(row.expires_utc).is_some_and(|t| t <= now) {
            report.expired += 1;
            continue;
        }
        let value = if !row.value.is_empty() {
            Ok(row.value.clone())
        } else if let Some(keys) = keys.as_ref() {
            decrypt_value(&row.encrypted, keys, version >= 24)
        } else {
            Err(DecryptError::Failed)
        };
        match value {
            Ok(v) => cookies.push(to_cookie(row, v)),
            Err(DecryptError::Unsupported) => report.unsupported += 1,
            Err(DecryptError::Failed) => report.failed += 1,
        }
    }
    Ok((cookies, report))
}

/// Import a Chrome profile's cookies (explicit Settings action).
#[tauri::command]
pub async fn browser_import_cookies<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    dir: String,
) -> Result<CookieImport, String> {
    let profile = resolve_profile(&dir)?;
    if profile.browser != "Chrome" {
        return Err("Cookie import supports Chrome profiles only.".into());
    }
    let db = cookie_db(Path::new(&profile.dir)).ok_or("This Chrome profile has no cookies.")?;
    let (cookies, mut report) = tauri::async_runtime::spawn_blocking(move || decrypt_all(&db))
        .await
        .map_err(|e| e.to_string())??;
    report.imported = with_store(&app, &window, move |wv| {
        let mut n = 0;
        for c in cookies {
            wv.set_cookie(c).map_err(|e| e.to_string())?;
            n += 1;
        }
        Ok(n)
    })
    .await?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};

    fn encrypt(prefix: &[u8], key: &[u8; 16], plain: &[u8]) -> Vec<u8> {
        let mut buf = vec![0u8; plain.len() + 16];
        buf[..plain.len()].copy_from_slice(plain);
        let ct = cbc::Encryptor::<aes::Aes128>::new_from_slices(key, &IV)
            .unwrap()
            .encrypt_padded_mut::<Pkcs7>(&mut buf, plain.len())
            .unwrap();
        [prefix, ct].concat()
    }

    fn keys() -> Keys {
        Keys {
            v10: derive_key(b"peanuts", 1),
            v11: derive_key(b"keyring-secret", 1),
        }
    }

    #[test]
    fn decrypts_v10_and_v11_values() {
        let k = keys();
        assert_eq!(
            decrypt_value(&encrypt(b"v10", &k.v10, b"abc123"), &k, false).unwrap(),
            "abc123"
        );
        assert_eq!(
            decrypt_value(&encrypt(b"v11", &k.v11, b"xyz"), &k, false).unwrap(),
            "xyz"
        );
    }

    #[test]
    fn drops_host_hash_prefix_from_v24_databases() {
        let k = keys();
        let plain = [[7u8; 32].as_slice(), b"session=1".as_slice()].concat();
        let enc = encrypt(b"v10", &k.v10, &plain);
        assert_eq!(decrypt_value(&enc, &k, true).unwrap(), "session=1");
    }

    #[test]
    fn rejects_unknown_formats_and_wrong_keys() {
        let k = keys();
        let app_bound = encrypt(b"v20", &k.v10, b"secret");
        assert_eq!(
            decrypt_value(&app_bound, &k, false),
            Err(DecryptError::Unsupported)
        );
        let wrong_key = encrypt(b"v10", &derive_key(b"other", 1), b"secret");
        assert_eq!(
            decrypt_value(&wrong_key, &k, false),
            Err(DecryptError::Failed)
        );
        assert_eq!(
            decrypt_value(b"", &k, false),
            Err(DecryptError::Unsupported)
        );
    }

    #[test]
    fn converts_chrome_expiry_to_unix_seconds() {
        assert_eq!(expiry_unix(13_300_000_000_000_000), Some(1_655_526_400));
        assert_eq!(expiry_unix(0), None);
    }

    fn row(host: &str, expires_utc: i64, same_site: i64) -> Row {
        Row {
            host: host.into(),
            name: "sid".into(),
            value: String::new(),
            encrypted: Vec::new(),
            path: "/".into(),
            expires_utc,
            secure: true,
            http_only: true,
            same_site,
        }
    }

    #[test]
    fn maps_rows_to_webview_cookies() {
        let domain_wide = to_cookie(&row(".example.com", 13_300_000_000_000_000, 1), "v".into());
        assert_eq!(domain_wide.domain(), Some(".example.com"));
        assert_eq!(domain_wide.same_site(), Some(SameSite::Lax));
        assert_eq!(
            domain_wide.expires_datetime().map(|d| d.unix_timestamp()),
            Some(1_655_526_400)
        );
        assert_eq!(domain_wide.secure(), Some(true));
        assert_eq!(domain_wide.http_only(), Some(true));

        let host_only = to_cookie(&row("www.example.com", 0, -1), "v".into());
        assert_eq!(host_only.domain(), Some("www.example.com"));
        assert_eq!(host_only.same_site(), None);
        assert_eq!(host_only.expires(), None);
    }
}
