/**
 * Описание таблиц, добавленных при переводе макетных экранов на реальные данные.
 *
 * Схема в проекте задана дважды — в src/db/sqlite.ts для веб-режима и в
 * src/data/tauriDb.ts для нативного. Дублировать руками ещё семь таблиц значило
 * бы гарантировать расхождение между ветками, поэтому новые сущности описаны
 * здесь один раз, а DDL, маппинг колонок и CRUD генерируются из описания.
 *
 * Старые семь таблиц намеренно оставлены как есть: их переезд сюда — отдельная
 * задача (устранение дублирования схемы), и смешивать её с переводом экранов
 * на БД не стоит.
 */

export type ColumnKind = 'text' | 'number' | 'bool';

export interface ColumnDef {
  /** Имя поля в API и в типах (camelCase). */
  field: string;
  /** Имя колонки в SQLite (snake_case). */
  column: string;
  /** Тип колонки в DDL. */
  sql: string;
  /** Как значение выглядит в приложении. SQLite не знает булевых — хранит 0/1. */
  kind?: ColumnKind;
}

export interface EntityDef {
  /** Таблица в SQLite. */
  table: string;
  /** Сегмент REST-маршрута: /api/<route>. */
  route: string;
  /** Колонки без id — он есть у всех и обрабатывается отдельно. */
  columns: ColumnDef[];
  /** ORDER BY при чтении списка. */
  orderBy?: string;
  /** Имя массива в useDatabaseStore. */
  stateKey: string;
  /**
   * Таблица наполняется работой приложения, а не посевом: журнал аудита
   * пишется сам, наборы конструктора создаёт пользователь. Выдуманные записи
   * здесь были бы ложью о том, что происходило в системе.
   */
  selfFilling?: boolean;
  /**
   * Версия миграции, в которой таблица появилась. Первые одиннадцать таблиц
   * созданы миграцией 5; каждая следующая получает свою миграцию, иначе в
   * уже работающих базах её никто не создал бы.
   */
  since?: number;
}

const text = (field: string, column: string, notNull = true): ColumnDef =>
  ({ field, column, sql: notNull ? 'TEXT NOT NULL' : 'TEXT' });

const num = (field: string, column: string, def = 0): ColumnDef =>
  ({ field, column, sql: `REAL NOT NULL DEFAULT ${def}`, kind: 'number' });

const int = (field: string, column: string, def = 0): ColumnDef =>
  ({ field, column, sql: `INTEGER NOT NULL DEFAULT ${def}`, kind: 'number' });

const bool = (field: string, column: string): ColumnDef =>
  ({ field, column, sql: 'INTEGER NOT NULL DEFAULT 0', kind: 'bool' });

