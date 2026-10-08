/**
 * The licence server's database (10.1): SQLite through the built-in
 * node:sqlite, so the server has no native dependency to build on the VPS.
 * The same file is the console utility's journal - moving from the utility to
 * the server is copying one file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PLANS } from './core/rules.ts';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  contact    TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  code                   TEXT PRIMARY KEY,
  term_months            INTEGER,
  lease_days_online      INTEGER NOT NULL,
  refresh_after_days     INTEGER NOT NULL,
  grace_days             INTEGER NOT NULL,
  warn_lease_days        INTEGER NOT NULL,
  warn_paid_days         INTEGER NOT NULL,
  clock_tolerance_hours  INTEGER NOT NULL,
  max_transfers_per_year INTEGER NOT NULL,
  allowed_modes          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id              TEXT PRIMARY KEY,
  key_hash        TEXT UNIQUE,
  customer_id     TEXT NOT NULL REFERENCES customers (id),
  plan            TEXT NOT NULL REFERENCES plans (code),
  activation_mode TEXT NOT NULL,
  seats           INTEGER NOT NULL,
  edition         TEXT NOT NULL DEFAULT '',
  features        TEXT NOT NULL DEFAULT '[]',
  paid_until      TEXT,
  grace_days      INTEGER NOT NULL,
  max_version     TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_customer ON licenses (customer_id);

CREATE TABLE IF NOT EXISTS activations (
  id               TEXT PRIMARY KEY,
  license_id       TEXT NOT NULL REFERENCES licenses (id),
  device_name      TEXT NOT NULL,
  fp               TEXT NOT NULL,
  device_pubkey    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ACTIVE',
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  last_counter     INTEGER NOT NULL DEFAULT 0,
  current_revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_activations_license ON activations (license_id, status);

CREATE TABLE IF NOT EXISTS issued_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id    TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  issued_at     TEXT NOT NULL,
  paid_until    TEXT,
  lease_until   TEXT,
  sha256        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issued_activation ON issued_files (activation_id, revision);

CREATE TABLE IF NOT EXISTS transfers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id         TEXT NOT NULL,
  from_activation_id TEXT NOT NULL,
  to_activation_id   TEXT,
  at                 TEXT NOT NULL,
  method             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_license ON transfers (license_id, at);

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id  TEXT NOT NULL,
  amount      REAL,
  currency    TEXT,
  period_from TEXT,
  period_to   TEXT NOT NULL,
  source      TEXT NOT NULL,
  external_id TEXT,
  paid_on     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- A payment system reports each payment once, but retries on any doubt: the
-- same payment id from the same webhook source must renew only once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_webhook_once
  ON payments (source, external_id) WHERE source LIKE 'webhook:%';

-- Senders of payment webhooks (stage 6). The secret signs their requests;
-- it is stored because verifying an HMAC needs it.
CREATE TABLE IF NOT EXISTS webhook_sources (
  name       TEXT PRIMARY KEY,
  secret     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  last_used  TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'info',
  license_id    TEXT,
  activation_id TEXT,
  details       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_at ON events (at);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events (severity, at);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  username        TEXT PRIMARY KEY,
  password_hash   TEXT NOT NULL,
  totp_secret     TEXT NOT NULL,
  totp_last_step  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  username   TEXT NOT NULL REFERENCES admins (username),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  // Plans are seeded once and then belong to the owner: a later edit of the
  // defaults in code must not overwrite a changed grace period in production.
  const insertPlan = db.prepare(`INSERT OR IGNORE INTO plans (code, term_months, lease_days_online,
    refresh_after_days, grace_days, warn_lease_days, warn_paid_days, clock_tolerance_hours,
    max_transfers_per_year, allowed_modes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const plan of DEFAULT_PLANS) {
    insertPlan.run(plan.code, plan.term_months, plan.lease_days_online, plan.refresh_after_days,
      plan.grace_days, plan.warn_lease_days, plan.warn_paid_days, plan.clock_tolerance_hours,
      plan.max_transfers_per_year, plan.allowed_modes.join(','));
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

const depth = new WeakMap<Db, number>();

/**
 * Runs `work` in one transaction: an issued file and its journal row land
 * together or not at all. Re-entrant - an operation that already runs inside
 * one (processing a request that releases a seat) joins it instead of failing
 * on a nested BEGIN.
 */
export function inTransaction<T>(db: Db, work: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) {
    depth.set(db, level + 1);
    try {
      return work();
    } finally {
      depth.set(db, level);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    depth.set(db, 0);
  }
}

/** The next value of a named sequence, for readable ids like KDR-2026-000017. */
export function nextValue(db: Db, name: string): number {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = value + 1')
    .run(name);
  return Number((db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as { value: number }).value);
}
