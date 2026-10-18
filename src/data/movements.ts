/**
 * Что кадровая операция меняет в карточке сотрудника.
 *
 * Логика одна на обе ветки доступа к данным: и веб-сервер, и нативный режим
 * импортируют её отсюда. Если бы каждый считал патч сам, «перевод» в двух
 * режимах со временем стал бы означать разное.
 */
import type { Employee, Movement } from './types';
import { isIsoDate } from '../lib/validation';

/** Колонки employees, которые может менять проведение операции. */
export const EMPLOYEE_COLUMNS: Record<string, string> = {
  position: 'position',
  department: 'department',
  status: 'status',
  hireDate: 'hire_date',
  salary: 'salary',
  dismissalDate: 'dismissal_date',
};

export function employeePatchFor(movement: Pick<Movement, 'type' | 'date' | 'toPosition' | 'toDepartment' | 'toSalary'>): Partial<Employee> {
  const patch: Partial<Employee> = {};

  if (movement.type === 'hire') {
    patch.status = 'active';
    patch.hireDate = movement.date;
    // Повторный приём снимает прежнее увольнение.
    patch.dismissalDate = null;
  }

  if (movement.type === 'dismissal') {
    // Карточка сотрудника не удаляется: история, табели и архив на неё ссылаются.
    // Дата увольнения нужна табелю: после неё дни человеку не засчитываются.
    patch.status = 'dismissed';
    patch.dismissalDate = movement.date;
    return patch;
  }

  if (movement.toPosition) patch.position = movement.toPosition;
  if (movement.toDepartment) patch.department = movement.toDepartment;
  if (typeof movement.toSalary === 'number' && movement.toSalary > 0) patch.salary = movement.toSalary;

  return patch;
}

/** SET-часть UPDATE employees по патчу. Возвращает null, если менять нечего. */
export function employeeUpdate(patch: Partial<Employee>): { assignments: string; values: unknown[] } | null {
  const entries = Object.entries(patch).filter(([field]) => EMPLOYEE_COLUMNS[field] !== undefined);
  if (entries.length === 0) return null;

  return {
    assignments: entries.map(([field]) => `${EMPLOYEE_COLUMNS[field]} = ?`).join(', '),
    values: entries.map(([, value]) => value),
  };
}

/**
 * Проверка операции до проведения. Возвращает код ошибки (errors.*) или null.
 * Одна на обе ветки доступа к данным, как и сам патч.
 */
export function movementError(
  movement: Pick<Movement, 'type' | 'date' | 'toPosition' | 'toDepartment' | 'toSalary'>,
  employee: Pick<Employee, 'status' | 'hireDate' | 'dismissalDate' | 'position' | 'department' | 'salary'>,
): string | null {
  if (!['hire', 'transfer', 'dismissal'].includes(movement.type)) return 'mov.typeInvalid';
  if (!isIsoDate(movement.date)) return 'mov.dateInvalid';

  if (movement.type === 'dismissal') {
    if (employee.status === 'dismissed') return 'mov.alreadyDismissed';
    if (employee.hireDate && movement.date < employee.hireDate) return 'emp.dismissalBeforeHire';
    return null;
  }

  if (movement.type === 'transfer') {
    if (employee.status === 'dismissed') return 'mov.dismissedEmployee';
    if (employee.hireDate && movement.date < employee.hireDate) return 'mov.beforeHire';
    const changesPosition = Boolean(movement.toPosition) && movement.toPosition !== employee.position;
    const changesDepartment = Boolean(movement.toDepartment) && movement.toDepartment !== employee.department;
    const changesSalary = typeof movement.toSalary === 'number' && movement.toSalary > 0 && movement.toSalary !== employee.salary;
    if (!changesPosition && !changesDepartment && !changesSalary) return 'mov.nothingToChange';
    return null;
  }

  // Приём: повторный приём уволенного — не раньше даты увольнения.
  if (employee.status === 'dismissed' && employee.dismissalDate && movement.date < employee.dismissalDate) {
    return 'mov.hireBeforeDismissal';
  }
  return null;
}

/**
 * Запись журнала: прежние значения берутся из карточки, а для приёма без
 * новых значений — текущие (принят на ту должность, что указана в карточке).
 */
export function movementRecord<T extends Partial<Movement>>(movement: T, employee: Employee | Record<string, any>) {
  const e = employee as Record<string, any>;
  const position = e.position;
  const department = e.department;
  const salary = Number(e.salary ?? 0);
  const record = {
    ...movement,
    fromPosition: position,
    fromDepartment: department,
    fromSalary: salary,
    employeeName: e.fullName ?? e.full_name,
  };
  if (movement.type === 'hire') {
    record.toPosition = movement.toPosition || position;
    record.toDepartment = movement.toDepartment || department;
    record.toSalary = typeof movement.toSalary === 'number' && movement.toSalary > 0 ? movement.toSalary : salary;
  }
  return record;
}
