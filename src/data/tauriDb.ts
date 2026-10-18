// Реализация доступа к данным для нативного приложения (Tauri).
// Работает с локальной SQLite через команды оболочки (src/data/shellDb.ts):
// соединение держит Rust и сверяет каждую запись с режимом лицензии. Схема,
// миграции и первичный посев общие с веб-режимом (src/data/schema.ts,
// seedData.ts), но в нативном приложении их применяет оболочка при открытии
// базы — до того, как известен режим лицензии.
import bcrypt from 'bcryptjs';
import type {
  Employee, Department, Position, TimesheetRecord, ArchiveRecord, ArchiveFilters, Template, LoginResult, AuthStatus,
} from './types';
import {
  ENTITIES, ENTITY_BY_TABLE, AUDIT_TABLE, BACKUP_TABLES, insertSql, selectSql, updateSql, rowToObject, objectToValues,
} from './entities';
import { employeePatchFor, employeeUpdate, movementError, movementRecord } from './movements';
import { demoCleanupStatements } from './demo';
import { departmentNameError, employeeErrors, hasErrors, parentError, positionErrors, templateError } from '../lib/validation';
import { apiError } from './errors';
import { shellDb, isReadOnlyError } from './shellDb';
import type { ShellDb, SqlStatement } from './shellDb';
import { newId } from '../lib/id';

async function getDb(): Promise<ShellDb> {
  return shellDb;
}

const rid = newId;

const AUDIT_INSERT = 'INSERT INTO audit_log (id, ts, action, entity, entity_id, diff) VALUES (?, ?, ?, ?, ?, ?)';

const auditStatement = (action: string, entity: string, entityId?: string | null, diff?: string | null): SqlStatement => ({
  sql: AUDIT_INSERT,
  params: [rid(), new Date().toISOString(), action, entity, entityId ?? null, diff ?? null],
});

// Журнал аудита пишется слоем данных, как и на сервере: событие должно
// попадать в журнал вместе с самим изменением, а не когда экран вспомнит.
// В режиме «только чтение» журнал не пишется — и это не повод отказывать во
// входе или просмотре: запись о входе не стоит того, чтобы запереть данные.
async function audit(db: ShellDb, action: string, entity: string, entityId?: string | null, diff?: string | null) {
  try {
    const { sql, params } = auditStatement(action, entity, entityId, diff);
    await db.execute(sql, params);
  } catch (error) {
    if (!isReadOnlyError(error)) throw error;
  }
}

// ---- Employees ----
const employeeFromRow = (e: any): Employee => ({
  id: e.id, fullName: e.full_name, position: e.position, department: e.department,
  status: e.status, hireDate: e.hire_date,
  tabNumber: e.tab_number ?? undefined, birthDate: e.birth_date ?? undefined,
  paymentType: e.payment_type || 'salary', salary: e.salary || 0, rate: e.rate ?? 1,
  dismissalDate: e.dismissal_date ?? null,
});

export async function listEmployees(): Promise<Employee[]> {
  const db = await getDb();
  const rows = await db.select<any[]>('SELECT * FROM employees');
  return rows.map(employeeFromRow);
}
const INSERT_EMPLOYEE =
  'INSERT INTO employees (id, full_name, position, department, status, hire_date, tab_number, birth_date, payment_type, salary, rate, dismissal_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

function employeeValues(id: string, e: Omit<Employee, 'id'>) {
  return [
    id, String(e.fullName).trim(), String(e.position).trim(), String(e.department).trim(), e.status, e.hireDate,
    e.tabNumber || null, e.birthDate || null, e.paymentType ?? 'salary', Number(e.salary ?? 0), Number(e.rate ?? 1), e.dismissalDate || null,
  ];
}

/** Те же правила, что у сервера: карточку с ошибками не записываем. */
function assertEmployee(e: Partial<Employee>): void {
  if (hasErrors(employeeErrors(e))) throw apiError('emp.validation', 'Проверьте заполнение карточки');
}

export async function createEmployee(emp: Omit<Employee, 'id'> & { id?: string }): Promise<{ id: string }> {
  const db = await getDb();
  assertEmployee(emp);
  const id = emp.id || rid();
  await db.transaction([
    { sql: INSERT_EMPLOYEE, params: employeeValues(id, emp) },
    auditStatement('create', 'employees', id, String(emp.fullName).trim()),
  ]);
  return { id };
}