export const ENTITIES: EntityDef[] = [
  {
    table: 'candidates',
    stateKey: 'candidates',
    route: 'candidates',
    orderBy: 'created_at DESC',
    columns: [
      text('fullName', 'full_name'),
      text('position', 'position'),
      text('experience', 'experience', false),
      text('status', 'status'),
      text('createdAt', 'created_at'),
      text('note', 'note', false),
    ],
  },
  {
    table: 'time_off_requests',
    stateKey: 'timeOffRequests',
    route: 'time-off',
    orderBy: 'date_from DESC',
    columns: [
      text('employeeId', 'employee_id'),
      text('type', 'type'),
      text('dateFrom', 'date_from'),
      text('dateTo', 'date_to'),
      int('days', 'days'),
      text('status', 'status'),
      text('comment', 'comment', false),
    ],
  },
  {
    table: 'checklist_tasks',
    stateKey: 'checklistTasks',
    route: 'checklist-tasks',
    orderBy: 'order_index ASC',
    columns: [
      text('employeeId', 'employee_id'),
      // onboarding | offboarding
      text('kind', 'kind'),
      text('title', 'title'),
      text('assignee', 'assignee', false),
      bool('done', 'done'),
      text('comment', 'comment', false),
      int('orderIndex', 'order_index'),
    ],
  },
  {
    table: 'goals',
    stateKey: 'goals',
    route: 'goals',
    orderBy: 'period DESC',
    columns: [
      text('employeeId', 'employee_id'),
      text('title', 'title'),
      int('progress', 'progress'),
      text('status', 'status'),
      text('period', 'period'),
    ],
  },
  {
    table: 'reviews',
    stateKey: 'reviews',
    route: 'reviews',
    orderBy: 'period DESC',
    columns: [
      text('employeeId', 'employee_id'),
      text('reviewer', 'reviewer'),
      text('period', 'period'),
      num('score', 'score'),
      text('comment', 'comment', false),
    ],
  },
  {
    table: 'movements',
    stateKey: 'movements',
    route: 'movements',
    orderBy: 'date DESC',
    columns: [
      text('employeeId', 'employee_id'),
      // hire | transfer | dismissal
      text('type', 'type'),
      text('date', 'date'),
      text('fromPosition', 'from_position', false),
      text('toPosition', 'to_position', false),
      text('fromDepartment', 'from_department', false),
      text('toDepartment', 'to_department', false),
      num('fromSalary', 'from_salary'),
      num('toSalary', 'to_salary'),
      text('orderNo', 'order_no', false),
      text('reason', 'reason', false),
      // ФИО на момент операции: журнал приказов не должен терять имя, если
      // карточку потом удалили. Колонка добавлена миграцией 9.
      text('employeeName', 'employee_name', false),
    ],
  },
  {
    table: 'audit_log',
    selfFilling: true,
    stateKey: 'auditLog',
    route: 'audit-log',
    orderBy: 'ts DESC',
    columns: [
      text('ts', 'ts'),
      // login | password_change | reset | create | update | delete | settings
      text('action', 'action'),
      text('entity', 'entity'),
      text('entityId', 'entity_id', false),
      text('diff', 'diff', false),
    ],
  },
  {
    table: 'report_presets',
    selfFilling: true,
    stateKey: 'reportPresets',
    route: 'report-presets',
    orderBy: 'name ASC',
    columns: [
      text('name', 'name'),
      // JSON с настройками конструктора: источник, поля, фильтры, группировка.
      text('config', 'config'),
    ],
  },
  {
    table: 'backups',
    stateKey: 'backups',
    route: 'backups',
    selfFilling: true,
    orderBy: 'created_at DESC',
    columns: [
      text('createdAt', 'created_at'),
      text('fileName', 'file_name'),
      int('rows', 'rows'),
      text('note', 'note', false),
    ],
  },
  {
    table: 'kb_categories',
    stateKey: 'kbCategories',
    route: 'kb-categories',
    orderBy: 'order_index ASC',
    columns: [
      text('name', 'name'),
      int('orderIndex', 'order_index'),
    ],
  },
  {
    table: 'staffing_revisions',
    stateKey: 'staffingRevisions',
    route: 'staffing-revisions',
    selfFilling: true,
    since: 8,
    orderBy: 'effective_date DESC, created_at DESC',
    columns: [
      text('title', 'title'),
      text('effectiveDate', 'effective_date'),
      text('createdAt', 'created_at'),
      text('note', 'note', false),
      // JSON-снимок подразделений и должностей на дату редакции.
      text('snapshot', 'snapshot'),
    ],
  },
  {
    table: 'review_cycles',
    stateKey: 'reviewCycles',
    route: 'review-cycles',
    selfFilling: true,
    since: 8,
    orderBy: 'started_at DESC',
    columns: [
      text('period', 'period'),
      // JSON-массив id подразделений; пустой массив — вся организация.
      text('scope', 'scope'),
      text('startedAt', 'started_at'),
      // active | closed
      text('status', 'status'),
    ],
  },
  {
    table: 'kb_articles',
    stateKey: 'kbArticles',
    route: 'kb-articles',
    orderBy: 'updated_at DESC',
    columns: [
      text('categoryId', 'category_id', false),
      text('title', 'title'),
      text('contentHtml', 'content_html', false),
      int('reads', 'reads'),
      text('createdAt', 'created_at'),
      text('updatedAt', 'updated_at'),
    ],
  },
];

export const ENTITY_BY_TABLE = new Map(ENTITIES.map((e) => [e.table, e]));

/** Таблица журнала: её изменения в журнал не пишутся, иначе он зациклится. */
export const AUDIT_TABLE = 'audit_log';

