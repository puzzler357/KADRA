//! Migrations and the first-run seed, applied as the database opens.
//!
//! The same steps the web build runs from `src/db/migrate.ts`, read from
//! `src-tauri/schema.json`, which `npm run schema:export` builds from
//! `src/data/schema.ts`, `entities.ts` and `seedData.ts` (a unit test fails
//! when the file is stale). So the two builds can only disagree in the
//! runner, never in the schema.
//!
//! This runs here, before any licence mode exists and outside `guard.rs`:
//! creating tables and seeding are writes, and if READ_ONLY had to let them
//! through from the webview it would have to let everything through.

use std::sync::OnceLock;

use chrono::{SecondsFormat, Utc};
use rusqlite::{params_from_iter, Connection};
use serde::Deserialize;
use serde_json::Value;

use super::{bind_values, DbError};

const SCHEMA_SOURCE: &str = include_str!("../../schema.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSchema {
    #[cfg_attr(not(test), allow(dead_code))]
    pub latest: i64,
    pub migrations_table_sql: String,
    pub migrations: Vec<Migration>,
    pub seed: Seed,
}

#[derive(Debug, Deserialize)]
pub struct Migration {
    pub version: i64,
    pub name: String,
    pub steps: Vec<Step>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Step {
    Sql {
        sql: String,
    },
    /// Skipped when the column is already there: databases created before
    /// migrations existed reach the current version without errors.
    AddColumn {
        table: String,
        column: String,
        definition: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct Seed {
    pub flag: String,
    pub batches: Vec<SeedBatch>,
}

#[derive(Debug, Deserialize)]
pub struct SeedBatch {
    pub sql: String,
    pub rows: Vec<Vec<Value>>,
}

/// A malformed schema.json is a build defect; the tests parse it before any
/// release does.
pub fn schema() -> &'static DesktopSchema {
    static SCHEMA: OnceLock<DesktopSchema> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(SCHEMA_SOURCE).unwrap_or_else(|e| panic!("schema.json: {e}"))
    })
}

#[cfg(test)]
pub fn schema_version() -> i64 {
    schema().latest
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, DbError> {
    let mut info = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = info.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn count(conn: &Connection, table: &str) -> Result<i64, DbError> {
    Ok(
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })?,
    )
}

/// Brings the database to the latest version, then seeds it once.
pub fn apply(conn: &Connection) -> Result<(), DbError> {
    let schema = schema();
    conn.execute_batch(&schema.migrations_table_sql)?;

    let applied: i64 = conn.query_row(
        "SELECT coalesce(max(version), 0) FROM _migrations",
        [],
        |row| row.get(0),
    )?;

    for migration in schema.migrations.iter().filter(|m| m.version > applied) {
        // Each migration whole or not at all: a step that fails half-way must
        // not leave the version recorded.
        let tx = conn.unchecked_transaction()?;
        for step in &migration.steps {
            match step {
                Step::Sql { sql } => tx.execute_batch(sql)?,
                Step::AddColumn {
                    table,
                    column,
                    definition,
                } => {
                    if !has_column(&tx, table, column)? {
                        tx.execute_batch(&format!(
                            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
                        ))?;
                    }
                }
            }
        }
        tx.execute(
            "INSERT INTO _migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![migration.version, migration.name, now_iso()],
        )?;
        tx.commit()?;
    }

    seed_once(conn, &schema.seed)
}

