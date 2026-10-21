import { describe, expect, it } from 'vitest';
import { daysBetween, daysInYear, vacationBalance, vacationExcess, yearsOf } from '../../src/lib/vacation';
import { monthNotEnded, previousMonth } from '../../src/lib/archiveMonth';

/**
 * Стык годов (протокол KADRA_DATE_TEST_REPORT_2026-10-21, ДТ-01, ДТ-03, ДТ-04).
 */

const req = (over: Partial<Parameters<typeof vacationBalance>[0][number]> = {}) => ({
  employeeId: 'e1', type: 'vacation', status: 'approved', dateFrom: '2026-12-25', dateTo: '2027-01-14', days: 21, ...over,
});

describe('закрытие месяца', () => {
  it('в январе по умолчанию — декабрь прошлого года (ДТ-01)', () => {
    expect(previousMonth(new Date(2027, 0, 10))).toEqual({ year: 2026, month: 11 });
    expect(previousMonth(new Date(2027, 0, 1, 0, 0, 1))).toEqual({ year: 2026, month: 11 });
  });

  it('в остальные месяцы — прошлый месяц того же года', () => {
    expect(previousMonth(new Date(2026, 10, 5))).toEqual({ year: 2026, month: 9 });
    expect(previousMonth(new Date(2027, 2, 31))).toEqual({ year: 2027, month: 1 });
  });

  it('незаконченный месяц распознаётся, в том числе будущий', () => {
    const today = new Date(2027, 0, 10, 12);
    expect(monthNotEnded(2026, 11, today)).toBe(false);
    expect(monthNotEnded(2027, 0, today)).toBe(true);
    expect(monthNotEnded(2027, 11, today)).toBe(true);
    // последний день месяца: дней после сегодняшнего нет
    expect(monthNotEnded(2026, 11, new Date(2026, 11, 31, 23, 59))).toBe(false);
  });
});

describe('отпуск по годам', () => {
  it('дни интервала и годы', () => {
    expect(daysBetween('2026-12-25', '2027-01-14')).toBe(21);
    expect(yearsOf({ dateFrom: '2026-12-25', dateTo: '2027-01-14' })).toEqual([2026, 2027]);
    expect(daysInYear(req(), 2026)).toBe(7);
    expect(daysInYear(req(), 2027)).toBe(14);
    expect(daysInYear(req(), 2028)).toBe(0);
  });

  it('заявка внутри года считается по сохранённому числу дней', () => {
    expect(daysInYear(req({ dateFrom: '2026-08-15', dateTo: '2026-08-28', days: 14 }), 2026)).toBe(14);
  });

  it('отпуск через Новый год делится между годами (ДТ-03)', () => {
    expect(vacationBalance([req()], 'e1', 2026, 24)).toEqual({ used: 7, pending: 0, left: 17 });
    expect(vacationBalance([req()], 'e1', 2027, 24)).toEqual({ used: 14, pending: 0, left: 10 });
  });

  it('заявки на согласовании, чужие и не отпуск не уменьшают остаток', () => {
    const list = [
      req({ status: 'pending' }),
      req({ employeeId: 'e2' }),
      req({ type: 'sick' }),
      req({ status: 'rejected' }),
    ];
    expect(vacationBalance(list, 'e1', 2027, 24)).toEqual({ used: 0, pending: 14, left: 24 });
  });

  it('в декабре заявка на январь сверяется с остатком следующего года (ДТ-04)', () => {
    const usedUp = req({ dateFrom: '2026-07-01', dateTo: '2026-07-24', days: 24 });
    const january = { employeeId: 'e1', dateFrom: '2027-01-11', dateTo: '2027-01-20', days: 10 };
    expect(vacationExcess([usedUp], january, 24)).toEqual([]);
  });

  it('превышение показывается для того года, где не хватает дней', () => {
    const usedUp = req({ dateFrom: '2026-07-01', dateTo: '2026-07-24', days: 24 });
    const overNewYear = { employeeId: 'e1', dateFrom: '2026-12-28', dateTo: '2027-01-05', days: 9 };
    expect(vacationExcess([usedUp], overNewYear, 24)).toEqual([{ year: 2026, days: 4, left: 0 }]);
  });

  it('согласуемая заявка не учитывается в собственном остатке', () => {
    const pending = req({ status: 'pending', dateFrom: '2027-03-01', dateTo: '2027-03-24', days: 24 });
    expect(vacationExcess([pending], pending, 24, pending)).toEqual([]);
  });
});
