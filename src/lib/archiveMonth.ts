/**
 * Закрытие месяца: строки архива из табеля.
 *
 * Раньше пополнить архив из интерфейса было нечем — он показывал только
 * записи, засеянные при первом запуске. Теперь закрытый месяц табеля
 * переносится в архив: кто работал, в каком подразделении и на какой
 * должности, оклад по ставке и отработанные часы.
 */
import type { ArchiveRecord, Employee, TimesheetRecord } from '../data/types';
import { employedInMonth, timesheetTotals } from './timesheet';
import { employeeCost } from './payroll';

/** Период работы из карточки. */
export const employmentOf = (e: Pick<Employee, 'hireDate' | 'dismissalDate'>) => ({ from: e.hireDate, to: e.dismissalDate ?? null });

/**
 * Строки архива за месяц. month — номер месяца табеля (0–11); в архиве месяц
 * хранится по-человечески, 1–12.
 */
export function archiveRecordsForMonth(
  employees: Employee[],
  timesheets: TimesheetRecord[],
  year: number,
  month: number,
): Omit<ArchiveRecord, 'id'>[] {
  return employees
    .filter((e) => employedInMonth(employmentOf(e), year, month))
    .map((e) => {
      const record = timesheets.find((t) => t.year === year && t.month === month && t.employeeId === e.id);
      const totals = timesheetTotals(record?.days ?? {}, year, month, employmentOf(e));
      return {
        year,
        month: month + 1,
        employeeId: e.id,
        employeeName: e.fullName,
        department: e.department,
        position: e.position,
        salary: employeeCost(e),
        hoursWorked: totals.hours,
      };
    })
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'ru'));
}