/// The seed runs once in the life of a database. Without the mark in `meta`
/// a reset would be pointless: the demo rows would be back on the next start.
/// A database that already holds people (an upgrade from an older schema)
/// only gets the mark. The owner's account is never seeded.
fn seed_once(conn: &Connection, seed: &Seed) -> Result<(), DbError> {
    let seeded: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1)",
        [&seed.flag],
        |row| row.get(0),
    )?;
    if seeded {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;
    if count(&tx, "users")? == 0 && count(&tx, "employees")? == 0 {
        for batch in &seed.batches {
            let mut statement = tx.prepare(&batch.sql)?;
            for row in &batch.rows {
                statement.execute(params_from_iter(bind_values(row)?))?;
            }
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        rusqlite::params![seed.flag, now_iso()],
    )?;
    tx.commit()?;
    Ok(())
}

/// Splits SQL text into statements, ignoring `;` inside quotes and comments.
/// Used to refuse a second statement smuggled into one `db_*` call.
pub fn split_statements(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];

        if let Some(open) = quote {
            current.push(ch);
            if ch == open {
                // '' and "" are escaped quotes inside a literal.
                if chars.get(i + 1) == Some(&open) {
                    current.push(open);
                    i += 1;
                } else {
                    quote = None;
                }
            }
            i += 1;
            continue;
        }

        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.push(ch);
            i += 1;
            continue;
        }

        if ch == '-' && chars.get(i + 1) == Some(&'-') {
            match chars[i..].iter().position(|&c| c == '\n') {
                Some(offset) => {
                    current.push('\n');
                    i += offset + 1;
                    continue;
                }
                None => break,
            }
        }

        if ch == '/' && chars.get(i + 1) == Some(&'*') {
            match chars[i + 2..]
                .windows(2)
                .position(|pair| pair == ['*', '/'])
            {
                Some(offset) => {
                    i += 2 + offset + 2;
                    continue;
                }
                None => break,
            }
        }

        if ch == ';' {
            statements.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
        i += 1;
    }

    statements.push(current);
    statements
        .into_iter()
        .map(|statement| statement.trim().to_string())
        .filter(|statement| !statement.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tables(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn schema_json_parses_and_is_complete() {
        let schema = schema();
        assert_eq!(schema.migrations.last().unwrap().version, schema.latest);
        assert!(!schema.seed.batches.is_empty());
    }

    #[test]
    fn a_fresh_database_gets_every_table_and_the_seed() {
        let conn = Connection::open_in_memory().unwrap();
        apply(&conn).unwrap();

        let names = tables(&conn);
        for table in [
            "users",
            "employees",
            "audit_log",
            "movements",
            "meta",
            "_migrations",
        ] {
            assert!(names.iter().any(|n| n == table), "no table {table}");
        }
        let version: i64 = conn
            .query_row("SELECT max(version) FROM _migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, schema_version());
        assert!(count(&conn, "employees").unwrap() > 0);
        assert_eq!(
            count(&conn, "users").unwrap(),
            0,
            "the owner is never seeded"
        );
    }

    #[test]
    fn applying_twice_changes_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        apply(&conn).unwrap();
        conn.execute("DELETE FROM employees", []).unwrap();
        apply(&conn).unwrap();
        // The seed does not come back after a reset.
        assert_eq!(count(&conn, "employees").unwrap(), 0);
    }

    // A database from before migrations: tables exist, some columns do not.
    #[test]
    fn an_old_database_is_brought_up_to_date_and_not_reseeded() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE employees (id TEXT PRIMARY KEY, full_name TEXT NOT NULL, position TEXT NOT NULL,
               department TEXT NOT NULL, status TEXT NOT NULL, hire_date TEXT NOT NULL, salary REAL DEFAULT 0);
             INSERT INTO employees VALUES ('x', 'Старый', 'p', 'd', 'active', '2020-01-01', 5);",
        )
        .unwrap();

        apply(&conn).unwrap();

        assert!(has_column(&conn, "employees", "tab_number").unwrap());
        assert!(has_column(&conn, "employees", "rate").unwrap());
        assert_eq!(count(&conn, "employees").unwrap(), 1);
    }

    #[test]
    fn statements_split_outside_quotes_and_comments() {
        let parts = split_statements("SELECT ';'; -- a; comment\nSELECT 2 /* ; */;");
        assert_eq!(
            parts,
            vec!["SELECT ';'".to_string(), "SELECT 2".to_string()]
        );
        assert_eq!(split_statements("SELECT 1;").len(), 1);
    }
}