// Массовая вставка для импорта из Excel: одной транзакцией, чтобы частично
// разобранный файл не оставил базу в half-состоянии.
export async function createEmployeesBulk(rows: (Omit<Employee, 'id'> & { id?: string })[]): Promise<{ ids: string[] }> {
  const db = await getDb();
  if (!Array.isArray(rows)) throw apiError('emp.bulkShape', 'Ожидался массив сотрудников');
  rows.forEach(assertEmployee);
  const ids = rows.map((r) => r.id || rid());
  await db.transaction([
    ...rows.map((row, i) => ({ sql: INSERT_EMPLOYEE, params: employeeValues(ids[i], row) })),
    auditStatement('import', 'employees', null, `${ids.length}`),
  ]);
  return { ids };
}

// Обновление поверх текущей строки: непереданные поля остаются прежними.
// Раньше они превращались в NULL, если экран присылал не всю карточку.
export async function updateEmployeeRow(id: string, patch: Partial<Employee>): Promise<void> {
  const db = await getDb();
  const rows = await db.select<any[]>('SELECT * FROM employees WHERE id = ?', [id]);
  if (!rows[0]) throw apiError('emp.notFound', 'Сотрудник не найден');
  const e = { ...employeeFromRow(rows[0]), ...patch };
  assertEmployee(e);
  await db.transaction([
    {
      sql: 'UPDATE employees SET full_name = ?, position = ?, department = ?, status = ?, hire_date = ?, tab_number = ?, birth_date = ?, payment_type = ?, salary = ?, rate = ?, dismissal_date = ? WHERE id = ?',
      params: [...employeeValues(id, e).slice(1), id],
    },
    auditStatement('update', 'employees', id, e.fullName ?? null),
  ]);
}
export async function deleteEmployeeRow(id: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ full_name: string }[]>('SELECT full_name FROM employees WHERE id = ?', [id]);
  await db.execute('DELETE FROM employees WHERE id = ?', [id]);
  await audit(db, 'delete', 'employees', id, rows[0]?.full_name ?? null);
}

// ---- Departments ----
//
// Сервера в нативной сборке нет, поэтому те же проверки, что и в server.ts,
// делаются здесь: экран — первая линия, слой данных — последняя.
const departmentFromRow = (d: any): Department => ({ id: d.id, name: d.name, parentId: d.parent_id });

export async function listDepartments(): Promise<Department[]> {
  const db = await getDb();
  const rows = await db.select<any[]>('SELECT * FROM departments');
  return rows.map(departmentFromRow);
}
export async function createDepartment(dep: Omit<Department, 'id'> & { id?: string }): Promise<{ id: string }> {
  const db = await getDb();
  const departments = await listDepartments();
  const nameError = departmentNameError(String(dep.name ?? ''), departments);
  if (nameError) throw apiError(nameError, 'Проверьте название подразделения');
  const parentId = dep.parentId || null;
  if (parentId && !departments.some((d) => d.id === parentId)) throw apiError('org.parentMissing', 'Родительское подразделение не найдено');

  const id = dep.id || rid();
  const name = dep.name.trim();
  await db.transaction([
    { sql: 'INSERT INTO departments (id, name, parent_id) VALUES (?, ?, ?)', params: [id, name, parentId] },
    auditStatement('create', 'departments', id, name),
  ]);
  return { id };
}
export async function updateDepartmentRow(id: string, data: Partial<Department>): Promise<{ renamedEmployees: number }> {
  const db = await getDb();
  const departments = await listDepartments();
  const current = departments.find((d) => d.id === id);
  if (!current) throw apiError('org.notFound', 'Подразделение не найдено');
  // Отсутствие поля — прежнее значение; явный null у родителя — корень.
  const name = (data.name !== undefined ? String(data.name) : current.name).trim();
  const parentId = 'parentId' in data ? (data.parentId || null) : current.parentId ?? null;
  const nameError = departmentNameError(name, departments, id);
  if (nameError) throw apiError(nameError, 'Проверьте название подразделения');
  const cycle = parentError(departments, id, parentId);
  if (cycle) throw apiError(cycle, 'Нельзя выбрать такое родительское подразделение');

  // Сотрудники ссылаются на подразделение по названию: переименование
  // проходит по их карточкам той же транзакцией.
  let renamedEmployees = 0;
  const statements: SqlStatement[] = [
    { sql: 'UPDATE departments SET name = ?, parent_id = ? WHERE id = ?', params: [name, parentId, id] },
  ];
  if (name !== current.name) {
    const affected = await db.select<{ c: number }[]>('SELECT count(*) AS c FROM employees WHERE department = ?', [current.name]);
    renamedEmployees = affected[0]?.c ?? 0;
    statements.push({ sql: 'UPDATE employees SET department = ? WHERE department = ?', params: [name, current.name] });
  }
  statements.push(auditStatement('update', 'departments', id, name));
  await db.transaction(statements);
  return { renamedEmployees };
}
/**
 * Подразделение удаляется вместе со своими должностями. Вложенные — нет:
 * их сначала переносят или удаляют явно. Работающих сотрудников сначала
 * переводят — иначе они остались бы в подразделении, которого нет.
 */
