/**
 * Остаток отпуска по календарным годам.
 *
 * Раньше заявка целиком относилась к году своей первой даты: отпуск
 * 25.12–14.01 списывался с уходящего года полностью, а новому не доставалось
 * ни дня. И в декабре заявка на январь сверялась с остатком уходящего года.
 * Теперь дни заявки делятся по годам, и каждый год считается отдельно.
 */

export interface VacationRequestLike {
  employeeId: string;
  type: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  days: number;
}

export interface VacationBalance {
  used: number;
  pending: number;
  left: number;
}

/** Календарных дней в интервале ГГГГ-ММ-ДД, включая обе границы. */
export function daysBetween(from: string, to: string): number {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

/** Годы, на которые приходится интервал. */
export function yearsOf(range: { dateFrom: string; dateTo: string }): number[] {
  const from = Number(range.dateFrom.slice(0, 4));
  const to = Number(range.dateTo.slice(0, 4));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Сколько дней интервала приходится на год. */
export function daysInYear(range: { dateFrom: string; dateTo: string; days?: number }, year: number): number {
  const first = `${year}-01-01`;
  const last = `${year}-12-31`;
  if (range.dateTo < first || range.dateFrom > last) return 0;
  // Заявка внутри года — берём сохранённое число дней, как и раньше.
  if (range.dateFrom >= first && range.dateTo <= last && typeof range.days === 'number') return range.days;
  return daysBetween(range.dateFrom < first ? first : range.dateFrom, range.dateTo > last ? last : range.dateTo);
}

/** Остаток отпуска сотрудника на год: норма минус согласованные дни этого года. */
export function vacationBalance(
  requests: VacationRequestLike[],
  employeeId: string,
  year: number,
  annualDays: number,
): VacationBalance {
  let used = 0;
  let pending = 0;
  for (const r of requests) {
    if (r.employeeId !== employeeId || r.type !== 'vacation') continue;
    const days = daysInYear(r, year);
    if (days === 0) continue;
    if (r.status === 'approved') used += days;
    else if (r.status === 'pending') pending += days;
  }
  return { used, pending, left: annualDays - used };
}

export interface YearExcess {
  year: number;
  /** Дней заявки в этом году. */
  days: number;
  /** Остаток этого года без учёта самой заявки. */
  left: number;
}

/**
 * Годы, в которых дней заявки больше остатка. Сама заявка, если уже
 * сохранена, в остаток не входит: согласованной она ещё не была.
 */
export function vacationExcess(
  requests: VacationRequestLike[],
  request: Pick<VacationRequestLike, 'employeeId' | 'dateFrom' | 'dateTo'> & { days?: number },
  annualDays: number,
  exclude?: VacationRequestLike,
): YearExcess[] {
  const others = exclude ? requests.filter(r => r !== exclude) : requests;
  return yearsOf(request)
    .map(year => ({
      year,
      days: daysInYear(request, year),
      left: vacationBalance(others, request.employeeId, year, annualDays).left,
    }))
    .filter(e => e.days > e.left);
}
