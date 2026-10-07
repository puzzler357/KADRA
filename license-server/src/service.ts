/**
 * Everything the seller can do with licences, in one place (5, 7, 10).
 *
 * The License Manager, POST /v1/offline/process, the console utility and -
 * from stage 4 - the online endpoints all call this class, so a file comes out
 * the same whichever way the request came in (5.1: "одним и тем же кодом").
 *
 * A device request is handled in two steps. `decide` works out what the
 * request amounts to without touching anything, which is what the License
 * Manager shows for approval; `process` applies that decision.
 */

import crypto from 'node:crypto';
import { inTransaction, nextValue, type Db } from './db.ts';
import {
  assertLeaseInvariant, assertSellable, endOfDay, addMonths, fileTerms, fingerprintMatches, iso,
  renewedPaidUntil, RuleError, FP_THRESHOLD,
  type ActivationMode, type Fingerprint, type PlanCode, type PlanParams
} from './core/rules.ts';
import { seal, sha256, verifyRequest, type RequestPayload, type Signer } from './core/envelope.ts';
import { generateLicenseKey, hashLicenseKey, normalizeLicenseKey } from './core/licenseKey.ts';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface CustomerRow {
  id: string;
  name: string;
  contact: string;
  email: string;
  phone: string;
  status: string;
  created_at: string;
}

export interface LicenseRow {
  id: string;
  customer_id: string;
  plan: PlanCode;
  activation_mode: ActivationMode;
  seats: number;
  edition: string;
  features: string;
  paid_until: string | null;
  grace_days: number;
  max_version: string | null;
  status: string;
  created_at: string;
}

export interface ActivationRow {
  id: string;
  license_id: string;
  device_name: string;
  fp: string;
  device_pubkey: string;
  status: 'ACTIVE' | 'RELEASED' | 'REVOKED' | 'FORK_SUSPECTED';
  first_seen: string;
  last_seen: string;
  last_counter: number;
  current_revision: number;
}

/** A signed file ready to hand over. */
export interface IssuedFile {
  filename: string;
  content: string;
  kind: string;
  license_id: string;
  activation_id: string;
  revision: number;
}

export type DecisionAction =
  | 'ACTIVATE_NEW'
  | 'REISSUE_SAME_DEVICE'
  | 'REBIND'
  | 'TRANSFER'
  | 'DEACTIVATE';

/** What a request amounts to - shown in the License Manager before approval. */
export interface Decision {
  request: {
    type: string;
    device_name: string;
    device_key: string;
    app_version: string;
    client_time: string;
    license_key_hint: string | null;
  };
  action: DecisionAction | null;
  license: (LicenseRow & { customer_name: string }) | null;
  activation: ActivationRow | null;
  fp_match: number | null;
  seats: { used: number; total: number } | null;
  transfers: { last_year: number; limit: number } | null;
  /** Active activations a transfer could free, when the seats are full. */
  transfer_candidates: ActivationRow[];
  /** Why it cannot go ahead as is. */
  blocked: { code: string; message: string } | null;
  /** A transfer: the seller must approve it explicitly. */
  needs_approval: boolean;
}

export interface ProcessOptions {
  actor: string;
  /** The seller approves a transfer (7.2: a broken old computer). */
  approveTransfer?: boolean;
  /** For ACTIVATE with full seats: the activation the new device replaces. */
  transferFrom?: string;
  /** Past max_transfers_per_year - only with the seller's explicit decision. */
  overrideTransferLimit?: boolean;
}

export interface ProcessResult {
  decision: Decision;
  file: IssuedFile | null;
}

const LIVE = "status IN ('ACTIVE', 'FORK_SUSPECTED')";

/**
 * How a payment entered by hand arrived (10.1 `payments.source`). Payments
 * reported by a payment system's webhook (stage 6) will carry that system's
 * own source, so every way of paying ends up in the one table.
 */
export const MANUAL_PAYMENT_SOURCES = ['cash', 'bank_transfer', 'card', 'other'] as const;
export type ManualPaymentSource = typeof MANUAL_PAYMENT_SOURCES[number];

export interface RenewalInput {
  periods?: number;
  paid_on?: string;
  amount?: number | null;
  currency?: string | null;
  external_id?: string | null;
}

/** More automatic rebinds of one seat in 30 days than this is suspicious. */
const REBINDS_PER_MONTH = 3;

export class LicenseService {
  readonly db: Db;
  private readonly signer: Signer | null;
  private readonly clock: Clock;

  constructor(db: Db, signer: Signer | null, clock: Clock = systemClock) {
    this.db = db;
    this.signer = signer;
    this.clock = clock;
  }

  // ---------------------------------------------------------------- journal