export async function deleteDepartmentRow(id: string): Promise<{ deletedPositions: number }> {
  const db = await getDb();
  const named = await db.select<{ name: string }[]>('SELECT name FROM departments WHERE id = ?', [id]);
  if (!named[0]) return { deletedPositions: 0 };
  const children = await db.select<{ c: number }[]>('SELECT count(*) AS c FROM departments WHERE parent_id = ?', [id]);
  if ((children[0]?.c ?? 0) > 0) throw apiError('org.hasChildren', 'Сначала удалите или перенесите вложенные подразделения');
  const staff = await db.select<{ c: number }[]>(
    "SELECT count(*) AS c FROM employees WHERE department = ? AND status != 'dismissed'", [named[0].name],
  );
  const staffCount = staff[0]?.c ?? 0;
  if (staffCount > 0) throw apiError('org.hasEmployees', 'В подразделении числятся сотрудники', { count: staffCount });

  const positions = await db.select<{ c: number }[]>('SELECT count(*) AS c FROM positions WHERE department_id = ?', [id]);
  await db.transaction([
    { sql: 'DELETE FROM positions WHERE department_id = ?', params: [id] },
    { sql: 'DELETE FROM departments WHERE id = ?', params: [id] },
    auditStatement('delete', 'departments', id, named[0].name),
  ]);
  return { deletedPositions: positions[0]?.c ?? 0 };
}

// ---- Positions ----
const positionFromRow = (p: any): Position => ({
  id: p.id, departmentId: p.department_id, title: p.title, maxCount: p.max_count, salary: p.salary,
});

export async function listPositions(): Promise<Position[]> {
  const db = await getDb();
  const rows = await db.select<any[]>('SELECT * FROM positions');
  return rows.map(positionFromRow);
}

async function checkPosition(db: ShellDb, draft: Omit<Position, 'id'>, excludeId?: string): Promise<void> {
  const dep = await db.select<{ id: string }[]>('SELECT id FROM departments WHERE id = ?', [draft.departmentId]);
  if (!draft.departmentId || !dep[0]) throw apiError('pos.departmentMissing', 'Подразделение не найдено');
  const siblings = (await db.select<any[]>('SELECT * FROM positions WHERE department_id = ?', [draft.departmentId])).map(positionFromRow);
  const errors = positionErrors(
    { title: String(draft.title ?? ''), maxCount: draft.maxCount, salary: draft.salary ?? '' },
    siblings, excludeId,
  );
  const first = Object.values(errors)[0];
  if (first) throw apiError(first, 'Проверьте заполнение должности');
}

