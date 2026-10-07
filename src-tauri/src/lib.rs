mod db;
mod license;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use db::commands::DbState;
use license::client::{HttpTransport, Offline, Transport};
use license::keys::KeyRing;
use license::platform::SystemPlatform;
use license::LicenseManager;

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Opens the database where tauri-plugin-sql kept it.
///
/// The plugin resolved `sqlite:local-hr-docs.db` against app_config_dir(),
/// which on Windows is %APPDATA%\com.hrdesk.local. Any other directory
/// (app_local_data_dir() is %LOCALAPPDATA%) would start every existing
/// installation on an empty database without a word.
fn open_database(app: &tauri::App) -> Result<Arc<db::Database>, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    db::Database::open(&dir.join(db::DATABASE_FILE))
        .map(Arc::new)
        .map_err(|e| e.to_string())
}

/// 6.1: the newest journal row raises the high-water mark - read here from
/// the database, so a modified webview cannot hold it back.
fn report_anchor(manager: &LicenseManager, database: Option<&Arc<db::Database>>) {
    if let Some(iso) = database.and_then(|db| db.newest_audit_time()) {
        if let Err(error) = manager.report_time_anchor(&iso) {
            eprintln!("[License] time anchor not applied: {error}");
        }
    }
}

/// The licence manager, wired to the database guard and to the webview.
///
/// Every status it computes sets the guard's mode, so a licence that lapses
/// or is revoked mid-session stops writes at once, not at the next start.
fn start_licensing(
    app: &tauri::App,
    database: Option<Arc<db::Database>>,
) -> Result<Arc<LicenseManager>, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("license");
    let version = env!("CARGO_PKG_VERSION");
    let transport: Arc<dyn Transport> = match HttpTransport::new(version) {
        Ok(http) => Arc::new(http),
        Err(error) => {
            // Without HTTPS the app still works: offline files, and whatever
            // lease the licence already carries.
            eprintln!("[License] no network client: {error}");
            Arc::new(Offline)
        }
    };
    let manager = Arc::new(LicenseManager::new(
        dir,
        Arc::new(SystemPlatform::default()),
        KeyRing::embedded(),
        version,
        transport,
    ));

    let handle = app.handle().clone();
    let guarded = database.clone();
    manager.on_change(move |view| {
        if let Some(database) = &guarded {
            database.guard().set_mode(view.state.mode());
        }
        let _ = handle.emit("license://changed", view);
    });

    // Before the window's scripts run: the first status sets the guard.
    manager.refresh();
    report_anchor(&manager, database.as_ref());

    // 6: the high-water mark grows while the app runs, and a licence that
    // expires during the session is noticed within the interval.
    let ticking = Arc::clone(&manager);
    std::thread::spawn(move || loop {
        std::thread::sleep(license::clock::tick_interval());
        ticking.refresh();
        report_anchor(&ticking, database.as_ref());
    });

    // 5.2: at start-up if refresh_after has passed, then every 12 hours of
    // work - never more often. A failed attempt changes nothing and simply
    // waits for the next round.
    let refreshing = Arc::clone(&manager);
    std::thread::spawn(move || loop {
        if refreshing.refresh_due() {
            let (_, outcome) = refreshing.refresh_online();
            eprintln!("[License] background refresh: {}", outcome.message());
        }
        std::thread::sleep(license::client::REFRESH_INTERVAL);
    });

    Ok(manager)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Only the shell opens dialogs (license/commands.rs); the window has
        // no dialog permission of its own.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            db::commands::db_select,
            db::commands::db_execute,
            db::commands::db_transaction,
            db::commands::db_serialize,
            license::commands::license_status,
            license::commands::license_refresh,
            license::commands::license_activate_online,
            license::commands::license_export_request,
            license::commands::license_import,
            license::commands::license_deactivate
        ])
        .setup(|app| {
            // Order matters (LICENSING.md 9.3): the schema and the seed are
            // applied as the database opens, before any licence mode exists;
            // then the mode is computed and set on the guard; only then can
            // the window ask for anything.
            let database = open_database(app);
            if let Err(reason) = &database {
                eprintln!("[SQLite] Could not open the database: {reason}");
            }
            if let Ok(database) = &database {
                // Fail closed until the licence says otherwise.
                database.guard().set_mode(db::guard::Mode::ReadOnly);
            }

            let manager = start_licensing(app, database.as_ref().ok().cloned())?;
            app.manage(manager);
            app.manage(DbState(database));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
