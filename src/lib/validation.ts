/**
 * Проверки справочников и карточек.
 *
 * Одни и те же правила нужны экрану (подсветить поле и не отправлять запрос)
 * и веб-серверу (не принять мусор от изменённого скрипта или старой вкладки).
 * В нативной сборке сервера нет, поэтому главная линия обороны — экран, а
 * правила лежат здесь, чтобы две стороны не разошлись.
 *
 * Функции возвращают коды ошибок (errors.* в локализации), а не готовый текст.
 */
import type { Department, Employee, Position } from '../data/types';

/** Имя для сравнения: без крайних и повторных пробелов, без учёта регистра. */
export function normalizeName(value: string | null | undefined): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
}

/** Название подразделения: обязательно и не повторяет существующее. */
export function departmentNameError(
  name: string,
  departments: Pick<Department, 'id' | 'name'>[],
  excludeId?: string | null,
): string | null {
  const normalized = normalizeName(name);
  if (!normalized) return 'org.nameRequired';
  // Сотрудники ссылаются на подразделение по названию: два одинаковых
  // названия сделали бы счётчики занятости неоднозначными.
  const duplicate = departments.some((d) => d.id !== excludeId && normalizeName(d.name) === normalized);
  return duplicate ? 'org.nameDuplicate' : null;
}

/**
 * Родитель не может быть самим подразделением или его потомком — иначе
 * дерево замкнётся в кольцо и перестанет рисоваться.
 */
export function descendantIds(departments: Pick<Department, 'id' | 'parentId'>[], rootId: string): Set<string> {
  const result = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const d of departments) {
      if (d.parentId === current && !result.has(d.id)) {
        result.add(d.id);
        stack.push(d.id);
      }
    }
  }
  return result;
}

export function parentError(
  departments: Pick<Department, 'id' | 'parentId'>[],
  id: string | null | undefined,
  parentId: string | null | undefined,
): string | null {
  if (!parentId) return null;
  if (!departments.some((d) => d.id === parentId)) return 'org.parentMissing';
  if (id && (parentId === id || descendantIds(departments, id).has(parentId))) return 'org.parentCycle';
  return null;
}

export interface PositionDraft {
  title: string;
  maxCount: number | string;
  salary: number | string;
}

/** Ошибки по полям должности. Пустой объект — всё в порядке. */
export function positionErrors(
  draft: PositionDraft,
  sameDepartment: Pick<Position, 'id' | 'title'>[] = [],
  excludeId?: string | null,
): Partial<Record<keyof PositionDraft, string>> {
  const errors: Partial<Record<keyof PositionDraft, string>> = {};
  const title = normalizeName(draft.title);
  if (!title) errors.title = 'pos.titleRequired';
  else if (sameDepartment.some((p) => p.id !== excludeId && normalizeName(p.title) === title)) errors.title = 'pos.titleDuplicate';

  const units = Number(draft.maxCount);
  if (!Number.isInteger(units) || units < 1 || units > 10000) errors.maxCount = 'pos.unitsInvalid';

  const salary = Number(draft.salary);
  if (draft.salary === '' || !Number.isFinite(salary) || salary < 0) errors.salary = 'pos.salaryInvalid';

  return errors;
}

/** Допустимые ставки: от четверти до двух. */
export const RATE_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const EMPLOYEE_STATUSES = ['active', 'on_leave', 'probation', 'dismissed'] as const;
export const PAYMENT_TYPES = ['salary', 'hourly', 'piecework'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Дата в формате ГГГГ-ММ-ДД, существующая в календаре. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Проверка карточки сотрудника целиком. Используется веб-сервером для
 * create/update/bulk и мастером импорта; форма проверяет то же через zod.
 */
export function employeeErrors(e: Partial<Employee>): Partial<Record<keyof Employee, string>> {
  const errors: Partial<Record<keyof Employee, string>> = {};
  if (String(e.fullName ?? '').trim().length < 2) errors.fullName = 'emp.nameRequired';
  if (!String(e.position ?? '').trim()) errors.position = 'emp.positionRequired';
  if (!String(e.department ?? '').trim()) errors.department = 'emp.departmentRequired';
  if (!EMPLOYEE_STATUSES.includes(e.status as Employee['status'])) errors.status = 'emp.statusInvalid';
  if (!isIsoDate(e.hireDate)) errors.hireDate = 'emp.hireDateInvalid';
  if (e.birthDate && !isIsoDate(e.birthDate)) errors.birthDate = 'emp.dateInvalid';
  if (e.dismissalDate) {
    if (!isIsoDate(e.dismissalDate)) errors.dismissalDate = 'emp.dateInvalid';
    else if (isIsoDate(e.hireDate) && e.dismissalDate < e.hireDate) errors.dismissalDate = 'emp.dismissalBeforeHire';
  }
  if (e.paymentType !== undefined && !PAYMENT_TYPES.includes(e.paymentType)) errors.paymentType = 'emp.paymentInvalid';
  if (e.salary !== undefined && (!Number.isFinite(Number(e.salary)) || Number(e.salary) < 0)) errors.salary = 'emp.salaryInvalid';
  if (e.rate !== undefined) {
    const rate = Number(e.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 2) errors.rate = 'emp.rateInvalid';
  }
  return errors;
}

export const hasErrors = (errors: object): boolean => Object.keys(errors).length > 0;

const BLOCK_TYPES = ['text', 'table', 'signature'];

/**
 * Шаблон документа: название обязательно, блоки — массив известных типов.
 * Раньше сервер принимал что угодно, а частичный PUT записывал в блоки
 * «undefined», и шаблон переставал открываться.
 */
export function templateError(t: { name?: unknown; blocks?: unknown }): string | null {
  if (typeof t.name !== 'string' || t.name.trim() === '') return 'tpl.nameRequired';
  if (t.name.trim().length > 200) return 'tpl.nameTooLong';
  if (!Array.isArray(t.blocks)) return 'tpl.blocksInvalid';
  for (const block of t.blocks as unknown[]) {
    const b = block as { id?: unknown; type?: unknown; content?: unknown } | null;
    if (!b || typeof b.id !== 'string' || !BLOCK_TYPES.includes(String(b.type)) || (b.content !== undefined && typeof b.content !== 'string')) {
      return 'tpl.blocksInvalid';
    }
  }
  return null;
}