export async function createPosition(pos: Omit<Position, 'id'> & { id?: string }): Promise<{ id: string }> {
  const db = await getDb();
  await checkPosition(db, pos);
  const id = pos.id || rid();
  const title = pos.title.trim();
  await db.transaction([
    {
      sql: 'INSERT INTO positions (id, department_id, title, max_count, salary) VALUES (?, ?, ?, ?, ?)',
      params: [id, pos.departmentId, title, Number(pos.maxCount), Number(pos.salary)],
    },
    auditStatement('create', 'positions', id, title),
  ]);
  return { id };
}
export async function updatePositionRow(id: string, data: Partial<Position>): Promise<{ renamedEmployees: number }> {
  const db = await getDb();
  const rows = await db.select<any[]>('SELECT * FROM positions WHERE id = ?', [id]);
  if (!rows[0]) throw apiError('pos.notFound', 'Должность не найдена');
  const before = positionFromRow(rows[0]);
  const merged = { ...before, ...data };
  await checkPosition(db, merged, id);
  const title = String(merged.title).trim();

  const statements: SqlStatement[] = [{
    sql: 'UPDATE positions SET department_id = ?, title = ?, max_count = ?, salary = ? WHERE id = ?',
    params: [merged.departmentId, title, Number(merged.maxCount), Number(merged.salary), id],
  }];
  // Переименование должности проходит по карточкам её подразделения.
  let renamedEmployees = 0;
  if (title !== before.title && merged.departmentId === before.departmentId) {
    const dep = await db.select<{ name: string }[]>('SELECT name FROM departments WHERE id = ?', [before.departmentId]);
    const depName = dep[0]?.name ?? '';
    const affected = await db.select<{ c: number }[]>(
      'SELECT count(*) AS c FROM employees WHERE position = ? AND department = ?', [before.title, depName],
    );
    renamedEmployees = affected[0]?.c ?? 0;
    statements.push({
      sql: 'UPDATE employees SET position = ? WHERE position = ? AND department = ?',
      params: [title, before.title, depName],
    });
  }
  statements.push(auditStatement('update', 'positions', id, title));
  await db.transaction(statements);
  return { renamedEmployees };
}
export async function deletePositionRow(id: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ title: string }[]>('SELECT title FROM positions WHERE id = ?', [id]);
  await db.transaction([
    { sql: 'DELETE FROM positions WHERE id = ?', params: [id] },
    auditStatement('delete', 'positions', id, rows[0]?.title ?? null),
  ]);
}

// ---- Templates ----
export async function listTemplates(): Promise<Template[]> {
  const db = await getDb();
  const rows = await db.select<any[]>('SELECT * FROM templates');
  return rows.map((t) => ({ id: t.id, name: t.name, blocks: JSON.parse(t.blocks) }));
}
export async function createTemplate(tpl: Omit<Template, 'id'> & { id?: string }): Promise<{ id: string }> {
  const error = templateError(tpl);
  if (error) throw apiError(error);
  const db = await getDb();
  const id = tpl.id || rid();
  const name = tpl.name.trim();
  await db.execute('INSERT INTO templates (id, name, blocks) VALUES (?, ?, ?)', [id, name, JSON.stringify(tpl.blocks)]);
  await audit(db, 'create', 'templates', id, name);
  return { id };
}
export async function updateTemplateRow(id: string, data: Partial<Template>): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ name: string; blocks: string }[]>('SELECT name, blocks FROM templates WHERE id = ?', [id]);
  if (!rows[0]) throw apiError('tpl.notFound');
  // Частичная правка: чего нет в запросе — остаётся как было.
  const next = { name: data.name ?? rows[0].name, blocks: data.blocks ?? JSON.parse(rows[0].blocks) };
  const error = templateError(next);
  if (error) throw apiError(error);
  await db.execute('UPDATE templates SET name = ?, blocks = ? WHERE id = ?', [next.name.trim(), JSON.stringify(next.blocks), id]);
  await audit(db, 'update', 'templates', id, next.name.trim());
}
export async function deleteTemplateRow(id: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ name: string }[]>('SELECT name FROM templates WHERE id = ?', [id]);
  await db.execute('DELETE FROM templates WHERE id = ?', [id]);
  await audit(db, 'delete', 'templates', id, rows[0]?.name ?? null);
}

