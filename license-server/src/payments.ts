/**
 * Payment webhooks (stage 6, LICENSING.md 5.4): a payment system - or a
 * bank, an accounting system, a till - tells the server that a licence was
 * paid, and the licence is extended by the same rule as a renewal by hand.
 *
 * One provider-neutral format rather than one provider's: whichever system
 * is chosen, connecting it is a small adapter to this contract.
 *
 *   POST /v1/payments/<source>
 *   Content-Type: application/json
 *   X-HRD-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 *   { "payment_id": "unique in the sender",           required
 *     "license_id": "HRD-2026-000001",                one of these two
 *     "license_key": "HRD-XXXXX-XXXXX-XXXXX-XXXXX",
 *     "periods": 1,                                   terms paid for, default 1
 *     "amount": 1200, "currency": "TMT",              for the books, optional
 *     "paid_at": "2026-10-01T09:30:00Z" }             default: now
 *
 * The timestamp inside the signature stops an intercepted notification from
 * being replayed later; the payment id stops a legitimate retry from paying
 * twice.
 */

import crypto from 'node:crypto';
import type { Db } from './db.ts';
import { RuleError, iso } from './core/rules.ts';
import { hashLicenseKey, normalizeLicenseKey } from './core/licenseKey.ts';
import type { LicenseService } from './service.ts';

