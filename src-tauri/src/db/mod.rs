//! The desktop database: one SQLite connection owned by the Rust shell.
//!
//! The webview reaches it only through the `db_*` commands in `commands.rs`,
//! and every one of them passes through `guard.rs`. Keeping the connection on
//! this side is what makes a READ_ONLY licence mode enforceable at all: when
//! the webview held its own handle through tauri-plugin-sql, whatever it
//! decided not to write was only a polite request.

pub mod commands;
pub mod guard;
pub mod schema;

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, Statement};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use guard::{Guard, Mode};

/// The file name the webview used with tauri-plugin-sql
/// (`sqlite:local-hr-docs.db`).
pub const DATABASE_FILE: &str = "local-hr-docs.db";

#[derive(Debug)]
pub enum DbError {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    /// The guard refused the statement.
    Denied(String),
    /// A parameter the webview sent cannot be bound.
    BadParam(String),
    /// The database failed to open at startup; every command reports why.
    Unavailable(String),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::Sqlite(error) => write!(f, "{error}"),
            DbError::Io(error) => write!(f, "{error}"),
            // The prefix is what the webview recognises; the rest is for people.
            DbError::Denied(reason) => write!(f, "READ_ONLY: {reason}"),
            DbError::BadParam(reason) => write!(f, "bad parameter: {reason}"),
            DbError::Unavailable(reason) => write!(f, "database unavailable: {reason}"),
        }
    }
}

impl std::error::Error for DbError {}

/// Commands reject with a plain string, as tauri-plugin-sql did, so the
/// webview's existing error handling keeps working.
impl Serialize for DbError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<rusqlite::Error> for DbError {
    fn from(error: rusqlite::Error) -> Self {
        DbError::Sqlite(error)
    }
}

impl From<std::io::Error> for DbError {
    fn from(error: std::io::Error) -> Self {
        DbError::Io(error)
    }
}

/// One statement of a `db_transaction` batch, as the webview sends it.
#[derive(Debug, Deserialize)]
pub struct SqlStatement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

pub type Row = Map<String, Value>;

pub struct Database {
    conn: Mutex<Connection>,
    guard: Guard,
    path: Option<PathBuf>,
}

impl Database {
    /// Opens (creating if needed) the database at `path` and brings its schema
    /// up to date.
    ///
    /// The schema is applied here, before any licence mode is known and
    /// without the guard: READ_ONLY has to be able to open a database it may
    /// not write to, including one that does not exist yet.
    pub fn open(path: &Path) -> Result<Self, DbError> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn, Some(path.to_path_buf()))
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, DbError> {
        Self::init(Connection::open_in_memory()?, None)
    }

    fn init(conn: Connection, path: Option<PathBuf>) -> Result<Self, DbError> {
        conn.busy_timeout(Duration::from_secs(5))?;
        // sqlx, under tauri-plugin-sql, opened existing databases in WAL too.
        // The pragma answers with the resulting mode, hence query_row.
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        conn.execute_batch("PRAGMA foreign_keys = ON")?;
        schema::apply(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
            guard: Guard::new(Mode::Full),
            path,
        })
    }

    /// The licence module sets the mode through this.
    pub fn guard(&self) -> &Guard {
        &self.guard
    }

    #[allow(dead_code)]
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A panic while the lock was held cannot leave the connection itself
        // unusable, so a poisoned lock is taken over rather than propagated.
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// True while nobody can sign in yet: the owner's account is made on the
    /// first start, and the seed alone does not count - the shell writes it
    /// itself. Decides, together with the licence state, between the
    /// activation screen and read-only browsing (TZ.md 13.8): with no owner
    /// there is nothing a read-only session could show.
    pub fn is_empty(&self) -> bool {
        self.lock()
            .query_row("SELECT NOT EXISTS (SELECT 1 FROM users)", [], |row| {
                row.get::<_, bool>(0)
            })
            .unwrap_or(true)
    }

    /// The newest audit-log timestamp: the clock anchor of the licence check
    /// (TZ.md 13.6). Read here rather than taken from the webview, so a
    /// modified script cannot hold it back. KADRA has no sync between
    /// computers, so every row in the journal was written on this one.
    pub fn newest_audit_time(&self) -> Option<String> {
        self.lock()
            .query_row("SELECT max(ts) FROM audit_log", [], |row| {
                row.get::<_, Option<String>>(0)
            })
            .ok()
            .flatten()
    }

    /// Rows of a read statement, in any mode.
    pub fn select(&self, sql: &str, params: &[Value]) -> Result<Vec<Row>, DbError> {
        let values = bind_values(params)?;
        single_statement(sql)?;
        let conn = self.lock();
        let mut statement = conn.prepare(sql)?;
        guard::check_read(sql, &statement)?;
        collect_rows(&mut statement, &values)
    }

    /// A single statement; refused by the guard when writes are not allowed.
    pub fn execute(&self, sql: &str, params: &[Value]) -> Result<(), DbError> {
        let values = bind_values(params)?;
        single_statement(sql)?;
        let conn = self.lock();
        let mut statement = conn.prepare(sql)?;
        self.guard.check_write(sql, &statement)?;
        drain(&mut statement, &values)
    }

    /// Several statements as one atomic unit: all of them or none.
    pub fn transaction(&self, statements: &[SqlStatement]) -> Result<(), DbError> {
        let batch = statements
            .iter()
            .map(|statement| {
                single_statement(&statement.sql)?;
                Ok((statement.sql.as_str(), bind_values(&statement.params)?))
            })
            .collect::<Result<Vec<_>, DbError>>()?;

        let mut conn = self.lock();
        let tx = conn.transaction()?;
        for (sql, values) in &batch {
            let mut statement = tx.prepare(sql)?;
            self.guard.check_write(sql, &statement)?;
            drain(&mut statement, values)?;
        }
        // Any early return above drops `tx`, which rolls it back.
        tx.commit()?;
        Ok(())
    }

    /// A complete, consistent copy of the database.
    ///
    /// The main file alone is not one: in WAL mode the latest commits live in
    /// the `-wal` file until a checkpoint, so copying the database file would silently
    /// drop them. VACUUM INTO writes a self-contained copy instead.
    pub fn serialize(&self) -> Result<Vec<u8>, DbError> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let target = std::env::temp_dir().join(format!(
            "kadra-export-{}-{stamp}-{}.db",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));

        let written = {
            let conn = self.lock();
            conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])
        };
        let result = written
            .map_err(DbError::from)
            .and_then(|_| fs::read(&target).map_err(DbError::from));
        // A copy of the books must not be left behind in the temp directory.
        let _ = fs::remove_file(&target);
        result
    }
}

