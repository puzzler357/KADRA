/**
 * Единственное описание схемы базы и её миграций.
 *
 * До этого DDL был записан дважды — в src/db/sqlite.ts для веб-режима и в
 * src/data/tauriDb.ts для нативного, — и любое изменение приходилось вносить
 * в оба места, надеясь не забыть. Теперь оба слоя берут DDL отсюда.
 *
 * Миграции версионированы и лежат в MIGRATIONS. Применённые версии
 * записываются в служебную таблицу _migrations, поэтому добавление колонки
 * больше не живёт внутри try/catch в расчёте на то, что ошибку можно
 * проигнорировать.
 */
import { allSchemaSql } from './entities';

/** Шаг миграции. */
export type MigrationStep =
  | { kind: 'sql'; sql: string }
  /**
   * Добавление колонки. Отдельный вид шага, а не сырой ALTER: перед
   * выполнением исполнитель смотрит PRAGMA table_info и пропускает шаг,
   * если колонка уже есть. Так базы, созданные до появления миграций,
   * доживают до текущей версии без ошибок и без глушения исключений.
   */
  | { kind: 'addColumn'; table: string; column: string; definition: string };

export interface Migration {
  version: number;
  name: string;
  steps: MigrationStep[];
}

const sql = (statement: string): MigrationStep => ({ kind: 'sql', sql: statement });

// --- Базовые таблицы. Сущности экранов описаны в entities.ts и подключаются
// --- ниже через allSchemaSql(): у них DDL генерируется из описания колонок.
const CORE_TABLES = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    position TEXT NOT NULL,
    department TEXT NOT NULL,
    status TEXT NOT NULL,
    hire_date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT
  );

  CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    department_id TEXT NOT NULL,
    title TEXT NOT NULL,
    max_count INTEGER NOT NULL,
    salary REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    blocks TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS timesheets (
    id TEXT PRIMARY KEY,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    employee_id TEXT NOT NULL,
    days TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS archives (
    id TEXT PRIMARY KEY,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    employee_id TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    department TEXT NOT NULL,
    position TEXT NOT NULL,
    salary REAL NOT NULL,
    hours_worked REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const CORE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
  CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);
  CREATE INDEX IF NOT EXISTS idx_timesheets_period ON timesheets(year, month);
  CREATE INDEX IF NOT EXISTS idx_timesheets_employee ON timesheets(employee_id);
  CREATE INDEX IF NOT EXISTS idx_archives_year ON archives(year);
  CREATE INDEX IF NOT EXISTS idx_archives_employee ON archives(employee_id);
  CREATE INDEX IF NOT EXISTS idx_archives_department ON archives(department);
  CREATE INDEX IF NOT EXISTS idx_positions_department ON positions(department_id);
  CREATE INDEX IF NOT EXISTS idx_departments_parent ON departments(parent_id);
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-tables',
    steps: [sql(CORE_TABLES)],
  },
  {
    version: 2,
    name: 'employee-details',
    steps: [
      { kind: 'addColumn', table: 'employees', column: 'birth_date', definition: 'TEXT' },
      { kind: 'addColumn', table: 'employees', column: 'payment_type', definition: "TEXT DEFAULT 'salary'" },
      { kind: 'addColumn', table: 'employees', column: 'salary', definition: 'REAL DEFAULT 0' },
      { kind: 'addColumn', table: 'employees', column: 'rate', definition: 'REAL DEFAULT 1' },
    ],
  },
  {
    version: 3,
    name: 'employee-tab-number',
    steps: [
      { kind: 'addColumn', table: 'employees', column: 'tab_number', definition: 'TEXT' },
    ],
  },
  {
    version: 4,
    name: 'core-indexes',
    steps: [sql(CORE_INDEXES)],
  },
  {
    version: 5,
    name: 'screen-entities',
    // Таблицы экранов подбора, отпусков, онбординга, оценки, базы знаний,
    // кадровых движений, журнала аудита, наборов отчётов и копий.
    steps: [sql(allSchemaSql(5))],
  },
  {
    version: 6,
    name: 'owner-require-password',
    // Запрос пароля при входе жил в localStorage окна: очистка данных
    // браузера или WebView молча выключала его. Теперь это свойство учётной
    // записи и хранится вместе с ней.
    steps: [
      { kind: 'addColumn', table: 'users', column: 'require_password', definition: 'INTEGER NOT NULL DEFAULT 0' },
    ],
  },
  {
    version: 7,
    name: 'employee-dismissal-date',
    // Дата увольнения: без неё табель засчитывал уволенному дни после ухода.
    steps: [
      { kind: 'addColumn', table: 'employees', column: 'dismissal_date', definition: 'TEXT' },
    ],
  },
  {
    version: 8,
    name: 'staffing-revisions-review-cycles',
    // Редакции штатного расписания и циклы оценки 360°.
    steps: [sql(allSchemaSql(8))],
  },
  {
    version: 9,
    name: 'movement-employee-name',
    // ФИО в журнале кадровых операций: после удаления карточки приказ
    // показывал «—» вместо фамилии.
    steps: [
      { kind: 'addColumn', table: 'movements', column: 'employee_name', definition: 'TEXT' },
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

/** Миграции, которые ещё не применены к базе с указанной версией. */
export function pendingMigrations(appliedVersion: number): Migration[] {
  return MIGRATIONS.filter((m) => m.version > appliedVersion);
}
