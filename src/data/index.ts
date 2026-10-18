// Единый слой доступа к данным.
// В нативном приложении (Tauri) работает напрямую с локальной SQLite,
// в вебе (dev через браузер) — с локальным Express-бэкендом по /api.
import * as tauri from './tauriDb';
import { ENTITY_BY_TABLE } from './entities';
import { ApiError } from './errors';
import i18n from '../i18n';
import type {
  Employee, Department, Position, TimesheetRecord, ArchiveRecord, ArchiveFilters, Template, LoginResult, AuthStatus,
} from './types';
import { newId } from '../lib/id';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const rid = newId;

// ---- Сессия веб-режима ----
//
// Когда владелец включил запрос пароля, сервер отдаёт данные только по
// токену сессии. Токен держит стор приложения (useAppStore) и передаёт сюда;
// при истёкшей сессии вызывается обработчик, и приложение показывает вход.
let authToken: string | null = null;
let onSessionExpired: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token && token !== 'local' ? token : null;
}

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}

async function jsonOrThrow(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.code === 'auth.sessionRequired') onSessionExpired?.();
    if (data.code) {
      const params = typeof data.count === 'number' ? { count: data.count } : {};
      const error = new ApiError(data.code, data.error, params);
      Object.assign(error, { fields: data.fields, rows: data.rows });
      throw error;
    }
    throw new Error(data.error || i18n.t('errors.request'));
  }
  return data;
}

const getJson = (url: string) => apiFetch(url).then(jsonOrThrow);
const sendJson = (method: string, url: string, body?: unknown) =>
  apiFetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then(jsonOrThrow);

// ---- Employees ----
export const listEmployees = (): Promise<Employee[]> =>
  isTauri ? tauri.listEmployees() : getJson('/api/employees');

export const createEmployee = (emp: Omit<Employee, 'id'> & { id?: string }): Promise<{ id: string }> => {
  if (isTauri) return tauri.createEmployee(emp);
  const id = emp.id || rid();
  return sendJson('POST', '/api/employees', { ...emp, id }).then(() => ({ id }));
};

// Массовая вставка для импорта: обе ветки пишут одной транзакцией, чтобы
// файл импортировался целиком либо не импортировался вовсе.
export const createEmployeesBulk = (rows: (Omit<Employee, 'id'> & { id?: string })[]): Promise<{ ids: string[] }> => {
  if (isTauri) return tauri.createEmployeesBulk(rows);
  const withIds = rows.map((r) => ({ ...r, id: r.id || rid() }));
  return sendJson('POST', '/api/employees/bulk', { employees: withIds });
};

export const updateEmployee = (id: string, data: Partial<Employee>): Promise<void> =>
  isTauri ? tauri.updateEmployeeRow(id, data) : sendJson('PUT', `/api/employees/${id}`, data).then(() => undefined);

export const deleteEmployee = (id: string): Promise<void> =>
  isTauri ? tauri.deleteEmployeeRow(id) : sendJson('DELETE', `/api/employees/${id}`).then(() => undefined);

// ---- Departments ----
export const listDepartments = (): Promise<Department[]> =>
  isTauri ? tauri.listDepartments() : getJson('/api/departments');

export const createDepartment = (dep: Omit<Department, 'id'>): Promise<{ id: string }> =>
  isTauri ? tauri.createDepartment(dep) : sendJson('POST', '/api/departments', dep);

/** Переименование проходит и по карточкам сотрудников; в ответе — сколько их задето. */
export const updateDepartment = (id: string, data: Partial<Department>): Promise<{ renamedEmployees: number }> =>
  isTauri ? tauri.updateDepartmentRow(id, data)
    : sendJson('PUT', `/api/departments/${id}`, data).then((d) => ({ renamedEmployees: d.renamedEmployees ?? 0 }));

/**
 * Удаляет подразделение вместе с его должностями. Отказ, если есть вложенные
 * подразделения или работающие сотрудники.
 */
export const deleteDepartment = (id: string): Promise<{ deletedPositions: number }> =>
  isTauri ? tauri.deleteDepartmentRow(id)
    : sendJson('DELETE', `/api/departments/${id}`).then((d) => ({ deletedPositions: d.deletedPositions ?? 0 }));

// ---- Positions ----
export const listPositions = (): Promise<Position[]> =>
  isTauri ? tauri.listPositions() : getJson('/api/positions');

export const createPosition = (pos: Omit<Position, 'id'>): Promise<{ id: string }> =>
  isTauri ? tauri.createPosition(pos) : sendJson('POST', '/api/positions', pos);

