/**
 * Текучесть кадров.
 *
 * Приёмы и увольнения берутся из двух источников: журнала кадровых операций
 * и дат в карточках. Раньше учитывался только журнал, и сотрудник, заведённый
 * карточкой без приказа «Приём», в отчёт не попадал вовсе.
 *
 * Коэффициент — классический: уволенные за период / среднесписочная
 * численность × 100. Среднесписочная за месяц — среднее численности на
 * начало и конец месяца, за год — среднее помесячных.
 */
import type { Employee, Movement } from '../data/types';

export interface MonthTurnover {
  start: number;
  end: number;
  hired: number;
  dismissed: number;
  average: number;
  /** Процент, одна цифра после запятой. */
  turnover: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Числился ли сотрудник на дату (ГГГГ-ММ-ДД). */
export function onStaff(e: Pick<Employee, 'hireDate' | 'dismissalDate' | 'status'>, date: string): boolean {
  if (!e.hireDate || e.hireDate > date) return false;
  // Уволенный без даты (данные из старых версий) — уволен давно.
  if (e.status === 'dismissed' && !e.dismissalDate) return false;
  return !e.dismissalDate || e.dismissalDate >= date;
}

export function turnoverByMonth(
  employees: Employee[],
  movements: Movement[],
  year: number,
): { months: MonthTurnover[]; year: MonthTurnover } {
  // Событие — пара «сотрудник + дата»: приказ и дата в карточке про одно и
  // то же событие считаются один раз.
  const hires = new Set<string>();
  const dismissals = new Set<string>();
  for (const m of movements) {
    if (m.type === 'hire') hires.add(`${m.employeeId}|${m.date}`);
    if (m.type === 'dismissal') dismissals.add(`${m.employeeId}|${m.date}`);
  }
  for (const e of employees) {
    if (e.hireDate) hires.add(`${e.id}|${e.hireDate}`);
    if (e.dismissalDate) dismissals.add(`${e.id}|${e.dismissalDate}`);
  }
  const inMonth = (set: Set<string>, prefix: string) =>
    Array.from(set).filter((key) => key.split('|')[1]?.startsWith(prefix)).length;
  const headcount = (date: string) => employees.filter((e) => onStaff(e, date)).length;

  const months: MonthTurnover[] = [];
  for (let month = 0; month < 12; month += 1) {
    const prefix = `${year}-${pad(month + 1)}`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const start = headcount(`${prefix}-01`);
    const end = headcount(`${prefix}-${pad(lastDay)}`);
    const dismissed = inMonth(dismissals, prefix);
    const average = round1((start + end) / 2);
    months.push({
      start,
      end,
      hired: inMonth(hires, prefix),
      dismissed,
      average,
      turnover: average > 0 ? round1((dismissed / average) * 100) : 0,
    });
  }

  const dismissedYear = months.reduce((s, m) => s + m.dismissed, 0);
  const averageYear = round1(months.reduce((s, m) => s + m.average, 0) / 12);
  return {
    months,
    year: {
      start: months[0].start,
      end: months[11].end,
      hired: months.reduce((s, m) => s + m.hired, 0),
      dismissed: dismissedYear,
      average: averageYear,
      turnover: averageYear > 0 ? round1((dismissedYear / averageYear) * 100) : 0,
    },
  };
}