  event(actor: string, action: string, details: Record<string, unknown> = {},
    refs: { license_id?: string | null; activation_id?: string | null; severity?: 'info' | 'warning' } = {}) {
    this.db.prepare(`INSERT INTO events (at, actor, action, severity, license_id, activation_id, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(iso(this.clock.now()), actor, action, refs.severity ?? 'info', refs.license_id ?? null,
        refs.activation_id ?? null, JSON.stringify(details));
  }

  // ---------------------------------------------------------------- lookups

  plan(code: string): PlanParams {
    const row = this.db.prepare('SELECT * FROM plans WHERE code = ?').get(code) as
      (Omit<PlanParams, 'allowed_modes'> & { allowed_modes: string }) | undefined;
    if (!row) throw new RuleError('UNKNOWN_PLAN', `Неизвестный тариф ${code}`);
    return { ...row, allowed_modes: row.allowed_modes.split(',') as ActivationMode[] };
  }

  plans(): PlanParams[] {
    return (this.db.prepare('SELECT code FROM plans ORDER BY term_months IS NULL, term_months DESC').all() as { code: string }[])
      .map(row => this.plan(row.code));
  }

  customer(id: string): CustomerRow {
    const row = this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRow | undefined;
    if (!row) throw new RuleError('NOT_FOUND', 'Клиент не найден', 404);
    return row;
  }

  license(id: string): LicenseRow {
    const row = this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(id) as LicenseRow | undefined;
    if (!row) throw new RuleError('NOT_FOUND', 'Лицензия не найдена', 404);
    return row;
  }

  activation(id: string): ActivationRow {
    const row = this.db.prepare('SELECT * FROM activations WHERE id = ?').get(id) as ActivationRow | undefined;
    if (!row) throw new RuleError('NOT_FOUND', 'Активация не найдена', 404);
    return row;
  }

  private liveActivations(licenseId: string): ActivationRow[] {
    return this.db.prepare(`SELECT * FROM activations WHERE license_id = ? AND ${LIVE} ORDER BY first_seen`)
      .all(licenseId) as unknown as ActivationRow[];
  }

  private transfersLastYear(licenseId: string): number {
    const since = iso(new Date(this.clock.now().getTime() - 365 * 86_400_000));
    return Number((this.db.prepare('SELECT count(*) AS n FROM transfers WHERE license_id = ? AND at >= ?')
      .get(licenseId, since) as { n: number }).n);
  }

  // -------------------------------------------------------------- customers

  createCustomer(input: { name: string; contact?: string; email?: string; phone?: string }, actor: string): CustomerRow {
    const name = input.name?.trim();
    if (!name) throw new RuleError('VALIDATION', 'Укажите название клиента');
    const id = `CUST-${String(nextValue(this.db, 'customer')).padStart(6, '0')}`;
    this.db.prepare(`INSERT INTO customers (id, name, contact, email, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, name, input.contact?.trim() ?? '', input.email?.trim() ?? '', input.phone?.trim() ?? '', iso(this.clock.now()));
    this.event(actor, 'CUSTOMER_CREATED', { id, name });
    return this.customer(id);
  }

  updateCustomer(id: string, patch: Partial<Pick<CustomerRow, 'name' | 'contact' | 'email' | 'phone' | 'status'>>, actor: string): CustomerRow {
    const current = this.customer(id);
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === 'string')) };
    if (!next.name.trim()) throw new RuleError('VALIDATION', 'Название клиента не может быть пустым');
    if (!['ACTIVE', 'ARCHIVED'].includes(next.status)) throw new RuleError('VALIDATION', 'Статус: ACTIVE или ARCHIVED');
    this.db.prepare('UPDATE customers SET name = ?, contact = ?, email = ?, phone = ?, status = ? WHERE id = ?')
      .run(next.name.trim(), next.contact, next.email, next.phone, next.status, id);
    this.event(actor, 'CUSTOMER_UPDATED', { id, patch });
    return this.customer(id);
  }

  listCustomers(): (CustomerRow & { licenses: number })[] {
    return this.db.prepare(`SELECT c.*, (SELECT count(*) FROM licenses l WHERE l.customer_id = c.id) AS licenses
      FROM customers c ORDER BY c.name COLLATE NOCASE`).all() as unknown as (CustomerRow & { licenses: number })[];
  }

  // --------------------------------------------------------------- licences

  /**
   * A new licence. The key is returned here and never again: only its hash is
   * stored (10.1), so the License Manager shows it once.
   */
  createLicense(input: {
    customer_id: string;
    plan: string;
    activation_mode: ActivationMode;
    seats?: number;
    edition?: string;
    features?: string[];
    max_version?: string | null;
    start?: string;
  }, actor: string): { license: LicenseRow; license_key: string } {
    const customer = this.customer(input.customer_id);
    const plan = this.plan(input.plan);
    assertSellable(plan, input.activation_mode);
    const seats = Number(input.seats ?? 1);
    if (!Number.isInteger(seats) || seats < 1 || seats > 1000) throw new RuleError('VALIDATION', 'Число мест: целое от 1');

    const now = this.clock.now();
    const start = input.start ? new Date(input.start) : now;
    if (Number.isNaN(start.getTime())) throw new RuleError('VALIDATION', 'Неверная дата начала');
    const paidUntil = plan.term_months === null ? null : iso(endOfDay(addMonths(start, plan.term_months)));

    return inTransaction(this.db, () => {
      const id = `HRD-${now.getUTCFullYear()}-${String(nextValue(this.db, `license-${now.getUTCFullYear()}`)).padStart(6, '0')}`;
      const licenseKey = generateLicenseKey();
      this.db.prepare(`INSERT INTO licenses (id, key_hash, customer_id, plan, activation_mode, seats, edition,
        features, paid_until, grace_days, max_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, hashLicenseKey(licenseKey), customer.id, plan.code, input.activation_mode, seats,
          input.edition?.trim() || 'PRO', JSON.stringify(input.features ?? []), paidUntil, plan.grace_days,
          input.max_version?.trim() || null, iso(now));
      this.event(actor, 'LICENSE_CREATED', { plan: plan.code, mode: input.activation_mode, seats, paid_until: paidUntil },
        { license_id: id });
      return { license: this.license(id), license_key: licenseKey };
    });
  }

  listLicenses(filter: { customer_id?: string } = {}) {
    const where = filter.customer_id ? 'WHERE l.customer_id = ?' : '';
    const args = filter.customer_id ? [filter.customer_id] : [];
    return this.db.prepare(`SELECT l.*, c.name AS customer_name,
        (SELECT count(*) FROM activations a WHERE a.license_id = l.id AND a.${LIVE}) AS seats_used
      FROM licenses l JOIN customers c ON c.id = l.customer_id ${where}
      ORDER BY l.created_at DESC`).all(...args);
  }

  licenseDetails(id: string) {
    const license = this.license(id);
    return {
      license: { ...license, customer_name: this.customer(license.customer_id).name },
      activations: this.db.prepare('SELECT * FROM activations WHERE license_id = ? ORDER BY first_seen').all(id),
      transfers: this.db.prepare('SELECT * FROM transfers WHERE license_id = ? ORDER BY at DESC').all(id),
      files: this.db.prepare('SELECT * FROM issued_files WHERE license_id = ? ORDER BY id DESC LIMIT 50').all(id),
      payments: this.db.prepare('SELECT * FROM payments WHERE license_id = ? ORDER BY id DESC').all(id),
      transfers_last_year: this.transfersLastYear(id),
      plan: this.plan(license.plan)
    };
  }

  /**
   * A paid extension (5.3, 5.4). OFFLINE clients need no request: a new file
   * for every active device comes back from here, ready to send.
   */
  renewLicense(id: string, input: RenewalInput & { source?: string }, actor: string): { license: LicenseRow; files: IssuedFile[] } {
    const source = input.source ?? 'other';
    if (!(MANUAL_PAYMENT_SOURCES as readonly string[]).includes(source)) {
      throw new RuleError('VALIDATION', `Способ оплаты: ${MANUAL_PAYMENT_SOURCES.join(', ')}`);
    }
    return this.applyPayment(id, input, actor, { source, issueFiles: true });
  }

  /**
   * The one place a payment extends a licence (5.4), whoever reports it: the
   * seller by hand, or a payment system's webhook (stage 6).
   *
   * `issueFiles`: hand back new files for OFFLINE devices (5.3). A webhook
   * has nobody to hand them to, so there the seller issues them from the
   * License Manager when sending.
   */
  applyPayment(id: string, input: RenewalInput, actor: string,
    options: { source: string; issueFiles: boolean }): { license: LicenseRow; files: IssuedFile[] } {
    const source = options.source;
    const periods = Number(input.periods ?? 1);
    if (!Number.isInteger(periods) || periods < 1 || periods > 20) throw new RuleError('VALIDATION', 'Число периодов: от 1 до 20');
    const amount = input.amount ?? null;
    if (amount !== null && (!Number.isFinite(Number(amount)) || Number(amount) < 0)) {
      throw new RuleError('VALIDATION', 'Сумма — неотрицательное число');
    }
    const paidOn = input.paid_on ? new Date(input.paid_on) : this.clock.now();
    if (Number.isNaN(paidOn.getTime())) throw new RuleError('VALIDATION', 'Неверная дата оплаты');

    return inTransaction(this.db, () => {
      // Read inside the transaction: two payments for one licence must add up.
      const license = this.license(id);
      if (license.status === 'REVOKED') throw new RuleError('LICENSE_REVOKED', 'Лицензия отозвана', 409);
      const plan = this.plan(license.plan);
      const previous = license.paid_until;
      const paidUntil = iso(renewedPaidUntil(plan, previous ? new Date(previous) : null, license.grace_days, paidOn, periods));

      this.db.prepare('UPDATE licenses SET paid_until = ? WHERE id = ?').run(paidUntil, id);
      this.db.prepare(`INSERT INTO payments (license_id, amount, currency, period_from, period_to, source,
        external_id, paid_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, amount === null ? null : Number(amount), input.currency?.trim() || null, previous, paidUntil, source,
          input.external_id?.trim() || null, iso(paidOn), iso(this.clock.now()));
      this.event(actor, 'LICENSE_RENEWED',
        { from: previous, to: paidUntil, paid_on: iso(paidOn), periods, source, amount, currency: input.currency ?? null },
        { license_id: id });

      // ONLINE clients pick the new date up on their next refresh.
      const files = license.activation_mode === 'OFFLINE' && options.issueFiles
        ? this.liveActivations(id).map(activation => this.issueLicenseFile(activation.id, actor, 'RENEW'))
        : [];
      return { license: this.license(id), files };
    });
  }

  /**
   * Revocation. For ONLINE clients it takes effect at the next refresh; an
   * OFFLINE file keeps working until paid_until + grace (7.3) - nothing on
   * this side can reach it.
   */
  revokeLicense(id: string, reason: string, actor: string): LicenseRow {
    this.license(id);
    inTransaction(this.db, () => {
      this.db.prepare("UPDATE licenses SET status = 'REVOKED' WHERE id = ?").run(id);
      this.db.prepare(`UPDATE activations SET status = 'REVOKED' WHERE license_id = ? AND ${LIVE}`).run(id);
      this.event(actor, 'LICENSE_REVOKED', { reason }, { license_id: id, severity: 'warning' });
    });
    return this.license(id);
  }

  // ------------------------------------------------------------ activations

  releaseActivation(id: string, actor: string, method: 'manual' | 'proof' = 'manual'): ActivationRow {
    const activation = this.activation(id);
    if (activation.status === 'RELEASED') return activation;
    inTransaction(this.db, () => {
      this.db.prepare("UPDATE activations SET status = 'RELEASED', last_seen = ? WHERE id = ?")
        .run(iso(this.clock.now()), id);
      this.db.prepare('INSERT INTO transfers (license_id, from_activation_id, to_activation_id, at, method) VALUES (?, ?, NULL, ?, ?)')
        .run(activation.license_id, id, iso(this.clock.now()), method);
      this.event(actor, 'ACTIVATION_RELEASED', { method }, { license_id: activation.license_id, activation_id: id });
    });
    return this.activation(id);
  }

  private requireSigner(): Signer {
    if (!this.signer) throw new RuleError('NO_SIGNING_KEY', 'Ключ подписи не загружен: выпуск файлов невозможен', 503);
    return this.signer;
  }

  private record(file: IssuedFile, payload: { issued_at: string; paid_until?: string | null; lease_until?: string | null }) {
    this.db.prepare(`INSERT INTO issued_files (license_id, activation_id, revision, kind, issued_at, paid_until,
      lease_until, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(file.license_id, file.activation_id, file.revision, file.kind, payload.issued_at,
        payload.paid_until ?? null, payload.lease_until ?? null, sha256(file.content));
    this.db.prepare('UPDATE activations SET current_revision = ? WHERE id = ?').run(file.revision, file.activation_id);
  }

  /** A licence file (3.2) for one activation at the next revision. */
  issueLicenseFile(activationId: string, actor: string, kind = 'REISSUE'): IssuedFile {
    const signer = this.requireSigner();
    const activation = this.activation(activationId);
    if (activation.status === 'RELEASED') throw new RuleError('ACTIVATION_RELEASED', 'Место освобождено; файл не выпускается');
    const license = this.license(activation.license_id);
    if (license.status === 'REVOKED') throw new RuleError('LICENSE_REVOKED', 'Лицензия отозвана');
    const plan = this.plan(license.plan);
    const now = this.clock.now();
    const revision = Number(activation.current_revision) + 1;
    const terms = fileTerms(plan, license.activation_mode, license.paid_until ? new Date(license.paid_until) : null,
      license.grace_days, now);

    const payload = {
      v: 1,
      license_id: license.id,
      revision,
      customer_id: license.customer_id,
      customer_name: this.customer(license.customer_id).name,
      product: 'HRDESK',
      edition: license.edition,
      features: JSON.parse(license.features) as string[],
      plan: license.plan,
      activation_mode: license.activation_mode,
      seats: Number(license.seats),
      activation: {
        activation_id: activation.id,
        device_name: activation.device_name,
        device_pubkey: activation.device_pubkey,
        fp: JSON.parse(activation.fp) as Fingerprint,
        fp_threshold: FP_THRESHOLD
      },
      issued_at: iso(now),
      paid_until: terms.paid_until,
      grace_days: Number(license.grace_days),
      lease_until: terms.lease_until,
      refresh_after: terms.refresh_after,
      max_version: license.max_version
    };
    assertLeaseInvariant(payload);

    const file: IssuedFile = {
      filename: `${license.id}_${activation.id}_r${revision}.hrdlic`,
      content: JSON.stringify(seal(signer, payload), null, 2) + '\n',
      kind,
      license_id: license.id,
      activation_id: activation.id,
      revision
    };
    this.record(file, payload);
    this.event(actor, 'FILE_ISSUED', { kind, revision, paid_until: payload.paid_until, lease_until: payload.lease_until },
      { license_id: license.id, activation_id: activation.id });
    return file;
  }

  /**
   * 6.3: the signed unlock for an OFFLINE client stuck in CLOCK_ROLLBACK. It
   * consumes a revision, so the client accepts each one once.
   */
  issueClockReset(activationId: string, highWaterTo: string | null, actor: string): IssuedFile {
    const signer = this.requireSigner();
    const activation = this.activation(activationId);
    const now = this.clock.now();
    const target = highWaterTo ? new Date(highWaterTo) : now;
    if (Number.isNaN(target.getTime())) throw new RuleError('VALIDATION', 'Неверная дата');
    const revision = Number(activation.current_revision) + 1;
    const status = {
      v: 1,
      kind: 'CLOCK_RESET',
      license_id: activation.license_id,
      activation_id: activation.id,
      revision,
      nonce: null,
      issued_at: iso(now),
      high_water_to: iso(target)
    };
    return inTransaction(this.db, () => {
      const file: IssuedFile = {
        filename: `${activation.license_id}_${activation.id}_r${revision}.hrdclock`,
        content: JSON.stringify(seal(signer, status), null, 2) + '\n',
        kind: 'CLOCK_RESET',
        license_id: activation.license_id,
        activation_id: activation.id,
        revision
      };
      this.record(file, status);
      this.event(actor, 'CLOCK_RESET_ISSUED', { revision, high_water_to: status.high_water_to },
        { license_id: activation.license_id, activation_id: activation.id, severity: 'warning' });
      return file;
    });
  }

  // --------------------------------------------------------------- requests

  private parse(signed: unknown, actor: string): RequestPayload {
    try {
      return verifyRequest(signed);
    } catch (error) {
      if (error instanceof RuleError && error.code === 'BAD_SIGNATURE') {
        this.event(actor, 'SIGNATURE_FAILED', {}, { severity: 'warning' });
      }
      throw error;
    }
  }

  /** What `signed` amounts to; changes nothing (except journalling a forgery). */
  inspectRequest(signed: unknown, options: Omit<ProcessOptions, 'actor'> & { actor?: string } = {}): Decision {
    return this.decide(this.parse(signed, options.actor ?? 'inspect'), options);
  }

  private decide(request: RequestPayload, options: Omit<ProcessOptions, 'actor'>): Decision {
    const decision: Decision = {
      request: {
        type: request.type,
        device_name: request.device_name,
        device_key: request.device_pubkey.slice(0, 12),
        app_version: request.app_version,
        client_time: request.client_time,
        license_key_hint: request.license_key ? `…${request.license_key.replace(/[\s-]/g, '').slice(-5)}` : null
      },
      action: null,
      license: null,
      activation: null,
      fp_match: null,
      seats: null,
      transfers: null,
      transfer_candidates: [],
      blocked: null,
      needs_approval: false
    };
    const block = (code: string, message: string) => {
      decision.blocked = { code, message };
      return decision;
    };

    // Which licence, and which activation, the request is about.
    let license: LicenseRow | undefined;
    let activation: ActivationRow | undefined;
    if (request.type === 'ACTIVATE') {
      const key = request.license_key ? normalizeLicenseKey(request.license_key) : null;
      if (!key) return block('INVALID_KEY', 'Ключ лицензии в запросе написан с ошибкой');
      license = this.db.prepare('SELECT * FROM licenses WHERE key_hash = ?').get(hashLicenseKey(key)) as LicenseRow | undefined;
      if (!license) return block('INVALID_KEY', 'Лицензии с таким ключом нет');
    } else {
      activation = this.db.prepare('SELECT * FROM activations WHERE id = ? AND license_id = ?')
        .get(request.activation_id ?? '', request.license_id ?? '') as ActivationRow | undefined;
      if (!activation) return block('NOT_FOUND', 'Активация из запроса не найдена');
      license = this.license(activation.license_id);
      decision.activation = activation;
    }

    const plan = this.plan(license.plan);
    const live = this.liveActivations(license.id);
    decision.license = { ...license, customer_name: this.customer(license.customer_id).name };
    decision.seats = { used: live.length, total: Number(license.seats) };
    decision.transfers = { last_year: this.transfersLastYear(license.id), limit: plan.max_transfers_per_year };
    const overLimit = decision.transfers.last_year >= decision.transfers.limit && !options.overrideTransferLimit;

    if (request.type === 'DEACTIVATE') {
      if (activation!.device_pubkey !== request.device_pubkey) {
        return block('PROOF_KEY_MISMATCH', 'Подтверждение подписано не тем устройством, которому выдана активация');
      }
      decision.action = 'DEACTIVATE';
      return decision;
    }

    if (license.status === 'REVOKED') return block('LICENSE_REVOKED', 'Лицензия отозвана');
    if (request.type === 'REFRESH') return block('ONLINE_ONLY', 'Обновление файла выполняется только онлайн');

    if (request.type === 'REBIND') {
      if (activation!.status === 'RELEASED' || activation!.status === 'REVOKED') {
        return block('ACTIVATION_RELEASED', 'Эта активация освобождена; нужна новая активация по ключу');
      }
      decision.fp_match = fingerprintMatches(JSON.parse(activation!.fp), request.fp);
      if (decision.fp_match >= FP_THRESHOLD) {
        // 7.1: the same computer after a reinstall. Not a transfer.
        decision.action = 'REBIND';
        return decision;
      }
      decision.action = 'TRANSFER';
      decision.needs_approval = !options.approveTransfer;
      if (overLimit) return block('TRANSFER_LIMIT', `Лимит переносов исчерпан: ${decision.transfers.last_year} из ${decision.transfers.limit} за год`);
      return decision;
    }

    // ACTIVATE
    const sameKey = live.find(a => a.device_pubkey === request.device_pubkey);
    if (sameKey) {
      decision.activation = sameKey;
      decision.action = 'REISSUE_SAME_DEVICE';
      return decision;
    }
    const sameMachine = live.find(a => fingerprintMatches(JSON.parse(a.fp), request.fp) >= FP_THRESHOLD);
    if (sameMachine) {
      // A wiped computer activating again by key is still the same seat.
      decision.activation = sameMachine;
      decision.fp_match = fingerprintMatches(JSON.parse(sameMachine.fp), request.fp);
      decision.action = 'REBIND';
      return decision;
    }
    if (live.length < Number(license.seats)) {
      decision.action = 'ACTIVATE_NEW';
      return decision;
    }

    decision.transfer_candidates = live;
    if (options.transferFrom) {
      const from = live.find(a => a.id === options.transferFrom);
      if (!from) return block('NOT_FOUND', 'Выбранная для переноса активация не найдена среди действующих');
      decision.activation = from;
      decision.action = 'TRANSFER';
      decision.needs_approval = !options.approveTransfer;
      if (overLimit) return block('TRANSFER_LIMIT', `Лимит переносов исчерпан: ${decision.transfers.last_year} из ${decision.transfers.limit} за год`);
      return decision;
    }
    return block('MACHINE_LIMIT_REACHED', `Все места заняты: ${live.length} из ${license.seats}`);
  }

  /** Applies what `decide` concluded. Throws if the decision is blocked or unapproved. */
  processRequest(signed: unknown, options: ProcessOptions): ProcessResult {
    const request = this.parse(signed, options.actor);
    // Journalled after the rollback, or the rollback would erase it.
    let refused: Decision | null = null;
    try {
      return this.apply(request, options, decision => { refused = decision; });
    } catch (error) {
      const decision = refused as Decision | null;
      if (decision?.blocked) {
        const code = decision.blocked.code;
        this.event(options.actor, 'REQUEST_REFUSED', { type: request.type, code },
          { license_id: decision.license?.id, activation_id: decision.activation?.id,
            severity: code === 'INVALID_KEY' || code === 'PROOF_KEY_MISMATCH' ? 'warning' : 'info' });
      }
      throw error;
    }
  }

  private apply(request: RequestPayload, options: ProcessOptions, onRefused: (decision: Decision) => void): ProcessResult {
    return inTransaction(this.db, () => {
      const decision = this.decide(request, options);
      if (decision.blocked) {
        onRefused(decision);
        const code = decision.blocked.code;
        throw new RuleError(code, decision.blocked.message, code === 'MACHINE_LIMIT_REACHED' ? 409 : 400);
      }
      if (decision.needs_approval) {
        throw new RuleError('APPROVAL_REQUIRED', 'Это перенос на другой компьютер: нужно явное одобрение', 409);
      }

      const now = iso(this.clock.now());
      const license = decision.license!;
      const touch = (id: string) => this.db.prepare(`UPDATE activations SET device_name = ?, device_pubkey = ?, fp = ?,
          last_seen = ?, last_counter = ?, status = 'ACTIVE' WHERE id = ?`)
        .run(request.device_name, request.device_pubkey, JSON.stringify(request.fp), now, request.counter, id);
      const create = () => {
        let id: string;
        do {
          id = `ACT-${crypto.randomBytes(4).toString('hex')}`;
        } while (this.db.prepare('SELECT 1 FROM activations WHERE id = ?').get(id));
        this.db.prepare(`INSERT INTO activations (id, license_id, device_name, fp, device_pubkey, first_seen,
          last_seen, last_counter) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, license.id, request.device_name, JSON.stringify(request.fp), request.device_pubkey, now, now, request.counter);
        return id;
      };

      let file: IssuedFile | null = null;
      switch (decision.action) {
        case 'ACTIVATE_NEW': {
          const id = create();
          file = this.issueLicenseFile(id, options.actor, 'ACTIVATE');
          break;
        }
        case 'REISSUE_SAME_DEVICE':
        case 'REBIND': {
          touch(decision.activation!.id);
          file = this.issueLicenseFile(decision.activation!.id, options.actor, decision.action === 'REBIND' ? 'REBIND' : 'REISSUE');
          this.event(options.actor, decision.action, { fp_match: decision.fp_match },
            { license_id: license.id, activation_id: decision.activation!.id });
          break;
        }
        case 'TRANSFER': {
          const from = decision.activation!;
          this.db.prepare("UPDATE activations SET status = 'RELEASED', last_seen = ? WHERE id = ?").run(now, from.id);
          const id = create();
          this.db.prepare('INSERT INTO transfers (license_id, from_activation_id, to_activation_id, at, method) VALUES (?, ?, ?, ?, ?)')
            .run(license.id, from.id, id, now, 'manual');
          this.event(options.actor, 'TRANSFER_APPROVED',
            { from: from.id, to: id, override_limit: Boolean(options.overrideTransferLimit) },
            { license_id: license.id, activation_id: id, severity: options.overrideTransferLimit ? 'warning' : 'info' });
          file = this.issueLicenseFile(id, options.actor, 'TRANSFER');
          break;
        }
        case 'DEACTIVATE': {
          this.releaseActivation(decision.activation!.id, options.actor, 'proof');
          break;
        }
      }
      return { decision, file };
    });
  }

  // ------------------------------------------------------------ online (5.2)

  /**
   * POST /v1/activate: activation by key over the network. The same decision
   * as for an offline file; a transfer is never approved here - that stays a
   * decision for the seller (7.2).
   */
  activateOnline(signed: unknown): { license: object } {
    const request = this.parse(signed, 'client');
    if (request.type !== 'ACTIVATE') throw new RuleError('WRONG_TYPE', 'Ожидался запрос ACTIVATE');
    const { file } = this.processRequest(signed, { actor: 'client' });
    return { license: JSON.parse(file!.content) };
  }

  /**
   * POST /v1/refresh (5.2): a new file with a fresh lease, or a signed status
   * echoing the request's nonce - REVOKED for a revoked licence, TRANSFERRED
   * for a seat that was freed. The client acts only on signed answers, so
   * every refusal here is informational.
   */
  refreshOnline(signed: unknown): { license: object } | { status: object } {
    const request = this.parse(signed, 'client');
    if (request.type !== 'REFRESH') throw new RuleError('WRONG_TYPE', 'Ожидался запрос REFRESH');
    const activation = this.db.prepare('SELECT * FROM activations WHERE id = ? AND license_id = ?')
      .get(request.activation_id ?? '', request.license_id ?? '') as ActivationRow | undefined;
    if (!activation) throw new RuleError('NOT_FOUND', 'Активация не найдена на сервере', 404);
    if (activation.device_pubkey !== request.device_pubkey) {
      this.event('client', 'REFRESH_KEY_MISMATCH', {}, { license_id: activation.license_id, activation_id: activation.id, severity: 'warning' });
      throw new RuleError('KEY_MISMATCH', 'Ключ устройства не совпадает: нужна повторная привязка', 403);
    }
    const license = this.license(activation.license_id);

    return inTransaction(this.db, () => {
      this.checkCounter(activation, request);
      this.db.prepare('UPDATE activations SET last_seen = ?, last_counter = max(last_counter, ?) WHERE id = ?')
        .run(iso(this.clock.now()), request.counter, activation.id);
      if (license.status === 'REVOKED' || activation.status === 'REVOKED') {
        return { status: this.signedStatus(activation, 'REVOKED', request.nonce) };
      }
      if (activation.status === 'RELEASED') {
        return { status: this.signedStatus(activation, 'TRANSFERRED', request.nonce) };
      }
      return { license: JSON.parse(this.issueLicenseFile(activation.id, 'client', 'REFRESH').content) };
    });
  }

  /**
   * 5.1: the device counts its requests. The same activation asking with a
   * counter that is not higher than last time means a second copy of the
   * system - a cloned virtual machine, a restored disk image - running in
   * parallel. Nothing is refused: the activation is marked FORK_SUSPECTED
   * for the seller to look at (10.2), since a restored backup is innocent.
   */
  private checkCounter(activation: ActivationRow, request: RequestPayload) {
    if (Number(request.counter) > Number(activation.last_counter)) return;
    if (activation.status === 'ACTIVE') {
      this.db.prepare("UPDATE activations SET status = 'FORK_SUSPECTED' WHERE id = ?").run(activation.id);
    }
    this.event('client', 'FORK_SUSPECTED',
      { counter: request.counter, last_counter: activation.last_counter, type: request.type },
      { license_id: activation.license_id, activation_id: activation.id, severity: 'warning' });
  }

  /**
   * POST /v1/rebind (7.1): the same computer after a reinstall - two of three
   * fingerprint components still match, the device key is new. Automatic,
   * and not a transfer. Another computer is a transfer, which only the
   * seller approves.
   *
   * A seat that keeps being rebound is also how two machines fighting over
   * one activation look, so frequent rebinds are flagged like a fork.
   */
  rebindOnline(signed: unknown): { license: object } {
    const request = this.parse(signed, 'client');
    if (request.type !== 'REBIND') throw new RuleError('WRONG_TYPE', 'Ожидался запрос REBIND');
    const decision = this.inspectRequest(signed, { actor: 'client' });
    if (decision.action === 'TRANSFER') {
      throw new RuleError('APPROVAL_REQUIRED', 'Это другой компьютер: перенос одобряет продавец', 409);
    }
    const { file } = this.processRequest(signed, { actor: 'client' });
    const recent = Number((this.db.prepare(`SELECT count(*) AS n FROM events WHERE action = 'REBIND'
      AND activation_id = ? AND at >= ?`).get(file!.activation_id,
      iso(new Date(this.clock.now().getTime() - 30 * 86_400_000))) as { n: number }).n);
    if (recent > REBINDS_PER_MONTH) {
      this.db.prepare("UPDATE activations SET status = 'FORK_SUSPECTED' WHERE id = ? AND status = 'ACTIVE'")
        .run(file!.activation_id);
      this.event('client', 'FORK_SUSPECTED', { rebinds_30d: recent },
        { license_id: file!.license_id, activation_id: file!.activation_id, severity: 'warning' });
    }
    return { license: JSON.parse(file!.content) };
  }

  /**
   * POST /v1/deactivate (7.2, online): frees the seat on the device's own
   * signed request, and answers with a signed TRANSFERRED echoing the nonce -
   * the client removes its licence only on that answer.
   */
  deactivateOnline(signed: unknown): { status: object } {
    const request = this.parse(signed, 'client');
    if (request.type !== 'DEACTIVATE') throw new RuleError('WRONG_TYPE', 'Ожидался запрос DEACTIVATE');
    // Two steps on purpose: a refusal must stay in the journal, and a retry
    // after a lost answer finds the seat already free and just answers again.
    const { decision } = this.processRequest(signed, { actor: 'client' });
    const activation = this.activation(decision.activation!.id);
    return inTransaction(this.db, () => ({ status: this.signedStatus(activation, 'TRANSFERRED', request.nonce) }));
  }

  /** The seller looked at a FORK_SUSPECTED activation and found it innocent. */
  clearForkSuspicion(activationId: string, actor: string): ActivationRow {
    const activation = this.activation(activationId);
    if (activation.status !== 'FORK_SUSPECTED') return activation;
    this.db.prepare("UPDATE activations SET status = 'ACTIVE' WHERE id = ?").run(activationId);
    this.event(actor, 'FORK_CLEARED', {}, { license_id: activation.license_id, activation_id: activationId });
    return this.activation(activationId);
  }

  /** A signed REVOKED / TRANSFERRED (3.4), consuming the next revision. */
  private signedStatus(activation: ActivationRow, kind: 'REVOKED' | 'TRANSFERRED', nonce: string): object {
    const signer = this.requireSigner();
    const revision = Number(activation.current_revision) + 1;
    const status = {
      v: 1,
      kind,
      license_id: activation.license_id,
      activation_id: activation.id,
      revision,
      nonce,
      issued_at: iso(this.clock.now()),
      high_water_to: null
    };
    const envelope = seal(signer, status);
    this.record({
      filename: '', content: JSON.stringify(envelope), kind, license_id: activation.license_id,
      activation_id: activation.id, revision
    }, status);
    this.event('client', `STATUS_${kind}`, { revision }, { license_id: activation.license_id, activation_id: activation.id });
    return envelope;
  }

  /** Recent payments of every licence, newest first (the "Платежи" tab). */
  listPayments(limit = 200) {
    return this.db.prepare(`SELECT p.*, l.customer_id, c.name AS customer_name, l.activation_mode, l.plan
      FROM payments p JOIN licenses l ON l.id = p.license_id JOIN customers c ON c.id = l.customer_id
      ORDER BY p.id DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 1000));
  }

  // ----------------------------------------------------------------- events

  listEvents(filter: { severity?: string; license_id?: string; limit?: number } = {}) {
    const clauses: string[] = [];
    const args: string[] = [];
    if (filter.severity) { clauses.push('severity = ?'); args.push(filter.severity); }
    if (filter.license_id) { clauses.push('license_id = ?'); args.push(filter.license_id); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(filter.limit ?? 200), 1), 1000);
    return this.db.prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ${limit}`).all(...args);
  }

  /** 10.2: FORK_SUSPECTED, frequent transfers, frequent signature failures. */
  suspicious() {
    const since = iso(new Date(this.clock.now().getTime() - 90 * 86_400_000));
    return {
      fork_suspected: this.db.prepare("SELECT * FROM activations WHERE status = 'FORK_SUSPECTED'").all(),
      heavy_transfers: this.db.prepare(`SELECT l.id AS license_id, c.name AS customer_name, count(t.id) AS transfers,
          p.max_transfers_per_year AS limit_per_year
        FROM transfers t JOIN licenses l ON l.id = t.license_id JOIN customers c ON c.id = l.customer_id
        JOIN plans p ON p.code = l.plan
        WHERE t.at >= ? GROUP BY l.id HAVING count(t.id) >= p.max_transfers_per_year`)
        .all(iso(new Date(this.clock.now().getTime() - 365 * 86_400_000))),
      warnings: this.db.prepare("SELECT * FROM events WHERE severity = 'warning' AND at >= ? ORDER BY id DESC LIMIT 200").all(since),
      signature_failures_90d: Number((this.db.prepare(
        "SELECT count(*) AS n FROM events WHERE action = 'SIGNATURE_FAILED' AND at >= ?").get(since) as { n: number }).n)
    };
  }
}