/// rusqlite compiles the first statement of a string and silently drops the
/// rest, so "INSERT ...; UPDATE ..." would half-run without an error. Such
/// input is refused instead.
fn single_statement(sql: &str) -> Result<(), DbError> {
    if schema::split_statements(sql).len() > 1 {
        return Err(DbError::BadParam("one SQL statement per call".into()));
    }
    Ok(())
}

pub(crate) fn bind_values(params: &[Value]) -> Result<Vec<SqlValue>, DbError> {
    params
        .iter()
        .map(|param| match param {
            Value::Null => Ok(SqlValue::Null),
            Value::Bool(flag) => Ok(SqlValue::Integer(i64::from(*flag))),
            Value::Number(number) => number
                .as_i64()
                .map(SqlValue::Integer)
                .or_else(|| number.as_f64().map(SqlValue::Real))
                .ok_or_else(|| DbError::BadParam(number.to_string())),
            Value::String(text) => Ok(SqlValue::Text(text.clone())),
            other => Err(DbError::BadParam(format!("unsupported value {other}"))),
        })
        .collect()
}

fn collect_rows(statement: &mut Statement, values: &[SqlValue]) -> Result<Vec<Row>, DbError> {
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(String::from)
        .collect();
    let mut rows = statement.query(params_from_iter(values))?;
    let mut out = Vec::new();

    while let Some(row) = rows.next()? {
        let mut object = Map::with_capacity(names.len());
        for (index, name) in names.iter().enumerate() {
            object.insert(name.clone(), to_json(row.get_ref(index)?));
        }
        out.push(object);
    }

    Ok(out)
}

/// Runs a statement to completion, discarding any rows it returns. Unlike
/// `Statement::execute` this accepts statements that answer with a row, as
/// the plugin did.
fn drain(statement: &mut Statement, values: &[SqlValue]) -> Result<(), DbError> {
    let mut rows = statement.query(params_from_iter(values))?;
    while rows.next()?.is_some() {}
    Ok(())
}

