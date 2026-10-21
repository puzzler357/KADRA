/**
 * Проверка поведения на стыке годов (31.12 → 01.01) и вокруг него.
 * Запуск из корня проекта: npx vitest run -c tests/date-check/vitest.config.ts (часовой пояс Ашхабада задан в конфиге)
 * Логика страниц, которая не вынесена в модули, повторена здесь дословно
 * (с указанием файла и строки), чтобы проверить её с подменённой датой.
 * «НАХОДКА» — поведение, которое пока не исправлено (ДТ-05, ДТ-08…ДТ-11):
 * после исправления такие проверки нужно перевернуть.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseISO, format } from 'date-fns';
import { localDateISO, formatDate, formatDateTime, localDateOf, fileStamp } from '../../src/lib/dates';
import { daysInMonth, isWeekend, codeForDay, timesheetTotals, employedInMonth } from '../../src/lib/timesheet';
import { turnoverByMonth } from '../../src/lib/turnover';
import { monthNotEnded, previousMonth } from '../../src/lib/archiveMonth';
import { vacationBalance, vacationExcess } from '../../src/lib/vacation';
import { isIsoDate } from '../../src/lib/validation';
import { parseDate } from '../../src/lib/employeeExchange';
import { addMonths, endOfDay } from '../../license-server/src/core/rules';
import type { Employee } from '../../src/data/types';

const at = (local: string) => vi.setSystemTime(new Date(local)); // строка без Z — местное время
afterEach(() => vi.useRealTimers());
const emp = (o: Partial<Employee> = {}): Employee => ({ id: 'e1', fullName: 'Тест', position: 'Инж', department: 'IT', status: 'active', hireDate: '2024-03-01', ...o });

describe('окружение', () => {
  it('часовой пояс — Ашхабад (UTC+5)', () => {
    expect(new Date('2027-01-01T00:00:00').getTimezoneOffset()).toBe(-300);
  });
});

describe('lib/dates', () => {
  it('localDateISO в 00:30 1 января даёт новый год, а не UTC-вчера', () => {
    vi.useFakeTimers(); at('2027-01-01T00:30:00');
    expect(localDateISO()).toBe('2027-01-01');
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-12-31'); // для сравнения: так ошибается toISOString
    expect(fileStamp()).toMatch(/^2027-01-01-00-30-/);
  });
  it('события журнала в 23:30 UTC 31.12 показываются 1 января местного', () => {
    expect(formatDateTime('2026-12-31T19:30:00.000Z', 'dd.MM.yyyy')).toBe('01.01.2027 00:30');
    expect(localDateOf('2026-12-31T19:30:00.000Z')).toBe('2027-01-01');
  });
  it('формат даты не путает календарный год с «недельным» (31.12.2024 пятн., 29.12.2025 пн.)', () => {
    for (const f of ['dd.MM.yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy'] as const) {
      expect(formatDate('2025-12-29', f)).toContain('2025');
      expect(format(new Date(2025, 11, 29), f)).toContain('2025'); // date-fns в LicenseSettings
    }
  });
});

describe('табель на стыке годов', () => {
  it('переход месяца декабрь → январь (Timesheet.tsx:148)', () => {
    const next = new Date(2026, 11 + 1, 1);
    expect([next.getFullYear(), next.getMonth()]).toEqual([2027, 0]);
    const prev = new Date(2027, 0 - 1, 1);
    expect([prev.getFullYear(), prev.getMonth()]).toEqual([2026, 11]);
  });
  it('дни месяца и выходные', () => {
    expect(daysInMonth(2026, 11)).toBe(31);
    expect(daysInMonth(2027, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
    expect(isWeekend(2027, 0, 1)).toBe(false); // 1 января 2027 — пятница
  });
  it('НАХОДКА: 1 января (праздник) по умолчанию — явка «Я», 8 часов', () => {
    expect(codeForDay({}, 2027, 0, 1)).toBe('Я');
    const jan = timesheetTotals({}, 2027, 0);
    expect(jan.workDays).toBe(21); // 31 день − 10 выходных; праздники не учтены
    expect(jan.hours).toBe(168);
  });
  it('уволенный 31.12 не попадает в январский табель', () => {
    const r = { from: '2020-01-01', to: '2026-12-31' };
    expect(employedInMonth(r, 2026, 11)).toBe(true);
    expect(employedInMonth(r, 2027, 0)).toBe(false);
  });
});

describe('Архив: «Закрыть месяц» — ИСПРАВЛЕНО (ДТ-01)', () => {
  it('в ноябре предлагает октябрь того же года', () => {
    vi.useFakeTimers(); at('2026-11-05T10:00:00');
    expect(previousMonth()).toEqual({ year: 2026, month: 9 });
  });
  it('в январе предлагает декабрь прошлого года', () => {
    vi.useFakeTimers(); at('2027-01-10T10:00:00');
    expect(previousMonth()).toEqual({ year: 2026, month: 11 });
  });
  it('закрытие незаконченного месяца распознаётся (будет вопрос)', () => {
    vi.useFakeTimers(); at('2027-01-10T10:00:00');
    expect(monthNotEnded(2027, 11)).toBe(true);
    expect(monthNotEnded(2027, 0)).toBe(true);
    expect(monthNotEnded(2026, 11)).toBe(false);
  });
});

describe('Отпуска: остаток — ИСПРАВЛЕНО (ДТ-03, ДТ-04)', () => {
  const crossYear = { employeeId: 'e1', type: 'vacation', status: 'approved', dateFrom: '2026-12-25', dateTo: '2027-01-14', days: 21 };
  it('отпуск через Новый год делится: 7 дней в 2026, 14 — в 2027', () => {
    expect(vacationBalance([crossYear], 'e1', 2026, 24).used).toBe(7);
    expect(vacationBalance([crossYear], 'e1', 2027, 24).used).toBe(14);
  });
  it('в декабре заявка на январь сверяется с остатком 2027 года', () => {
    const used24 = { ...crossYear, dateFrom: '2026-07-01', dateTo: '2026-07-24', days: 24 };
    expect(vacationExcess([used24], { employeeId: 'e1', dateFrom: '2027-01-11', dateTo: '2027-01-20', days: 10 }, 24)).toEqual([]);
  });
  it('1 января остаток — норма нового года (переноса неиспользованных дней нет — вопрос к постановке)', () => {
    expect(vacationBalance([{ ...crossYear, dateFrom: '2026-06-01', dateTo: '2026-06-10', days: 10 }], 'e1', 2027, 24).left).toBe(24);
  });
});

describe('Календарь', () => {
  // Сам календарь (ДТ-02, ИСПРАВЛЕНО) проверяется в браузере: yearRollover.spec.ts.
  const inYear = (d: Date, y: number) => new Date(y, d.getMonth(), d.getDate());
  it('день рождения 29 февраля в невисокосный год переезжает на 1 марта', () => {
    expect(localDateISO(inYear(parseISO('2000-02-29'), 2027))).toBe('2027-03-01');
  });
});

describe('Дашборд: «Дни рождения сегодня» (Dashboard.tsx:37-47)', () => {
  const todays = (birth: string) => {
    const today = new Date();
    const [, m, d] = birth.split('-');
    return parseInt(m, 10) === today.getMonth() + 1 && parseInt(d, 10) === today.getDate();
  };
  it('1 января в 00:10 — правильно, по местному времени', () => {
    vi.useFakeTimers(); at('2027-01-01T00:10:00');
    expect(todays('1985-01-01')).toBe(true);
  });
  it('29 февраля не отмечается ни разу в невисокосном году', () => {
    vi.useFakeTimers();
    at('2027-02-28T10:00:00'); expect(todays('2000-02-29')).toBe(false);
    at('2027-03-01T10:00:00'); expect(todays('2000-02-29')).toBe(false);
  });
});

describe('Отчёты', () => {
  it('дата в PDF «Списочной численности» по местному времени — ИСПРАВЛЕНО (ДТ-07)', () => {
    vi.useFakeTimers(); at('2027-01-01T03:00:00');
    expect(formatDate(localDateISO(), 'dd.MM.yyyy')).toBe('01.01.2027');
  });
  it('по умолчанию в январе открывается новый год/январь (Reports.tsx:59)', () => {
    vi.useFakeTimers(); at('2027-01-01T09:00:00');
    const now = new Date();
    expect({ year: now.getFullYear(), month: now.getMonth() }).toEqual({ year: 2027, month: 0 });
  });
  it('текучесть: уволенный 31.12 считается в декабре, принятый 01.01 — в январе', () => {
    const list = [emp({ id: 'x', hireDate: '2020-01-01', dismissalDate: '2026-12-31', status: 'dismissed' }), emp({ id: 'y', hireDate: '2027-01-01' })];
    const y26 = turnoverByMonth(list, [], 2026);
    const y27 = turnoverByMonth(list, [], 2027);
    expect(y26.months[11]).toMatchObject({ dismissed: 1, end: 1 });
    expect(y26.year.hired).toBe(0);
    expect(y27.months[0]).toMatchObject({ hired: 1, start: 1, dismissed: 0 });
    expect(y27.year.dismissed).toBe(0);
  });
});

describe('Оценка: список кварталов (Performance.tsx:17-20)', () => {
  const periodOptions = () => { const y = new Date().getFullYear(); return [y + 1, y, y - 1].flatMap(yy => [4, 3, 2, 1].map(q => `${yy}-Q${q}`)); };
  const currentPeriod = () => { const n = new Date(); return `${n.getFullYear()}-Q${Math.floor(n.getMonth() / 3) + 1}`; };
  it('1 января текущий квартал — 2027-Q1, а 2026-Q4 ещё в списке', () => {
    vi.useFakeTimers(); at('2027-01-01T00:00:01');
    expect(currentPeriod()).toBe('2027-Q1');
    expect(periodOptions()).toContain('2026-Q4');
  });
  it('с 2028 года цели демо-данных (2026-Q2/Q3) пропадают из списков выбора', () => {
    vi.useFakeTimers(); at('2028-01-01T09:00:00');
    expect(periodOptions()).not.toContain('2026-Q3');
  });
});

describe('Проверка и импорт дат', () => {
  it('29.02 — только в високосные годы', () => {
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-12-31')).toBe(true);
    expect(isIsoDate('2027-01-01')).toBe(true);
  });
  it('импорт: 31.12.2026, 01.01.2027 и номера дней Excel', () => {
    expect(parseDate('31.12.2026')).toBe('2026-12-31');
    expect(parseDate('01.01.2027')).toBe('2027-01-01');
    expect(parseDate(46387)).toBe('2026-12-31');
    expect(parseDate(46388)).toBe('2027-01-01');
    expect(parseDate(new Date(2027, 0, 1))).toBe('2027-01-01');
  });
});

describe('Сервер лицензий: сроки через Новый год', () => {
  it('+1 месяц от 31.12 → 31.01, +2 → 28.02, конец дня в UTC', () => {
    const d = new Date(Date.UTC(2026, 11, 31, 10));
    expect(addMonths(d, 1).toISOString().slice(0, 10)).toBe('2027-01-31');
    expect(addMonths(d, 2).toISOString().slice(0, 10)).toBe('2027-02-28');
    expect(addMonths(d, 12).toISOString().slice(0, 10)).toBe('2027-12-31');
    expect(endOfDay(d).toISOString()).toBe('2026-12-31T23:59:59.000Z');
  });
  it('«оплачено до 31.12.2026 23:59:59 UTC» в Ашхабаде показывается как 01.01.2027 (LicenseSettings.tsx:16)', () => {
    expect(format(new Date('2026-12-31T23:59:59Z'), 'dd.MM.yyyy')).toBe('01.01.2027');
  });
});
