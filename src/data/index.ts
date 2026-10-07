// Единый слой доступа к данным.
// В нативном приложении (Tauri) работает напрямую с локальной SQLite,
// в вебе (dev через браузер) — с локальным Express-бэкендом по /api.
import * as tauri from './tauriDb';
import { ENTITY_BY_TABLE } from './entities';
import type {
  Employee, Department, Position, TimesheetRecord, ArchiveRecord, ArchiveFilters, Template, LoginResult,
} from './types';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const rid = () => Math.random().toString(36).substring(7);

async function jsonOrThrow(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

// ---- Employees ----
export const listEmployees = (): Promise<Employee[]> =>
  isTauri ? tauri.listEmployees() : fetch('/api/employees').then((r) => r.json());

export const createEmployee = (emp: Omit<Employee, 'id'> & { id?: string }): Promise<{ id: string }> => {
  if (isTauri) return tauri.createEmployee(emp);
  const id = emp.id || rid();
  return fetch('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...emp, id }) })
    .then((r) => r.json()).then(() => ({ id }));
};

// Массовая вставка для импорта: обе ветки пишут одной транзакцией, чтобы
// файл импортировался целиком либо не импортировался вовсе.
export const createEmployeesBulk = (rows: (Omit<Employee, 'id'> & { id?: string })[]): Promise<{ ids: string[] }> => {
  if (isTauri) return tauri.createEmployeesBulk(rows);
  const withIds = rows.map((r) => ({ ...r, id: r.id || rid() }));
  return fetch('/api/employees/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employees: withIds }),
  }).then(jsonOrThrow);
};

export const updateEmployee = (id: string, data: Partial<Employee>): Promise<void> => {
  if (isTauri) return tauri.updateEmployeeRow(id, data);
  return fetch(`/api/employees/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(() => undefined);
};

export const deleteEmployee = (id: string): Promise<void> =>
  isTauri ? tauri.deleteEmployeeRow(id) : fetch(`/api/employees/${id}`, { method: 'DELETE' }).then(() => undefined);

// ---- Departments ----
export const listDepartments = (): Promise<Department[]> =>
  isTauri ? tauri.listDepartments() : fetch('/api/departments').then((r) => r.json());

export const createDepartment = (dep: Omit<Department, 'id'>): Promise<{ id: string }> =>
  isTauri ? tauri.createDepartment(dep)
    : fetch('/api/departments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dep) }).then(jsonOrThrow);

export const updateDepartment = (id: string, data: Partial<Department>): Promise<void> =>
  isTauri ? tauri.updateDepartmentRow(id, data)
    : fetch(`/api/departments/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(jsonOrThrow).then(() => undefined);

export const deleteDepartment = (id: string): Promise<void> =>
  isTauri ? tauri.deleteDepartmentRow(id)
    : fetch(`/api/departments/${id}`, { method: 'DELETE' }).then(jsonOrThrow).then(() => undefined);

// ---- Positions ----
export const listPositions = (): Promise<Position[]> =>
  isTauri ? tauri.listPositions() : fetch('/api/positions').then((r) => r.json());

export const createPosition = (pos: Omit<Position, 'id'>): Promise<{ id: string }> =>
  isTauri ? tauri.createPosition(pos)
    : fetch('/api/positions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pos) }).then(jsonOrThrow);

export const updatePosition = (id: string, data: Partial<Position>): Promise<void> =>
  isTauri ? tauri.updatePositionRow(id, data)
    : fetch(`/api/positions/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(jsonOrThrow).then(() => undefined);

export const deletePosition = (id: string): Promise<void> =>
  isTauri ? tauri.deletePositionRow(id)
    : fetch(`/api/positions/${id}`, { method: 'DELETE' }).then(jsonOrThrow).then(() => undefined);

// ---- Templates ----
export const listTemplates = (): Promise<Template[]> =>
  isTauri ? tauri.listTemplates() : fetch('/api/templates').then((r) => r.json());

export const createTemplate = (tpl: Omit<Template, 'id'> & { id?: string }): Promise<{ id: string }> => {
  if (isTauri) return tauri.createTemplate(tpl);
  const id = tpl.id || rid();
  return fetch('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...tpl, id }) })
    .then((r) => r.json()).then(() => ({ id }));
};

export const updateTemplate = (id: string, data: Partial<Template>): Promise<void> =>
  isTauri ? tauri.updateTemplateRow(id, data)
    : fetch(`/api/templates/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(() => undefined);

export const deleteTemplate = (id: string): Promise<void> =>
  isTauri ? tauri.deleteTemplateRow(id) : fetch(`/api/templates/${id}`, { method: 'DELETE' }).then(() => undefined);

// ---- Timesheets ----
// Табель и архив запрашиваются срезом: обе таблицы растут линейно по времени
// и по штату, тянуть их целиком при каждом входе нельзя.
export const listTimesheets = (year?: number, month?: number): Promise<TimesheetRecord[]> => {
  if (isTauri) return tauri.listTimesheets(year, month);
  const query = new URLSearchParams();
  if (year !== undefined) query.set('year', String(year));
  if (month !== undefined) query.set('month', String(month));
  const suffix = query.toString();
  return fetch(`/api/timesheets${suffix ? `?${suffix}` : ''}`).then((r) => r.json());
};

export const createTimesheet = (rec: Omit<TimesheetRecord, 'id'> & { id?: string }): Promise<{ id: string }> => {
  if (isTauri) return tauri.createTimesheet(rec);
  const id = rec.id || rid();
  return fetch('/api/timesheets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rec, id }) })
    .then((r) => r.json()).then(() => ({ id }));
};

export const updateTimesheet = (id: string, data: Partial<TimesheetRecord>): Promise<void> =>
  isTauri ? tauri.updateTimesheetRow(id, data)
    : fetch(`/api/timesheets/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(() => undefined);

export const deleteTimesheet = (id: string): Promise<void> =>
  isTauri ? tauri.deleteTimesheetRow(id) : fetch(`/api/timesheets/${id}`, { method: 'DELETE' }).then(() => undefined);

// ---- Archives ----
export const listArchives = (filters: ArchiveFilters = {}): Promise<ArchiveRecord[]> => {
  if (isTauri) return tauri.listArchives(filters);
  const query = new URLSearchParams();
  if (filters.year !== undefined) query.set('year', String(filters.year));
  if (filters.department !== undefined) query.set('department', filters.department);
  if (filters.employeeId !== undefined) query.set('employeeId', filters.employeeId);
  const suffix = query.toString();
  return fetch(`/api/archives${suffix ? `?${suffix}` : ''}`).then((r) => r.json());
};

/** Значения для фильтров архива — считаются по всей таблице, а не по срезу. */
export const listArchiveFacets = (): Promise<{ years: number[]; departments: string[] }> =>
  isTauri ? tauri.listArchiveFacets() : fetch('/api/archives/facets').then((r) => r.json());

export const createArchive = (rec: Omit<ArchiveRecord, 'id'> & { id?: string }): Promise<{ id: string }> => {
  if (isTauri) return tauri.createArchive(rec);
  const id = rec.id || rid();
  return fetch('/api/archives', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rec, id }) })
    .then((r) => r.json()).then(() => ({ id }));
};

export const deleteArchive = (id: string): Promise<void> =>
  isTauri ? tauri.deleteArchiveRow(id) : fetch(`/api/archives/${id}`, { method: 'DELETE' }).then(() => undefined);

// ---- Сущности из entities.ts ----
// Обе ветки принимают имя таблицы: экраны работают через типизированные
// обёртки ниже и самого имени не видят.
const routeOf = (table: string): string => {
  const entity = ENTITY_BY_TABLE.get(table);
  if (!entity) throw new Error(`Неизвестная таблица: ${table}`);
  return `/api/${entity.route}`;
};

export const listEntity = <T>(table: string): Promise<T[]> =>
  isTauri ? tauri.listEntity(table) : fetch(routeOf(table)).then((r) => r.json());

export const createEntity = (table: string, data: any): Promise<{ id: string }> =>
  isTauri ? tauri.createEntity(table, data)
    : fetch(routeOf(table), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(jsonOrThrow);

export const updateEntity = (table: string, id: string, patch: any): Promise<void> =>
  isTauri ? tauri.updateEntity(table, id, patch)
    : fetch(`${routeOf(table)}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(jsonOrThrow).then(() => undefined);

export const deleteEntity = (table: string, id: string): Promise<void> =>
  isTauri ? tauri.deleteEntity(table, id)
    : fetch(`${routeOf(table)}/${id}`, { method: 'DELETE' }).then(jsonOrThrow).then(() => undefined);

/** Проведение кадровой операции: запись в movements + изменение карточки. */
export const applyMovement = (movement: any): Promise<{ id: string; movement: any; employeePatch: any }> =>
  isTauri ? tauri.applyMovement(movement)
    : fetch('/api/movements/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(movement) }).then(jsonOrThrow);

// ---- Auth ----
export const resetTables = (adminPassword: string, tables: string[]): Promise<{ cleared: string[] }> =>
  isTauri ? tauri.resetTables(adminPassword, tables)
    : fetch('/api/reset/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminPassword, tables }) }).then(jsonOrThrow);

// ---- Резервные копии ----
export const exportBackup = (): Promise<{ version: number; createdAt: string; data: Record<string, unknown[]> }> =>
  isTauri ? tauri.exportBackup() : fetch('/api/backup').then(jsonOrThrow);

export const restoreBackup = (payload: unknown): Promise<{ restored: number; tables: number }> =>
  isTauri ? tauri.restoreBackup(payload)
    : fetch('/api/backup/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(jsonOrThrow);

export const authStatus = (): Promise<{ needsSetup: boolean }> =>
  isTauri ? tauri.authStatus() : fetch('/api/auth/status').then(jsonOrThrow);

/** Владелец без ввода пароля. null — владельца ещё нет. */
export const currentOwner = (): Promise<LoginResult | null> =>
  isTauri ? tauri.currentOwner()
    : fetch('/api/auth/owner').then(jsonOrThrow).then((d) => (d.user ? d : null));

export const setupOwner = (name: string, email: string, password: string): Promise<LoginResult> =>
  isTauri ? tauri.setupOwner(name, email, password)
    : fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password }) }).then(jsonOrThrow);

export const login = (email: string, password: string): Promise<LoginResult> =>
  isTauri ? tauri.login(email, password)
    : fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }).then(jsonOrThrow);

export const changePassword = (email: string, currentPassword: string, newPassword: string): Promise<void> =>
  isTauri ? tauri.changePassword(email, currentPassword, newPassword)
    : fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, currentPassword, newPassword }) }).then(jsonOrThrow).then(() => undefined);

export const resetSystem = (adminPassword: string): Promise<void> =>
  isTauri ? tauri.resetSystem(adminPassword)
    : fetch('/api/auth/reset-system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminPassword }) }).then(jsonOrThrow).then(() => undefined);