export const updatePosition = (id: string, data: Partial<Position>): Promise<{ renamedEmployees: number }> =>
  isTauri ? tauri.updatePositionRow(id, data)
    : sendJson('PUT', `/api/positions/${id}`, data).then((d) => ({ renamedEmployees: d.renamedEmployees ?? 0 }));

export const deletePosition = (id: string): Promise<void> =>
  isTauri ? tauri.deletePositionRow(id) : sendJson('DELETE', `/api/positions/${id}`).then(() => undefined);

// ---- Templates ----
export const listTemplates = (): Promise<Template[]> =>
  isTauri ? tauri.listTemplates() : getJson('/api/templates');

export const createTemplate = (tpl: Omit<Template, 'id'> & { id?: string }): Promise<{ id: string }> => {
  if (isTauri) return tauri.createTemplate(tpl);
  const id = tpl.id || rid();
  return sendJson('POST', '/api/templates', { ...tpl, id }).then(() => ({ id }));
};

export const updateTemplate = (id: string, data: Partial<Template>): Promise<void> =>
  isTauri ? tauri.updateTemplateRow(id, data) : sendJson('PUT', `/api/templates/${id}`, data).then(() => undefined);

export const deleteTemplate = (id: string): Promise<void> =>
  isTauri ? tauri.deleteTemplateRow(id) : sendJson('DELETE', `/api/templates/${id}`).then(() => undefined);

// ---- Timesheets ----
// Табель и архив запрашиваются срезом: обе таблицы растут линейно по времени
// и по штату, тянуть их целиком при каждом входе нельзя.
export const listTimesheets = (year?: number, month?: number): Promise<TimesheetRecord[]> => {
  if (isTauri) return tauri.listTimesheets(year, month);
  const query = new URLSearchParams();
  if (year !== undefined) query.set('year', String(year));
  if (month !== undefined) query.set('month', String(month));
  const suffix = query.toString();
  return getJson(`/api/timesheets${suffix ? `?${suffix}` : ''}`);
};

export const createTimesheet = (rec: Omit<TimesheetRecord, 'id'> & { id?: string }): Promise<{ id: string }> => {
  if (isTauri) return tauri.createTimesheet(rec);
  const id = rec.id || rid();
  return sendJson('POST', '/api/timesheets', { ...rec, id }).then(() => ({ id }));
};

export const updateTimesheet = (id: string, data: Partial<TimesheetRecord>): Promise<void> =>
  isTauri ? tauri.updateTimesheetRow(id, data) : sendJson('PUT', `/api/timesheets/${id}`, data).then(() => undefined);

export const deleteTimesheet = (id: string): Promise<void> =>
  isTauri ? tauri.deleteTimesheetRow(id) : sendJson('DELETE', `/api/timesheets/${id}`).then(() => undefined);

// ---- Archives ----
export const listArchives = (filters: ArchiveFilters = {}): Promise<ArchiveRecord[]> => {
  if (isTauri) return tauri.listArchives(filters);
  const query = new URLSearchParams();
  if (filters.year !== undefined) query.set('year', String(filters.year));
  if (filters.department !== undefined) query.set('department', filters.department);
  if (filters.employeeId !== undefined) query.set('employeeId', filters.employeeId);
  const suffix = query.toString();
  return getJson(`/api/archives${suffix ? `?${suffix}` : ''}`);
};

export interface ArchiveFacets {
  years: number[];
  departments: string[];
  /** Сотрудники, у которых есть записи в архиве. */
  employees: { id: string; name: string }[];
}

/** Значения для фильтров архива — считаются по всей таблице, а не по срезу. */
export const listArchiveFacets = (): Promise<ArchiveFacets> =>
  isTauri ? tauri.listArchiveFacets() : getJson('/api/archives/facets').then((d) => ({ employees: [], ...d }));

export const createArchive = (rec: Omit<ArchiveRecord, 'id'> & { id?: string }): Promise<{ id: string }> => {
  if (isTauri) return tauri.createArchive(rec);
  const id = rec.id || rid();
  return sendJson('POST', '/api/archives', { ...rec, id }).then(() => ({ id }));
};

/** Закрытие месяца: строки архива одним целым; replace — вместо ранее отправленных. */
export const createArchivesBulk = (
  records: (Omit<ArchiveRecord, 'id'> & { id?: string })[],
  replace?: { year: number; month: number },
): Promise<{ ids: string[] }> =>
  isTauri ? tauri.createArchivesBulk(records, replace) : sendJson('POST', '/api/archives/bulk', { records, replace });

export const deleteArchive = (id: string): Promise<void> =>
  isTauri ? tauri.deleteArchiveRow(id) : sendJson('DELETE', `/api/archives/${id}`).then(() => undefined);

