//! Tauri commands for the webview's database access.
//!
//! None of them takes a mode or a licence state: what may be written is
//! decided in `guard.rs` from state held on this side.
//!
//! The work runs on the blocking pool. A synchronous command would run on the
//! main thread and freeze the window for the length of a large query.

use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::Response;
use tauri::State;

use super::{Database, DbError, Row, SqlStatement};

/// What `setup` managed: the open database, or why it failed to open. The
/// failure is kept rather than aborting startup so the webview can show it,
/// as it did when it opened the database itself.
pub struct DbState(pub Result<Arc<Database>, String>);

impl DbState {
    fn database(&self) -> Result<Arc<Database>, DbError> {
        self.0.clone().map_err(DbError::Unavailable)
    }
}

async fn blocking<T, F>(state: &DbState, work: F) -> Result<T, DbError>
where
    T: Send + 'static,
    F: FnOnce(&Database) -> Result<T, DbError> + Send + 'static,
{
    let db = state.database()?;
    tauri::async_runtime::spawn_blocking(move || work(&db))
        .await
        .map_err(|error| DbError::Unavailable(error.to_string()))?
}

#[tauri::command]
pub async fn db_select(
    state: State<'_, DbState>,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<Vec<Row>, DbError> {
    let params = params.unwrap_or_default();
    blocking(&state, move |db| db.select(&sql, &params)).await
}

#[tauri::command]
pub async fn db_execute(
    state: State<'_, DbState>,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<(), DbError> {
    let params = params.unwrap_or_default();
    blocking(&state, move |db| db.execute(&sql, &params)).await
}

#[tauri::command]
pub async fn db_transaction(
    state: State<'_, DbState>,
    statements: Vec<SqlStatement>,
) -> Result<(), DbError> {
    blocking(&state, move |db| db.transaction(&statements)).await
}

/// Raw bytes, not a JSON array of numbers: a database of a few megabytes would
/// otherwise cross the bridge as tens of megabytes of text.
#[tauri::command]
pub async fn db_serialize(state: State<'_, DbState>) -> Result<Response, DbError> {
    let bytes = blocking(&state, |db| db.serialize()).await?;
    Ok(Response::new(bytes))
}
