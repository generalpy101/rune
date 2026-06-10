//! Thin wrappers over `tauri-plugin-updater` exposed as commands so the
//! frontend can check for and install updates without pulling in the JS plugin
//! package. Both gracefully surface errors (no network, no published release,
//! signature mismatch) as `Err(String)` for the UI to show or ignore.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
}

/// Query the configured update endpoint. Returns whether a newer signed release
/// is available along with its version and release notes.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: None,
            notes: None,
        }),
        Err(e) => Err(e.to_string()),
    }
}

/// Download and install the available update, then relaunch into it. On
/// success this never returns (the process restarts); errors surface to the UI.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available".to_string())?;
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // Restart into the freshly-installed version. `restart` exits the process,
    // so nothing after this line runs.
    app.restart();
}