fn to_json(value: ValueRef) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::from(number),
        // NaN and infinities have no JSON form.
        ValueRef::Real(number) => Number::from_f64(number).map_or(Value::Null, Value::Number),
        ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Value::from(bytes.to_vec()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn statement(sql: &str, params: Vec<Value>) -> SqlStatement {
        SqlStatement {
            sql: sql.into(),
            params,
        }
    }

    /// The tests write to a table of their own, so the seed's rows in the
    /// real tables do not get in the way of counting.
    fn with_notes(db: &Database) {
        db.execute("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, amount REAL, note TEXT)", &[])
            .unwrap();
    }

    fn insert_note(db: &Database, id: &str) -> Result<(), DbError> {
        db.execute(
            "INSERT INTO notes (id, title, amount) VALUES (?, ?, ?)",
            &[json!(id), json!("Приказ"), json!(1500.75)],
        )
    }

    // On an empty data directory the database is created, migrated, seeded,
    // and SELECT works.
    #[test]
    fn creates_the_database_in_an_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-yet").join(DATABASE_FILE);

        let db = Database::open(&path).unwrap();

        assert!(path.exists());
        let version = db
            .select("SELECT max(version) AS v FROM _migrations", &[])
            .unwrap();
        assert_eq!(version[0]["v"], json!(schema::schema_version()));
        assert!(!db
            .select("SELECT * FROM employees", &[])
            .unwrap()
            .is_empty());
        assert!(db.is_empty(), "no owner yet");
        // Asked directly: the guard rightly treats this pragma as able to write.
        let mode: String = db
            .lock()
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
    }

    // The regression the move must not introduce: an existing installation
    // opens its own data, not a fresh empty database.
    #[test]
    fn reopens_an_existing_database_with_its_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);

        {
            let db = Database::open(&path).unwrap();
            db.execute("DELETE FROM employees", &[]).unwrap();
            db.execute(
                "INSERT INTO users (id, email, password_hash, role, name) VALUES ('1', 'o@x', 'h', 'ADMIN', 'O')",
                &[],
            )
            .unwrap();
        }

        let reopened = Database::open(&path).unwrap();
        assert!(
            reopened
                .select("SELECT id FROM employees", &[])
                .unwrap()
                .is_empty(),
            "not reseeded"
        );
        assert!(!reopened.is_empty());
    }

    // A database the old tauri-plugin-sql build wrote, copied together with
    // its -wal file:
    //   KDR_REAL_DB=%APPDATA%\com.kadra.local\local-hr-docs.db cargo test -- --ignored
    // The original is never opened.
    #[test]
    #[ignore]
    fn opens_a_copy_of_a_real_database_without_losing_rows() {
        let source = PathBuf::from(std::env::var("KDR_REAL_DB").expect("set KDR_REAL_DB"));
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join(DATABASE_FILE);
        fs::copy(&source, &copy).unwrap();
        for suffix in ["-wal", "-shm"] {
            let side = PathBuf::from(format!("{}{suffix}", source.display()));
            if side.exists() {
                fs::copy(&side, dir.path().join(format!("{DATABASE_FILE}{suffix}"))).unwrap();
            }
        }

        let count_rows = |conn: &Connection| -> Vec<(String, i64)> {
            let tables: Vec<String> = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            tables
                .into_iter()
                .map(|t| {
                    let n = conn
                        .query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
                        .unwrap();
                    (t, n)
                })
                .collect()
        };

        let before = count_rows(&Connection::open(&copy).unwrap());
        let db = Database::open(&copy).unwrap();
        let after = count_rows(&db.lock());

        for (table, rows) in &before {
            let now = after.iter().find(|(t, _)| t == table).map(|(_, n)| *n);
            assert_eq!(now, Some(*rows), "rows in {table}");
        }
        let total: i64 = before.iter().map(|(_, n)| n).sum();
        println!("{} tables, {total} rows, all kept", before.len());
    }

    #[test]
    fn values_round_trip_with_their_types() {
        let db = Database::open_in_memory().unwrap();
        with_notes(&db);
        insert_note(&db, "a1").unwrap();
        db.execute(
            "UPDATE notes SET note = ? WHERE id = ?",
            &[Value::Null, json!("a1")],
        )
        .unwrap();

        let rows = db
            .select(
                "SELECT id, amount, note, 2 AS n FROM notes WHERE id = ?",
                &[json!("a1")],
            )
            .unwrap();
        assert_eq!(rows[0]["amount"], json!(1500.75));
        assert_eq!(rows[0]["note"], Value::Null);
        assert_eq!(rows[0]["n"], json!(2));
    }

    #[test]
    fn select_refuses_anything_but_reads() {
        let db = Database::open_in_memory().unwrap();
        with_notes(&db);

        for sql in [
            "INSERT INTO notes (id, title) VALUES ('x', 'x')",
            "DELETE FROM notes",
            "WITH gone AS (SELECT 1) DELETE FROM notes",
            "PRAGMA user_version = 99",
            "PRAGMA foreign_keys = OFF",
            "PRAGMA foreign_keys(0)",
            "BEGIN",
            "VACUUM INTO 'elsewhere.db'",
            "ATTACH DATABASE ':memory:' AS other",
        ] {
            assert!(
                matches!(db.select(sql, &[]), Err(DbError::Denied(_))),
                "{sql} was accepted by select"
            );
        }

        // A second statement cannot be smuggled in after a read, nor after a
        // write.
        insert_note(&db, "a1").unwrap();
        assert!(db.select("SELECT 1; DELETE FROM notes", &[]).is_err());
        assert!(db.execute("SELECT 1; DELETE FROM notes", &[]).is_err());
        assert_eq!(db.select("SELECT id FROM notes", &[]).unwrap().len(), 1);
        db.select("SELECT 1;", &[]).unwrap();

        for sql in [
            "SELECT count(*) FROM notes",
            "  -- comment\n SELECT 1",
            "WITH a AS (SELECT 1 AS x) SELECT x FROM a",
            "PRAGMA user_version",
            "PRAGMA table_info(notes)",
            "PRAGMA main.table_info(notes)",
        ] {
            db.select(sql, &[])
                .unwrap_or_else(|e| panic!("{sql} refused: {e}"));
        }
    }

    #[test]
    fn transaction_rolls_back_as_a_whole() {
        let db = Database::open_in_memory().unwrap();
        with_notes(&db);

        let result = db.transaction(&[
            statement(
                "INSERT INTO notes (id, title) VALUES (?, 'Плохой')",
                vec![json!("bad")],
            ),
            statement("INSERT INTO no_such_table (id) VALUES (1)", vec![]),
        ]);

        assert!(result.is_err());
        assert!(db
            .select("SELECT id FROM notes WHERE id = 'bad'", &[])
            .unwrap()
            .is_empty());

        // The connection is usable afterwards: no transaction left open.
        db.transaction(&[statement(
            "INSERT INTO notes (id, title) VALUES ('ok', 'x')",
            vec![],
        )])
        .unwrap();
        assert_eq!(db.select("SELECT id FROM notes", &[]).unwrap().len(), 1);
    }

    #[test]
    fn serialize_includes_commits_still_in_the_wal() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join(DATABASE_FILE)).unwrap();
        with_notes(&db);
        insert_note(&db, "fresh").unwrap();

        let bytes = db.serialize().unwrap();

        let copy = dir.path().join("copy.db");
        fs::write(&copy, &bytes).unwrap();
        let conn = Connection::open(&copy).unwrap();
        let id: String = conn
            .query_row("SELECT id FROM notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(id, "fresh");
    }

    // The guard in READ_ONLY: reads pass, writes do not.
    #[test]
    fn read_only_mode_refuses_writes_and_keeps_reads() {
        let db = Database::open_in_memory().unwrap();
        with_notes(&db);
        insert_note(&db, "a1").unwrap();
        db.guard().set_mode(Mode::ReadOnly);

        assert!(matches!(insert_note(&db, "a2"), Err(DbError::Denied(_))));
        assert!(matches!(
            db.transaction(&[statement("DELETE FROM notes", vec![])]),
            Err(DbError::Denied(_))
        ));
        assert!(matches!(
            db.execute("CREATE TABLE sneaky (id TEXT)", &[]),
            Err(DbError::Denied(_))
        ));
        assert_eq!(db.select("SELECT id FROM notes", &[]).unwrap().len(), 1);
        assert!(!db.serialize().unwrap().is_empty());

        db.guard().set_mode(Mode::Full);
        insert_note(&db, "a2").unwrap();
    }

    #[test]
    fn the_clock_anchor_is_the_newest_journal_row() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.newest_audit_time(), None);
        for ts in ["2026-10-01T09:00:00.000Z", "2026-10-05T12:00:00.000Z"] {
            db.execute(
                "INSERT INTO audit_log (id, ts, action, entity) VALUES (?, ?, 'login', 'auth')",
                &[json!(ts), json!(ts)],
            )
            .unwrap();
        }
        assert_eq!(
            db.newest_audit_time().as_deref(),
            Some("2026-10-05T12:00:00.000Z")
        );
    }
}
