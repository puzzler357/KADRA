//! Tauri commands for the licence screen (LICENSING.md 9.1).
//!
//! None takes a state or a mode: the webview can ask for things to be done
//! (import a file, write a request) and read the result, never tell Rust what
//! the result is. Nor does any take a file path: the open and save dialogs
//! are shown from here, so a modified script cannot point a write anywhere
//! on disk, and an offline deactivation is never separated from its proof.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::client;
use super::files::OpResult;
use super::model::{ActivationMode, RequestType};
use super::{LicenseManager, StatusView};
use crate::db::commands::DbState;

/// The status plus whether anyone can sign in yet, which decides between
/// the activation screen and read-only browsing (8.2).
#[derive(Serialize)]
pub struct StatusResponse {
    #[serde(flatten)]
    pub view: StatusView,
    pub database_empty: bool,
    /// What an online check came to, for a notification; absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
}

#[derive(Serialize)]
pub struct Outcome {
    pub ok: bool,
    pub message: String,
}

async fn blocking<T, F>(manager: &State<'_, Arc<LicenseManager>>, work: F) -> OpResult<T>
where
    T: Send + 'static,
    F: FnOnce(&LicenseManager) -> OpResult<T> + Send + 'static,
{
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || work(&manager))
        .await
        .map_err(|e| e.to_string())?
}

fn with_database(view: StatusView, db: &DbState) -> StatusResponse {
    let database_empty = db.0.as_ref().map(|db| db.is_empty()).unwrap_or(true);
    StatusResponse {
        view,
        database_empty,
        outcome: None,
    }
}

/// The native save dialog; `None` when the user cancels. Runs on the
/// blocking pool, never on the main thread.
fn save_path(
    app: &AppHandle,
    title: &str,
    file_name: &str,
    extension: &str,
) -> OpResult<Option<PathBuf>> {
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter("KADRA", &[extension])
        .blocking_save_file()
        .map(|path| path.into_path().map_err(|e| e.to_string()))
        .transpose()
}

fn open_path(app: &AppHandle, title: &str) -> OpResult<Option<PathBuf>> {
    app.dialog()
        .file()
        .set_title(title)
        .add_filter("KADRA", &["kdrlic", "kdrclock"])
        .blocking_pick_file()
        .map(|path| path.into_path().map_err(|e| e.to_string()))
        .transpose()
}

#[tauri::command]
pub async fn license_status(
    manager: State<'_, Arc<LicenseManager>>,
    db: State<'_, DbState>,
) -> OpResult<StatusResponse> {
    let view = blocking(&manager, |m| Ok(m.status())).await?;
    Ok(with_database(view, &db))
}

/// "Проверить лицензию": asks the server for an ONLINE licence (5.2),
/// re-reads the files and the clock for any other. User-initiated, so it does
/// not wait for refresh_after.
#[tauri::command]
pub async fn license_refresh(
    manager: State<'_, Arc<LicenseManager>>,
    db: State<'_, DbState>,
) -> OpResult<StatusResponse> {
    let (view, outcome) = blocking(&manager, |m| {
        let online = m
            .installed_license()
            .is_some_and(|l| l.activation_mode == ActivationMode::Online);
        Ok(if online {
            let (view, outcome) = m.refresh_online();
            let ok = matches!(outcome, client::Outcome::Updated);
            (
                view,
                Some(Outcome {
                    ok,
                    message: outcome.message(),
                }),
            )
        } else {
            (m.refresh(), None)
        })
    })
    .await?;
    let mut response = with_database(view, &db);
    response.outcome = outcome;
    Ok(response)
}

/// 5.2 `/v1/activate`: activation by key over the network.
#[tauri::command]
pub async fn license_activate_online(
    manager: State<'_, Arc<LicenseManager>>,
    license_key: String,
) -> OpResult<StatusView> {
    blocking(&manager, move |m| m.activate_online(&license_key)).await
}

/// 5.1: an ACTIVATE or REBIND request file for the seller. `None`: the save
/// dialog was cancelled and nothing was written.
#[tauri::command]
pub async fn license_export_request(
    app: AppHandle,
    manager: State<'_, Arc<LicenseManager>>,
    kind: String,
    license_key: Option<String>,
    title: String,
) -> OpResult<Option<StatusView>> {
    let (kind, file_name) = match kind.as_str() {
        "ACTIVATE" => (RequestType::Activate, "activation_request.kdrreq"),
        "REBIND" => (RequestType::Rebind, "rebind_request.kdrreq"),
        other => return Err(format!("Неизвестный тип запроса {other}")),
    };
    blocking(&manager, move |m| {
        let Some(path) = save_path(&app, &title, file_name, "kdrreq")? else {
            return Ok(None);
        };
        m.export_request(kind, license_key, &path).map(Some)
    })
    .await
}

/// A `.kdrlic` or `.kdrclock` from the seller. `None`: cancelled.
#[tauri::command]
pub async fn license_import(
    app: AppHandle,
    manager: State<'_, Arc<LicenseManager>>,
    title: String,
) -> OpResult<Option<StatusView>> {
    blocking(&manager, move |m| {
        let Some(path) = open_path(&app, &title)? else {
            return Ok(None);
        };
        m.import(&path).map(Some)
    })
    .await
}

/// 7.2. `online`: the server frees the seat itself. Otherwise the `.kdrdeact`
/// proof is written for the seller first, and only then is the licence
/// removed. `None`: the save dialog was cancelled and nothing changed.
#[tauri::command]
pub async fn license_deactivate(
    app: AppHandle,
    manager: State<'_, Arc<LicenseManager>>,
    online: bool,
    title: String,
) -> OpResult<Option<StatusView>> {
    blocking(&manager, move |m| {
        if online {
            return m.deactivate_online().map(Some);
        }
        let Some(path) = save_path(&app, &title, "deactivation_proof.kdrdeact", "kdrdeact")? else {
            return Ok(None);
        };
        m.deactivate(&path).map(Some)
    })
    .await
}