// ---- Timesheets ----
export async function listTimesheets(year?: number, month?: number): Promise<TimesheetRecord[]> {
  const db = await getDb();
  const where: string[] = [];
  const params: any[] = [];
  if (year !== undefined) { params.push(year); where.push('year = ?'); }
  if (month !== undefined) { params.push(month); where.push('month = ?'); }
  const rows = await db.select<any[]>(
    `SELECT * FROM timesheets${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
    params,
  );
  return rows.map((t) => ({ id: t.id, year: t.year, month: t.month, employeeId: t.employee_id, days: JSON.parse(t.days) }));
}
export async function createTimesheet(rec: Omit<TimesheetRecord, 'id'> & { id?: string }): Promise<{ id: string }> {
  const db = await getDb();
  const id = rec.id || rid();
  await db.execute('INSERT INTO timesheets (id, year, month, employee_id, days) VALUES (?, ?, ?, ?, ?)', [id, rec.year, rec.month, rec.employeeId, JSON.stringify(rec.days)]);
  return { id };
}
export async function updateTimesheetRow(id: string, data: Partial<TimesheetRecord>): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE timesheets SET year = ?, month = ?, employee_id = ?, days = ? WHERE id = ?', [data.year, data.month, data.employeeId, JSON.stringify(data.days), id]);
}
export async function deleteTimesheetRow(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM timesheets WHERE id = ?', [id]);
}

// ---- Archives ----
export async function listArchiveFacets(): Promise<{ years: number[]; departments: string[]; employees: { id: string; name: string }[] }> {
  const db = await getDb();
  const years = await db.select<{ year: number }[]>('SELECT DISTINCT year FROM archives ORDER BY year DESC');
  const departments = await db.select<{ department: string }[]>('SELECT DISTINCT department FROM archives ORDER BY department');
  // Сотрудники — те, кто есть в архиве, а не нынешний штат.
  const employees = await db.select<{ id: string; name: string }[]>(
    'SELECT employee_id AS id, MAX(employee_name) AS name FROM archives GROUP BY employee_id ORDER BY name',
  );
  return { years: years.map((r) => r.year), departments: departments.map((r) => r.department), employees };
}

/** Закрытие месяца: строки архива одной транзакцией, при replace — вместо прежних. */
export async function createArchivesBulk(
  records: (Omit<ArchiveRecord, 'id'> & { id?: string })[],
  replace?: { year: number; month: number },
): Promise<{ ids: string[] }> {
  const db = await getDb();
  const ids = records.map((r) => r.id || rid());
  const insert = 'INSERT INTO archives (id, year, month, employee_id, employee_name, department, position, salary, hours_worked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
  await db.transaction([
    ...(replace ? [{ sql: 'DELETE FROM archives WHERE year = ? AND month = ?', params: [replace.year, replace.month] }] : []),
    ...records.map((r, i) => ({
      sql: insert,
      params: [ids[i], r.year, r.month, r.employeeId, r.employeeName, r.department, r.position, r.salary ?? 0, r.hoursWorked ?? 0],
    })),
    auditStatement('archive_month', 'archives', null,
      replace ? `${replace.year}-${String(replace.month).padStart(2, '0')} · ${ids.length}` : String(ids.length)),
  ]);
  return { ids };
}

export async function listArchives(filters: ArchiveFilters = {}): Promise<ArchiveRecord[]> {
  const db = await getDb();
  const where: string[] = [];
  const params: any[] = [];
  if (filters.year !== undefined) { params.push(filters.year); where.push('year = ?'); }
  if (filters.department !== undefined) { params.push(filters.department); where.push('department = ?'); }
  if (filters.employeeId !== undefined) { params.push(filters.employeeId); where.push('employee_id = ?'); }
  const rows = await db.select<any[]>(
    `SELECT * FROM archives${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`,
    params,
  );
  return rows.map((a) => ({
    id: a.id, year: a.year, month: a.month, employeeId: a.employee_id, employeeName: a.employee_name,
    department: a.department, position: a.position, salary: a.salary, hoursWorked: a.hours_worked,
  }));
}
export async function createArchive(rec: Omit<ArchiveRecord, 'id'> & { id?: string }): Promise<{ id: string }> {
  const db = await getDb();
  const id = rec.id || rid();
  await db.execute('INSERT INTO archives (id, year, month, employee_id, employee_name, department, position, salary, hours_worked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, rec.year, rec.month, rec.employeeId, rec.employeeName, rec.department, rec.position, rec.salary, rec.hoursWorked]);
  return { id };
}
export async function deleteArchiveRow(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM archives WHERE id = ?', [id]);
}

// ---- Сущности, описанные в entities.ts ----
// Один набор операций на все семь таблиц: расписывать 28 почти одинаковых
// функций руками — верный способ развести ветки доступа к данным.

export async function listEntity(table: string): Promise<any[]> {
  const entity = ENTITY_BY_TABLE.get(table);
  if (!entity) throw new Error(`Неизвестная таблица: ${table}`);
  const db = await getDb();
  const rows = await db.select<any[]>(selectSql(entity));
  return rows.map((r) => rowToObject(entity, r));
}

export async function createEntity(table: string, data: any): Promise<{ id: string }> {
  const entity = ENTITY_BY_TABLE.get(table);
  if (!entity) throw new Error(`Неизвестная таблица: ${table}`);
  const db = await getDb();
  const id = data.id || rid();
  await db.execute(insertSql(entity), [id, ...objectToValues(entity, data)]);
  if (entity.table !== AUDIT_TABLE) await audit(db, 'create', entity.table, id, null);
  return { id };
}

export async function updateEntity(table: string, id: string, patch: any): Promise<void> {
  const entity = ENTITY_BY_TABLE.get(table);
  if (!entity) throw new Error(`Неизвестная таблица: ${table}`);
  const update = updateSql(entity, patch);
  if (!update) return;
  const db = await getDb();
  await db.execute(update.sql, [...update.values, id]);
  if (entity.table !== AUDIT_TABLE) await audit(db, 'update', entity.table, id, Object.keys(patch).join(', '));
}

export async function deleteEntity(table: string, id: string): Promise<void> {
  const entity = ENTITY_BY_TABLE.get(table);
  if (!entity) throw new Error(`Неизвестная таблица: ${table}`);
  const db = await getDb();
  await db.execute(`DELETE FROM ${entity.table} WHERE id = ?`, [id]);
  if (entity.table !== AUDIT_TABLE) await audit(db, 'delete', entity.table, id, null);
}

// ---- Кадровые операции ----
// Запись и изменение карточки — одной транзакцией, как и на сервере.
export async function applyMovement(movement: any): Promise<{ id: string; movement: any; employeePatch: any }> {
  const db = await getDb();
  const rows = await db.select<any[]>('SELECT * FROM employees WHERE id = ?', [movement.employeeId]);
  if (!rows[0]) throw apiError('emp.notFound', 'Сотрудник не найден');
  const employee = employeeFromRow(rows[0]);

  const invalid = movementError(movement, employee);
  if (invalid) throw apiError(invalid, 'Операцию провести нельзя');

  // Прежние значения — из карточки, а не из формы.
  const record = movementRecord(movement, employee);

  const entity = ENTITY_BY_TABLE.get('movements')!;
  const id = movement.id || rid();
  const patch = employeePatchFor(record);
  const update = employeeUpdate(patch);

  await db.transaction([
    { sql: insertSql(entity), params: [id, ...objectToValues(entity, record)] },
    ...(update
      ? [{ sql: `UPDATE employees SET ${update.assignments} WHERE id = ?`, params: [...update.values, movement.employeeId] }]
      : []),
    auditStatement('movement', 'employees', movement.employeeId, `${movement.type} · ${movement.date}`),
  ]);
  return { id, movement: { ...record, id }, employeePatch: patch };
}

/** Пароль администратора для опасных операций — только если он задан. */
async function checkAdminPassword(db: ShellDb, adminPassword: string): Promise<void> {
  const rows = await db.select<any[]>('SELECT password_hash FROM users ORDER BY id LIMIT 1');
  const hash = rows[0]?.password_hash;
  // Учётной записи может не быть вовсе, а у заведённой — пароля. Тогда
  // сверять нечего, и ступенью защиты остаётся подтверждение в интерфейсе.
  if (hash && !bcrypt.compareSync(adminPassword ?? '', hash)) {
    throw apiError('auth.invalidAdmin', 'Неверный пароль администратора');
  }
}

/** Очистка выбранных таблиц — очистка данных отдельных модулей. */
export async function resetTables(adminPassword: string, tables: string[]): Promise<{ cleared: string[] }> {
  const db = await getDb();
  await checkAdminPassword(db, adminPassword);

  const requested = tables.filter((t) => BACKUP_TABLES.includes(t));
  if (requested.length === 0) throw apiError('reset.noTables', 'Не выбрано ни одной известной таблицы');

  await db.transaction([
    ...requested.map((table) => ({ sql: `DELETE FROM ${table}` })),
    auditStatement('reset_tables', 'system', null, requested.join(', ')),
  ]);
  return { cleared: requested };
}

/** Удаление демонстрационных данных — тем же списком запросов, что и на сервере. */
export async function clearDemoData(): Promise<{ removed: number }> {
  const db = await getDb();
  const statements = demoCleanupStatements();
  await db.transaction([
    ...statements,
    auditStatement('demo_clear', 'system', null, String(statements.length)),
  ]);
  // Число удалённых строк оболочка не возвращает; экрану достаточно факта.
  return { removed: statements.length };
}

// ---- Резервные копии ----
export async function exportBackup(): Promise<{ version: number; createdAt: string; data: Record<string, unknown[]> }> {
  const db = await getDb();
  const data: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) {
    data[table] = await db.select<any[]>(`SELECT * FROM ${table}`);
  }
  await audit(db, 'backup', 'system', null, `${BACKUP_TABLES.length}`);
  return { version: 1, createdAt: new Date().toISOString(), data };
}

export async function restoreBackup(payload: any): Promise<{ restored: number; tables: number }> {
  if (!payload || typeof payload.data !== 'object' || payload.data === null) {
    throw new Error('Файл не похож на резервную копию');
  }

  const tables = BACKUP_TABLES.filter((table) => Array.isArray(payload.data[table]));
  if (tables.length === 0) throw new Error('В копии нет ни одной известной таблицы');

  const db = await getDb();
  let restored = 0;

  // Сначала читаем, какие колонки есть в таблицах, потом пишем всё одной
  // транзакцией: частично восстановленная копия хуже, чем никакая.
  const statements: SqlStatement[] = [];
  for (const table of tables) {
    statements.push({ sql: `DELETE FROM ${table}` });

    const rows = payload.data[table] as Record<string, unknown>[];
    if (rows.length === 0) continue;

    const info = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
    const known = new Set(info.map((c) => c.name));
    const columns = Object.keys(rows[0]).filter((c) => known.has(c));
    if (columns.length === 0) continue;

    const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    for (const row of rows) {
      statements.push({ sql, params: columns.map((c) => row[c] ?? null) });
      restored += 1;
    }
  }
  statements.push(auditStatement('restore', 'system', null, `${restored}`));
  await db.transaction(statements);

  return { restored, tables: tables.length };
}

// ---- Auth (локальная, без JWT) ----
//
// Учётная запись одна, и её может не быть вовсе. Пустой password_hash —
// пароль не задан. require_password — владелец включил запрос пароля при
// входе; хранится в базе вместе с учётной записью, а не в хранилище окна,
// поэтому очистка данных WebView его не выключает.

interface OwnerRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  name: string;
  require_password?: number;
}

async function getOwner(db: ShellDb): Promise<OwnerRow | undefined> {
  const rows = await db.select<OwnerRow[]>('SELECT * FROM users ORDER BY id LIMIT 1');
  return rows[0];
}

const ownerRequiresPassword = (owner: OwnerRow | undefined): boolean =>
  Boolean(owner?.password_hash) && Boolean(owner?.require_password);

const publicUser = (u: OwnerRow): LoginResult['user'] => ({ id: u.id, email: u.email, name: u.name, role: 'ADMIN' });

/** Логин подходит, если пуст или совпадает с email либо именем владельца. */
function loginMatches(owner: OwnerRow, login: string | undefined): boolean {
  const value = String(login ?? '').trim().toLocaleLowerCase('ru');
  if (!value) return true;
  return value === String(owner.email ?? '').trim().toLocaleLowerCase('ru')
    || value === String(owner.name ?? '').trim().toLocaleLowerCase('ru');
}

export async function authStatus(): Promise<AuthStatus> {
  const db = await getDb();
  const owner = await getOwner(db);
  return {
    hasOwner: Boolean(owner),
    hasPassword: Boolean(owner?.password_hash),
    requirePassword: ownerRequiresPassword(owner),
    ownerName: owner?.name ?? null,
  };
}

/**
 * Владелец без проверки пароля — когда запрос пароля выключен. Когда
 * включён, отказ: войти можно только паролем.
 */
export async function currentOwner(): Promise<LoginResult | null> {
  const db = await getDb();
  const owner = await getOwner(db);
  if (!owner) return null;
  if (ownerRequiresPassword(owner)) throw apiError('auth.sessionRequired', 'Требуется вход по паролю');
  return { user: publicUser(owner), token: 'local' };
}

/**
 * Завести или поправить учётную запись владельца — один вызов на оба
 * случая: строка в таблице всегда одна.
 */
export async function saveOwner(name: string, email: string): Promise<LoginResult> {
  const db = await getDb();
  const cleanName = name.trim();
  const cleanEmail = email.trim();
  if (!cleanName && !cleanEmail) throw apiError('auth.ownerRequired', 'Нужно имя или email');

  const existing = await getOwner(db);
  const id = existing?.id ?? '1';
  const displayName = cleanName || cleanEmail;

  if (existing) {
    await db.execute('UPDATE users SET name = ?, email = ? WHERE id = ?', [displayName, cleanEmail, id]);
    await audit(db, 'owner_update', 'auth', id, cleanEmail || displayName);
  } else {
    // Пустой password_hash — пароль не задан.
    await db.execute(
      'INSERT INTO users (id, email, password_hash, role, name) VALUES (?, ?, ?, ?, ?)',
      [id, cleanEmail, '', 'ADMIN', displayName],
    );
    await audit(db, 'owner_create', 'auth', id, cleanEmail || displayName);
  }

  return { user: { id, email: cleanEmail, name: displayName, role: 'ADMIN' }, token: 'local' };
}

/** Вход по паролю. Логин необязателен: владелец один. */
export async function login(password: string, loginName?: string): Promise<LoginResult> {
  const db = await getDb();
  const owner = await getOwner(db);
  // Пустой хэш — пароль не задан: входить по паролю не через что.
  if (!owner || !owner.password_hash || !loginMatches(owner, loginName) || !bcrypt.compareSync(password, owner.password_hash)) {
    await audit(db, 'login_failed', 'auth', null, loginName ?? '');
    throw apiError('auth.invalid', 'Неверный пароль');
  }
  await audit(db, 'login', 'auth', owner.id, owner.email || owner.name);
  return { user: publicUser(owner), token: 'local' };
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const db = await getDb();
  const owner = await getOwner(db);
  // Пароля ещё нет — подтверждать нечем, форма задаёт первый.
  if (!owner || (owner.password_hash && !bcrypt.compareSync(currentPassword, owner.password_hash))) {
    throw apiError('auth.invalidCurrent', 'Неверный текущий пароль');
  }
  if (newPassword.length < 6) throw apiError('auth.tooShort', 'Пароль должен быть не менее 6 символов');
  await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(newPassword, 10), owner.id]);
  await audit(db, 'password_change', 'auth', owner.id, owner.email || owner.name);
}

/**
 * Снять пароль: учётная запись остаётся, приложение снова открывается сразу.
 * Текущий пароль спрашиваем, запрос пароля при входе выключается заодно.
 */
export async function removePassword(currentPassword: string): Promise<void> {
  const db = await getDb();
  const owner = await getOwner(db);
  if (!owner || (owner.password_hash && !bcrypt.compareSync(currentPassword, owner.password_hash))) {
    throw apiError('auth.invalidCurrent', 'Неверный текущий пароль');
  }
  await db.execute("UPDATE users SET password_hash = '', require_password = 0 WHERE id = ?", [owner.id]);
  await audit(db, 'password_remove', 'auth', owner.id, owner.email || owner.name);
}

/** Включить или выключить запрос пароля при входе. */
export async function setRequirePassword(enabled: boolean): Promise<{ requirePassword: boolean }> {
  const db = await getDb();
  const owner = await getOwner(db);
  if (!owner) throw apiError('auth.ownerRequired', 'Нужно имя или email');
  if (enabled && !owner.password_hash) throw apiError('auth.noPassword', 'Сначала задайте пароль');
  await db.execute('UPDATE users SET require_password = ? WHERE id = ?', [enabled ? 1 : 0, owner.id]);
  await audit(db, 'settings', 'auth', owner.id, `requirePassword: ${enabled}`);
  return { requirePassword: enabled };
}

export async function resetSystem(adminPassword: string): Promise<void> {
  const db = await getDb();
  await checkAdminPassword(db, adminPassword);
  // users намеренно не трогаем: учётная запись владельца переживает сброс.
  // Список совпадает с серверным RESETTABLE_TABLES в src/db/sqlite.ts.
  const tables = ['employees', 'departments', 'positions', 'templates', 'timesheets', 'archives', ...ENTITIES.map((e) => e.table)];
  await db.transaction([
    ...tables.map((table) => ({ sql: `DELETE FROM ${table}` })),
    auditStatement('reset', 'system', null, tables.join(', ')),
  ]);
}
