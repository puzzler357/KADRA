/**
 * Расчёт итогов табеля.
 *
 * Логика жила прямо в разметке экрана и повторялась в выгрузке — здесь она
 * одна и покрыта тестами. Буквенные коды формы Т-13 не переводятся: это
 * доменный стандарт, а не подпись интерфейса.
 */

export interface AttendanceCode {
  /** Часов за день по этому коду. */
  hours: number;
  /** Считается ли день отработанным. */
  worked: boolean;
  /** Классы оформления ячейки — с достаточным контрастом в обеих темах. */
  color: string;
}

export const ATTENDANCE_CODES: Record<string, AttendanceCode> = {
  'Я': { hours: 8, worked: true, color: 'text-primary' },
  'В': { hours: 0, worked: false, color: 'text-rose-700 bg-rose-500/10 dark:text-rose-300' },
  'ОТ': { hours: 0, worked: false, color: 'text-blue-800 bg-blue-500/15 dark:text-blue-300' },
  'Б': { hours: 0, worked: false, color: 'text-amber-800 bg-amber-500/15 dark:text-amber-300' },
  'К': { hours: 8, worked: true, color: 'text-emerald-800 bg-emerald-500/15 dark:text-emerald-300' },
  'ОГ': { hours: 0, worked: false, color: 'text-teal-800 bg-teal-500/15 dark:text-teal-300' },
  'ВМ': { hours: 11, worked: true, color: 'text-orange-800 bg-orange-500/15 dark:text-orange-300' },
  'МВ': { hours: 0, worked: false, color: 'text-indigo-800 bg-indigo-500/15 dark:text-indigo-300' },
  'НН': { hours: 0, worked: false, color: 'text-purple-800 bg-purple-500/15 dark:text-purple-300' },
  'ПР': { hours: 0, worked: false, color: 'text-rose-800 bg-rose-500/25 dark:text-rose-200' },
};

/** Порядок перебора кодов по щелчку. */
export const CODE_CYCLE = ['Я', 'В', 'ОТ', 'Б', 'К', 'ОГ', 'ВМ', 'МВ', 'НН', 'ПР'];

export const WEEKEND_CODE = 'В';
export const DEFAULT_WORK_CODE = 'Я';

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function isWeekend(year: number, month: number, day: number): boolean {
  const weekday = new Date(year, month, day).getDay();
  return weekday === 0 || weekday === 6;
}

/**
 * Период работы сотрудника: с даты приёма по дату увольнения включительно.
 * Пустые границы — без ограничения.
 */
export interface EmploymentRange {
  from?: string | null;
  to?: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (year: number, month: number, day: number) => `${year}-${pad(month + 1)}-${pad(day)}`;

/** Работал ли сотрудник в этот день. */
export function isEmployedOn(range: EmploymentRange | undefined, year: number, month: number, day: number): boolean {
  if (!range) return true;
  const date = isoDay(year, month, day);
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

/** Работал ли сотрудник хотя бы один день месяца. */
export function employedInMonth(range: EmploymentRange | undefined, year: number, month: number): boolean {
  if (!range) return true;
  const first = isoDay(year, month, 1);
  const last = isoDay(year, month, daysInMonth(year, month));
  if (range.from && range.from > last) return false;
  if (range.to && range.to < first) return false;
  return true;
}

/**
 * Код дня с учётом умолчания: незаполненный день считается выходным по
 * календарю и явкой в остальных случаях. Именно это правило показывает экран,
 * поэтому итоги обязаны считаться по нему же.
 *
 * Вне периода работы (до приёма, после увольнения) кода нет — пустая строка.
 * Раньше такие дни считались явками, и принятому в июле начислялось 22 дня
 * за июнь.
 */
export function codeForDay(
  days: Record<number, string>,
  year: number,
  month: number,
  day: number,
  range?: EmploymentRange,
): string {
  if (!isEmployedOn(range, year, month, day)) return '';
  const explicit = days[day];
  if (explicit !== undefined && explicit !== '') return explicit;
  return isWeekend(year, month, day) ? WEEKEND_CODE : DEFAULT_WORK_CODE;
}

/**
 * Код после щелчка. Перебор идёт от того, что видно в ячейке: раньше первый
 * щелчок по незаполненному рабочему дню записывал ту же «Я», и казалось, что
 * щелчок не сработал. Возвращает пустую строку, если новый код совпадает с
 * умолчанием дня, — так в базе хранятся только отличия от календаря.
 */
export function nextCode(days: Record<number, string>, year: number, month: number, day: number): string {
  const shown = codeForDay(days, year, month, day);
  const index = CODE_CYCLE.indexOf(shown);
  const next = CODE_CYCLE[(index + 1) % CODE_CYCLE.length];
  const fallback = isWeekend(year, month, day) ? WEEKEND_CODE : DEFAULT_WORK_CODE;
  return next === fallback ? '' : next;
}

export interface TimesheetTotals {
  /** Дни, засчитанные как отработанные. */
  workDays: number;
  /** Явки — подмножество отработанных, без командировок. */
  attendances: number;
  /** Сумма часов. */
  hours: number;
  /** Сколько дней каждого кода — для отчёта по неявкам. */
  codes: Record<string, number>;
  /** Дней в периоде работы внутри месяца. */
  employedDays: number;
}

export function timesheetTotals(
  days: Record<number, string>,
  year: number,
  month: number,
  range?: EmploymentRange,
): TimesheetTotals {
  const total = daysInMonth(year, month);
  let workDays = 0;
  let attendances = 0;
  let hours = 0;
  let employedDays = 0;
  const codes: Record<string, number> = {};

  for (let day = 1; day <= total; day += 1) {
    const code = codeForDay(days, year, month, day, range);
    if (!code) continue;
    employedDays += 1;
    codes[code] = (codes[code] ?? 0) + 1;
    const info = ATTENDANCE_CODES[code];
    if (!info?.worked) continue;

    workDays += 1;
    hours += info.hours;
    // Командировка (К) — отработанный день, но не явка на рабочем месте.
    if (code !== 'К') attendances += 1;
  }

  return { workDays, attendances, hours, codes, employedDays };
}

/** Коды неявок для отчёта: всё, что не работа и не выходной по графику. */
export const ABSENCE_CODES = ['ОТ', 'Б', 'ОГ', 'НН', 'ПР'];