/** How old a signed notification may be. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const SOURCE_NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export interface WebhookSourceRow {
  name: string;
  status: 'ACTIVE' | 'DISABLED';
  created_at: string;
  last_used: string | null;
}

/** A new sender; the secret is returned here and never shown again. */
export function createWebhookSource(service: LicenseService, name: string, actor: string): { name: string; secret: string } {
  if (!SOURCE_NAME.test(name)) {
    throw new RuleError('VALIDATION', 'Имя источника: 2–32 символа, латиница в нижнем регистре, цифры, - и _');
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  try {
    service.db.prepare('INSERT INTO webhook_sources (name, secret, created_at) VALUES (?, ?, ?)')
      .run(name, secret, iso(new Date()));
  } catch {
    throw new RuleError('VALIDATION', `Источник ${name} уже есть`);
  }
  service.event(actor, 'WEBHOOK_SOURCE_CREATED', { name });
  return { name, secret };
}

export function listWebhookSources(db: Db): WebhookSourceRow[] {
  return db.prepare('SELECT name, status, created_at, last_used FROM webhook_sources ORDER BY name')
    .all() as unknown as WebhookSourceRow[];
}

export function setWebhookSourceStatus(service: LicenseService, name: string, status: 'ACTIVE' | 'DISABLED', actor: string) {
  const changed = service.db.prepare('UPDATE webhook_sources SET status = ? WHERE name = ?').run(status, name).changes;
  if (!changed) throw new RuleError('NOT_FOUND', 'Источник не найден', 404);
  service.event(actor, status === 'ACTIVE' ? 'WEBHOOK_SOURCE_ENABLED' : 'WEBHOOK_SOURCE_DISABLED', { name },
    { severity: status === 'DISABLED' ? 'warning' : 'info' });
}

/** The header a sender puts on a request; exported for senders' tests and adapters. */
export function signPayload(secret: string, rawBody: Buffer | string, timestamp: number): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

function signatureValid(secret: string, header: string | undefined, rawBody: Buffer, now: Date): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map(part => part.trim().split('=') as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !parts.v1) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signPayload(secret, rawBody, timestamp).split('v1=')[1], 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export interface WebhookResult {
  ok: true;
  duplicate: boolean;
  license_id: string;
  paid_until: string | null;
  /** OFFLINE: the new files are the seller's to issue and send (5.3). */
  files_needed: boolean;
}

export function handlePaymentWebhook(
  service: LicenseService,
  sourceName: string,
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
  now = new Date()
): WebhookResult {
  const source = service.db.prepare('SELECT * FROM webhook_sources WHERE name = ?').get(sourceName) as
    ({ secret: string; status: string } | undefined);
  // One answer for every way of failing authentication: a prober learns
  // nothing about which sources exist.
  const unauthorised = () => {
    service.event(`webhook:${sourceName}`, 'WEBHOOK_REJECTED', {}, { severity: 'warning' });
    return new RuleError('BAD_SIGNATURE', 'Подпись уведомления неверна или устарела', 401);
  };
  if (!rawBody) throw new RuleError('BAD_REQUEST', 'Нужно тело application/json');
  if (!source || source.status !== 'ACTIVE' || !signatureValid(source.secret, signatureHeader, rawBody, now)) {
    throw unauthorised();
  }
  service.db.prepare('UPDATE webhook_sources SET last_used = ? WHERE name = ?').run(iso(now), sourceName);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new RuleError('BAD_JSON', 'Тело уведомления — не JSON');
  }

  const paymentId = typeof body.payment_id === 'string' ? body.payment_id.trim() : '';
  if (!paymentId || paymentId.length > 128) throw new RuleError('VALIDATION', 'payment_id обязателен (до 128 символов)');
  const sourceTag = `webhook:${sourceName}`;

  const licenseId = resolveLicense(service, body);
  const previous = service.db.prepare('SELECT license_id FROM payments WHERE source = ? AND external_id = ?')
    .get(sourceTag, paymentId) as { license_id: string } | undefined;
  if (previous) {
    const license = service.license(previous.license_id);
    return { ok: true, duplicate: true, license_id: license.id, paid_until: license.paid_until, files_needed: false };
  }

  let paidOn: string | undefined;
  if (body.paid_at !== undefined) {
    const at = new Date(String(body.paid_at));
    if (Number.isNaN(at.getTime())) throw new RuleError('VALIDATION', 'paid_at — дата ISO 8601');
    // A date in the future would only ever push the new term further out.
    if (at.getTime() > now.getTime() + 86_400_000) throw new RuleError('VALIDATION', 'paid_at в будущем');
    paidOn = at.toISOString();
  }
  if (body.amount !== undefined && body.amount !== null && typeof body.amount !== 'number') {
    throw new RuleError('VALIDATION', 'amount — число');
  }
  if (body.currency !== undefined && body.currency !== null && (typeof body.currency !== 'string' || body.currency.length > 8)) {
    throw new RuleError('VALIDATION', 'currency — строка до 8 символов');
  }

  let license;
  try {
    ({ license } = service.applyPayment(licenseId, {
      periods: body.periods === undefined ? 1 : Number(body.periods),
      paid_on: paidOn,
      amount: (body.amount as number | null | undefined) ?? null,
      currency: (body.currency as string | null | undefined) ?? null,
      external_id: paymentId
    }, sourceTag, { source: sourceTag, issueFiles: false }));
  } catch (error) {
    // The money arrived even if the licence cannot take it (revoked,
    // perpetual): the seller has to see that, not just the sender.
    service.event(sourceTag, 'PAYMENT_NOT_APPLIED',
      { payment_id: paymentId, reason: (error as Error).message, amount: body.amount ?? null, currency: body.currency ?? null },
      { license_id: licenseId, severity: 'warning' });
    throw error;
  }

  const filesNeeded = license.activation_mode === 'OFFLINE';
  service.event(sourceTag, 'PAYMENT_RECEIVED', { payment_id: paymentId, paid_until: license.paid_until, files_needed: filesNeeded },
    { license_id: license.id, severity: filesNeeded ? 'warning' : 'info' });
  return { ok: true, duplicate: false, license_id: license.id, paid_until: license.paid_until, files_needed: filesNeeded };
}

function resolveLicense(service: LicenseService, body: Record<string, unknown>): string {
  if (typeof body.license_id === 'string' && body.license_id.trim()) {
    return service.license(body.license_id.trim()).id;
  }
  if (typeof body.license_key === 'string') {
    const key = normalizeLicenseKey(body.license_key);
    const row = key
      ? service.db.prepare('SELECT id FROM licenses WHERE key_hash = ?').get(hashLicenseKey(key)) as { id: string } | undefined
      : undefined;
    if (row) return row.id;
    throw new RuleError('NOT_FOUND', 'Лицензии с таким ключом нет', 404);
  }
  throw new RuleError('VALIDATION', 'Нужен license_id или license_key');
}