// ---- Сущности из entities.ts ----
// Обе ветки принимают имя таблицы: экраны работают через типизированные
// обёртки ниже и самого имени не видят.
const routeOf = (table: string): string => {
  const entity = ENTITY_BY_TABLE.get(table);
  if (!entity) throw new Error(`Неизвестная таблица: ${table}`);
  return `/api/${entity.route}`;
};

export const listEntity = <T>(table: string): Promise<T[]> =>
  isTauri ? tauri.listEntity(table) : getJson(routeOf(table));

export const createEntity = (table: string, data: any): Promise<{ id: string }> =>
  isTauri ? tauri.createEntity(table, data) : sendJson('POST', routeOf(table), data);

export const updateEntity = (table: string, id: string, patch: any): Promise<void> =>
  isTauri ? tauri.updateEntity(table, id, patch) : sendJson('PUT', `${routeOf(table)}/${id}`, patch).then(() => undefined);

export const deleteEntity = (table: string, id: string): Promise<void> =>
  isTauri ? tauri.deleteEntity(table, id) : sendJson('DELETE', `${routeOf(table)}/${id}`).then(() => undefined);

/** Проведение кадровой операции: запись в movements + изменение карточки. */
export const applyMovement = (movement: any): Promise<{ id: string; movement: any; employeePatch: any }> =>
  isTauri ? tauri.applyMovement(movement) : sendJson('POST', '/api/movements/apply', movement);

// ---- Очистка ----
export const resetTables = (adminPassword: string, tables: string[]): Promise<{ cleared: string[] }> =>
  isTauri ? tauri.resetTables(adminPassword, tables) : sendJson('POST', '/api/reset/tables', { adminPassword, tables });

/** Удаляет демонстрационные данные первого запуска; своё не трогает. */
export const clearDemoData = (): Promise<{ removed: number }> =>
  isTauri ? tauri.clearDemoData() : sendJson('POST', '/api/demo/clear');

// ---- Резервные копии ----
export const exportBackup = (): Promise<{ version: number; createdAt: string; data: Record<string, unknown[]> }> =>
  isTauri ? tauri.exportBackup() : getJson('/api/backup');

export const restoreBackup = (payload: unknown): Promise<{ restored: number; tables: number }> =>
  isTauri ? tauri.restoreBackup(payload) : sendJson('POST', '/api/backup/restore', payload);

// ---- Учётная запись ----
export const authStatus = (): Promise<AuthStatus> =>
  isTauri ? tauri.authStatus()
    : getJson('/api/auth/status').then((d) => ({ requirePassword: false, ownerName: null, ...d }));

/**
 * Владелец без ввода пароля. null — владельца ещё нет. Когда запрос пароля
 * включён, обе ветки отвечают ошибкой auth.sessionRequired.
 */
export const currentOwner = (): Promise<LoginResult | null> =>
  isTauri ? tauri.currentOwner() : getJson('/api/auth/owner').then((d) => (d.user ? d : null));

/** Заводит учётную запись владельца или правит её — строка всегда одна. */
export const saveOwner = (name: string, email: string): Promise<LoginResult> =>
  isTauri ? tauri.saveOwner(name, email) : sendJson('POST', '/api/auth/owner', { name, email });

/** Вход по паролю. Владелец один, поэтому логин спрашивать не нужно. */
export const login = (password: string): Promise<LoginResult> =>
  isTauri ? tauri.login(password) : sendJson('POST', '/api/auth/login', { password });

export const changePassword = (currentPassword: string, newPassword: string): Promise<void> =>
  isTauri ? tauri.changePassword(currentPassword, newPassword)
    : sendJson('POST', '/api/auth/change-password', { currentPassword, newPassword }).then(() => undefined);

/** Снимает пароль: учётная запись остаётся, приложение снова открывается сразу. */
export const removePassword = (currentPassword: string): Promise<void> =>
  isTauri ? tauri.removePassword(currentPassword)
    : sendJson('POST', '/api/auth/remove-password', { currentPassword }).then(() => undefined);

/** Запрашивать ли пароль при входе. Хранится в базе вместе с учётной записью. */
export const setRequirePassword = (enabled: boolean): Promise<{ requirePassword: boolean }> =>
  isTauri ? tauri.setRequirePassword(enabled) : sendJson('POST', '/api/auth/require-password', { enabled });

export const resetSystem = (adminPassword: string): Promise<void> =>
  isTauri ? tauri.resetSystem(adminPassword)
    : sendJson('POST', '/api/auth/reset-system', { adminPassword }).then(() => undefined);
