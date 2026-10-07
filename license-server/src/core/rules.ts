/**
 * The business rules of LICENSING.md: plans, dates, the lease invariant,
 * renewal. Pure functions, shared by the server, the License Manager and the
 * console utility, so there is one implementation of each rule.
 */

export type PlanCode = 'PERPETUAL' | 'ANNUAL' | 'QUARTERLY' | 'MONTHLY';
export type ActivationMode = 'ONLINE' | 'OFFLINE';

/** A row of the `plans` table (2.2). */
export interface PlanParams {
  code: PlanCode;
  term_months: number | null;
  lease_days_online: number;
  refresh_after_days: number;
  grace_days: number;
  warn_lease_days: number;
  warn_paid_days: number;
  clock_tolerance_hours: number;
  max_transfers_per_year: number;
  allowed_modes: ActivationMode[];
}

const COMMON = {
  lease_days_online: 30,
  refresh_after_days: 7,
  grace_days: 7,
  warn_lease_days: 7,
  warn_paid_days: 14,
  clock_tolerance_hours: 48,
  max_transfers_per_year: 2
};

/** 2.1: MONTHLY is not sold offline. */
export const DEFAULT_PLANS: PlanParams[] = [
  { code: 'PERPETUAL', term_months: null, ...COMMON, allowed_modes: ['ONLINE', 'OFFLINE'] },
  { code: 'ANNUAL', term_months: 12, ...COMMON, allowed_modes: ['ONLINE', 'OFFLINE'] },
  { code: 'QUARTERLY', term_months: 3, ...COMMON, allowed_modes: ['ONLINE', 'OFFLINE'] },
  { code: 'MONTHLY', term_months: 1, ...COMMON, allowed_modes: ['ONLINE'] }
];

export const FP_THRESHOLD = 2;

const DAY = 86_400_000;

/** ISO 8601 in UTC without milliseconds, the form the spec shows. */
export const iso = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

export const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY);

export const endOfDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59));

/**
 * Calendar months, clamped to the last day of the target month (5.4):
 * 31.01 + 1 month = 28.02, 29.02 in a leap year.
 */
export function addMonths(date: Date, months: number): Date {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

/**
 * Where a paid extension starts (5.4). Paid before paid_until + grace ends:
 * from the old paid_until, so the customer loses no days. Paid later: from
 * the payment date, so nobody pays for time they did not use.
 */
export function renewalStart(paidUntil: Date | null, graceDays: number, paidOn: Date): Date {
  if (!paidUntil) return paidOn;
  return paidOn <= addDays(paidUntil, graceDays) ? paidUntil : paidOn;
}

/** The new paid_until after paying for `periods` terms on `paidOn`. */
export function renewedPaidUntil(plan: PlanParams, paidUntil: Date | null, graceDays: number,
  paidOn: Date, periods = 1): Date {
  if (plan.term_months === null) throw new RuleError('PERPETUAL_NOT_RENEWABLE', 'Бессрочную лицензию не продлевают');
  const start = renewalStart(paidUntil, graceDays, paidOn);
  return endOfDay(addMonths(start, plan.term_months * periods));
}

/** A rule broken by a request; `code` is stable for API clients and tests. */
export class RuleError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** 2.1: what may be sold. Test 20. */
export function assertSellable(plan: PlanParams, mode: ActivationMode): void {
  if (!plan.allowed_modes.includes(mode)) {
    throw new RuleError('MODE_NOT_ALLOWED', plan.code === 'MONTHLY' && mode === 'OFFLINE'
      ? 'MONTHLY + OFFLINE не продаётся: без интернета — предоплата минимум за 3 месяца одним файлом (2.1)'
      : `Тариф ${plan.code} не продаётся в режиме ${mode}`);
  }
}

export interface FileTerms {
  paid_until: string | null;
  lease_until: string | null;
  refresh_after: string | null;
}

/**
 * The trust dates of one issued file (1, 2.1).
 *
 * OFFLINE: the file carries the whole paid period, lease = paid + grace.
 * ONLINE: a short lease that the client renews in the background, but never
 * past paid + grace. Perpetual: neither date.
 */
export function fileTerms(plan: PlanParams, mode: ActivationMode, paidUntil: Date | null,
  graceDays: number, now: Date): FileTerms {
  if (plan.term_months === null || paidUntil === null) {
    return { paid_until: null, lease_until: null, refresh_after: null };
  }
  const paidEnd = addDays(paidUntil, graceDays);
  if (mode === 'OFFLINE') {
    return { paid_until: iso(paidUntil), lease_until: iso(paidEnd), refresh_after: null };
  }
  const lease = new Date(Math.min(addDays(now, plan.lease_days_online).getTime(), paidEnd.getTime()));
  return {
    paid_until: iso(paidUntil),
    lease_until: iso(lease),
    refresh_after: iso(addDays(now, plan.refresh_after_days))
  };
}

/** The server invariant (1): a file is never trusted longer than paid for. Test 15. */
export function assertLeaseInvariant(payload: { paid_until: string | null; lease_until: string | null; grace_days: number }): void {
  if (payload.paid_until === null) {
    if (payload.lease_until !== null) {
      throw new RuleError('INVARIANT', 'lease_until без paid_until недопустим', 500);
    }
    return;
  }
  if (payload.lease_until === null) throw new RuleError('INVARIANT', 'У подписки должен быть lease_until', 500);
  const limit = addDays(new Date(payload.paid_until), payload.grace_days);
  if (new Date(payload.lease_until) > limit) {
    throw new RuleError('INVARIANT', `lease_until ${payload.lease_until} > paid_until + grace_days`, 500);
  }
}

/** Components that match and are not empty (4.1). */
export function fingerprintMatches(a: Fingerprint, b: Fingerprint): number {
  return (['mg', 'smbios', 'disk'] as const).filter(c => a[c] && a[c] === b[c]).length;
}

export interface Fingerprint {
  mg: string;
  smbios: string;
  disk: string;
}