/**
 * Таблицы, попадающие в резервную копию.
 *
 * users намеренно не входит: учётная запись владельца привязана к устройству,
 * и восстановление копии с чужого компьютера подменило бы пароль. backups —
 * журнал самих копий, восстанавливать его поверх себя бессмысленно.
 */
export const BACKUP_TABLES = [
  'employees', 'departments', 'positions', 'templates', 'timesheets', 'archives',
  ...ENTITIES.filter((e) => e.table !== 'backups').map((e) => e.table),
];

/** Сущности, которым положен посев. */
export const SEEDED_ENTITIES = ENTITIES.filter((e) => !e.selfFilling);

/** Имена таблиц для экранов — чтобы не разбрасывать строковые литералы. */
export const TABLES = {
  candidates: 'candidates',
  timeOff: 'time_off_requests',
  checklistTasks: 'checklist_tasks',
  goals: 'goals',
  reviews: 'reviews',
  movements: 'movements',
  auditLog: 'audit_log',
  reportPresets: 'report_presets',
  backups: 'backups',
  kbCategories: 'kb_categories',
  kbArticles: 'kb_articles',
  staffingRevisions: 'staffing_revisions',
  reviewCycles: 'review_cycles',
} as const;

/** DDL таблицы. Один источник для обеих схем. */
export function createTableSql(entity: EntityDef): string {
  const columns = entity.columns.map((c) => `    ${c.column} ${c.sql}`).join(',\n');
  return `CREATE TABLE IF NOT EXISTS ${entity.table} (\n    id TEXT PRIMARY KEY,\n${columns}\n  );`;
}

/** Индексы под связи, по которым экраны фильтруют. */
export function createIndexSql(entity: EntityDef): string[] {
  return entity.columns
    .filter((c) => ['employee_id', 'category_id', 'status', 'date'].includes(c.column))
    .map((c) => `CREATE INDEX IF NOT EXISTS idx_${entity.table}_${c.column} ON ${entity.table}(${c.column});`);
}

/**
 * DDL таблиц, появившихся в миграции `version`. Без аргумента — таблицы
 * миграции 5: её текст не должен меняться от того, что в список добавили
 * новую сущность.
 */
export function allSchemaSql(version = 5): string {
  return ENTITIES
    .filter((e) => (e.since ?? 5) === version)
    .flatMap((e) => [createTableSql(e), ...createIndexSql(e)])
    .join('\n  ');
}

/** Строка БД -> объект приложения. */
export function rowToObject(entity: EntityDef, row: any): any {
  const out: any = { id: row.id };
  for (const c of entity.columns) {
    const raw = row[c.column];
    if (c.kind === 'bool') out[c.field] = Boolean(raw);
    else if (c.kind === 'number') out[c.field] = Number(raw ?? 0);
    else out[c.field] = raw ?? undefined;
  }
  return out;
}

/** Объект приложения -> значения для INSERT/UPDATE в порядке entity.columns. */
export function objectToValues(entity: EntityDef, obj: any): any[] {
  return entity.columns.map((c) => {
    const value = obj[c.field];
    if (c.kind === 'bool') return value ? 1 : 0;
    if (c.kind === 'number') return value ?? 0;
    return value ?? null;
  });
}

export function insertSql(entity: EntityDef): string {
  const cols = ['id', ...entity.columns.map((c) => c.column)];
  return `INSERT INTO ${entity.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
}

export function selectSql(entity: EntityDef): string {
  return `SELECT * FROM ${entity.table}${entity.orderBy ? ` ORDER BY ${entity.orderBy}` : ''}`;
}

/**
 * UPDATE только по переданным полям: экраны часто меняют одно свойство
 * (перетащили карточку — сменился статус), и затирать остальные нельзя.
 */
export function updateSql(entity: EntityDef, patch: any): { sql: string; values: any[] } | null {
  const touched = entity.columns.filter((c) => patch[c.field] !== undefined);
  if (touched.length === 0) return null;
  const assignments = touched.map((c) => `${c.column} = ?`).join(', ');
  const values = touched.map((c) => {
    const value = patch[c.field];
    if (c.kind === 'bool') return value ? 1 : 0;
    return value;
  });
  return { sql: `UPDATE ${entity.table} SET ${assignments} WHERE id = ?`, values };
}
