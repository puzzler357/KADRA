//! Decides which statements may reach the database.
//!
//! This is the boundary the licence check leans on. The webview bundle can be
//! extracted and edited, so whatever the UI does to hide buttons, a modified
//! script can still call `db_execute` directly. The decision is therefore made
//! here, from the mode Rust holds and from what SQLite itself says about the
//! statement - never from anything the caller passes in.
//!
//! Two rules:
//!
//! - `db_select` runs read statements only, in every mode. Without that, the
//!   read command would be an unguarded write path.
//! - `db_execute` and `db_transaction` run anything in FULL mode, and in
//!   READ_ONLY only what `db_select` would accept.
//!
//! Schema application and repair do not pass through here: they run in
//! `schema.rs` before any mode is computed, which is what lets READ_ONLY open a
//! database at all.

use std::sync::atomic::{AtomicU8, Ordering};

use rusqlite::Statement;

use super::DbError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Full,
    ReadOnly,
}

impl Mode {
    fn to_u8(self) -> u8 {
        match self {
            Mode::Full => 0,
            Mode::ReadOnly => 1,
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            0 => Mode::Full,
            // Anything unexpected fails closed.
            _ => Mode::ReadOnly,
        }
    }
}

pub struct Guard {
    mode: AtomicU8,
}

impl Guard {
    pub fn new(mode: Mode) -> Self {
        Self {
            mode: AtomicU8::new(mode.to_u8()),
        }
    }

    pub fn mode(&self) -> Mode {
        Mode::from_u8(self.mode.load(Ordering::SeqCst))
    }

    /// Only Rust calls this - no command takes a mode from the webview; the
    /// licence manager does, on every status change.
    pub fn set_mode(&self, mode: Mode) {
        self.mode.store(mode.to_u8(), Ordering::SeqCst);
    }

    /// Gate for `db_execute` and each statement of `db_transaction`.
    pub fn check_write(&self, sql: &str, statement: &Statement) -> Result<(), DbError> {
        match self.mode() {
            Mode::Full => Ok(()),
            Mode::ReadOnly => check_read(sql, statement).map_err(|_| {
                DbError::Denied("the database is read-only in the current licence mode".into())
            }),
        }
    }
}

/// Pragmas that take an argument in parentheses and only report on the schema.
/// The same form also sets values (`PRAGMA foreign_keys(0)`), so anything not
/// listed here is refused.
const QUERY_PRAGMAS: &[&str] = &[
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "foreign_key_check",
    "integrity_check",
    "quick_check",
];

/// Gate for `db_select`, and for writes in READ_ONLY.
///
/// SQLite's own verdict (`sqlite3_stmt_readonly`) is necessary but not enough:
/// it also calls BEGIN, ATTACH and VACUUM INTO read-only, because they leave
/// the main database file untouched - yet VACUUM INTO writes a file anywhere
/// on disk, and an open BEGIN would wedge every later transaction. So the
/// statement must also start with a read keyword.
pub fn check_read(sql: &str, statement: &Statement) -> Result<(), DbError> {
    let refuse = || {
        Err(DbError::Denied(
            "only read statements are accepted here".into(),
        ))
    };

    if !statement.readonly() {
        return refuse();
    }

    let text = strip_leading_comments(sql);
    let keyword = leading_word(text).to_ascii_uppercase();

    match keyword.as_str() {
        "SELECT" | "WITH" => Ok(()),
        "PRAGMA" => {
            let rest = text[keyword.len()..].trim_start();
            if rest.contains('=') {
                return refuse();
            }
            if rest.contains('(') {
                let name = leading_word(rest).to_ascii_lowercase();
                // "main.table_info(x)" names a schema first.
                let name = name.rsplit('.').next().unwrap_or("");
                if !QUERY_PRAGMAS.contains(&name) {
                    return refuse();
                }
            }
            Ok(())
        }
        _ => refuse(),
    }
}

fn strip_leading_comments(mut sql: &str) -> &str {
    loop {
        sql = sql.trim_start();
        if let Some(rest) = sql.strip_prefix("--") {
            sql = rest.find('\n').map_or("", |end| &rest[end + 1..]);
        } else if let Some(rest) = sql.strip_prefix("/*") {
            sql = rest.find("*/").map_or("", |end| &rest[end + 2..]);
        } else {
            return sql;
        }
    }
}

fn leading_word(text: &str) -> &str {
    let end = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
        .unwrap_or(text.len());
    &text[..end]
}
