/**
 * Stage 6: payment webhooks. Test 16 on the payment path (the renewal rule
 * 5.4), plus the guards around it: signature, freshness, one payment - one
 * renewal.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { createWebhookSource, setWebhookSourceStatus, signPayload } from '../src/payments.ts';
import { customerWithLicense, setup } from './helpers.ts';

describe('payment webhooks', () => {
  let env: ReturnType<typeof setup>;
  let base: string;
  let secret: string;
  let close: () => void;

  before(async () => {
    env = setup('2026-06-30T10:00:00Z');
    const server = createApp(env.service, { secureCookie: false }).listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    secret = createWebhookSource(env.service, 'bank', 'test').secret;
  });
  after(() => close());

  const send = async (body: unknown, options: { source?: string; key?: string; at?: number; tamper?: boolean } = {}) => {
    const raw = JSON.stringify(body);
    const at = options.at ?? Math.floor(Date.now() / 1000);
    const signature = signPayload(options.key ?? secret, raw, at);
    const res = await fetch(`${base}/v1/payments/${options.source ?? 'bank'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-KDR-Signature': signature },
      body: options.tamper ? raw.replace('"periods":1', '"periods":9') : raw
    });
    return { status: res.status, body: await res.json() as any };
  };

  test('test 16 on the payment path: before grace from paid_until, after it from the payment date', async () => {
    const { license } = customerWithLicense(env.service, 'MONTHLY', 'ONLINE');
    assert.equal(license.paid_until, '2026-07-30T23:59:59Z');

    const early = await send({ payment_id: 'p-1', license_id: license.id, periods: 1, amount: 100, currency: 'TMT', paid_at: '2026-08-02T08:00:00Z' });
    assert.equal(early.status, 200);
    assert.equal(early.body.paid_until, '2026-08-30T23:59:59Z', 'within grace: no days lost');

    const late = await send({ payment_id: 'p-2', license_id: license.id, periods: 1, paid_at: '2026-09-20T08:00:00Z' });
    assert.equal(late.body.paid_until, '2026-10-20T23:59:59Z', 'after grace: from the payment date');

    const payments = env.service.licenseDetails(license.id).payments as any[];
    assert.deepEqual(payments.map(p => p.source), ['webhook:bank', 'webhook:bank']);
    assert.equal(payments.find(p => p.external_id === 'p-1').amount, 100);
  });

  test('the same payment reported twice renews once', async () => {
    const { license } = customerWithLicense(env.service, 'MONTHLY', 'ONLINE');
    const body = { payment_id: 'retry-1', license_id: license.id, periods: 1, paid_at: '2026-07-01T00:00:00Z' };
    const first = await send(body);
    const again = await send(body);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.paid_until, first.body.paid_until);
    assert.equal((env.service.licenseDetails(license.id).payments as any[]).length, 1);
  });

  test('a licence can be named by its key', async () => {
    const { license, key } = customerWithLicense(env.service, 'MONTHLY', 'ONLINE');
    const res = await send({ payment_id: 'by-key', license_key: key.toLowerCase(), paid_at: '2026-07-01T00:00:00Z' });
    assert.equal(res.status, 200);
    assert.equal(res.body.license_id, license.id);
  });

  test('a wrong secret, a changed body, an old signature and an unknown source are all 401', async () => {
    const { license } = customerWithLicense(env.service, 'MONTHLY', 'ONLINE');
    const body = { payment_id: 'forged', license_id: license.id, periods: 1 };
    assert.equal((await send(body, { key: 'not-the-secret' })).status, 401);
    assert.equal((await send(body, { tamper: true })).status, 401);
    assert.equal((await send(body, { at: Math.floor(Date.now() / 1000) - 600 })).status, 401);
    assert.equal((await send(body, { source: 'nobody' })).status, 401);
    assert.equal((env.service.licenseDetails(license.id).payments as any[]).length, 0);
    assert.ok(env.service.listEvents({ severity: 'warning' }).some((e: any) => e.action === 'WEBHOOK_REJECTED'));
  });

  test('a disabled source is refused', async () => {
    const { secret: shopSecret } = createWebhookSource(env.service, 'shop', 'test');
    setWebhookSourceStatus(env.service, 'shop', 'DISABLED', 'test');
    const { license } = customerWithLicense(env.service, 'MONTHLY', 'ONLINE');
    const res = await send({ payment_id: 'x', license_id: license.id }, { source: 'shop', key: shopSecret });
    assert.equal(res.status, 401);
  });

  test('an OFFLINE licence is extended, and the seller is told to send files', async () => {
    const { license } = customerWithLicense(env.service, 'ANNUAL', 'OFFLINE');
    const res = await send({ payment_id: 'offline-1', license_id: license.id, paid_at: '2026-07-01T00:00:00Z' });
    assert.equal(res.status, 200);
    assert.equal(res.body.files_needed, true);
    const note = env.service.listEvents({ license_id: license.id }).find((e: any) => e.action === 'PAYMENT_RECEIVED') as any;
    assert.equal(note.severity, 'warning');
  });

  test('money for a licence that cannot take it is journalled, not lost', async () => {
    const { license } = customerWithLicense(env.service, 'MONTHLY', 'ONLINE');
    env.service.revokeLicense(license.id, 'test', 'test');
    const res = await send({ payment_id: 'to-revoked', license_id: license.id, amount: 50, currency: 'TMT' });
    assert.equal(res.status, 409);
    const note = env.service.listEvents({ license_id: license.id }).find((e: any) => e.action === 'PAYMENT_NOT_APPLIED') as any;
    assert.ok(note);
    assert.match(note.details, /to-revoked/);
  });

  test('bad fields are clear 400s', async () => {
    const { license } = customerWithLicense(env.service, 'MONTHLY', 'ONLINE');
    assert.equal((await send({ license_id: license.id })).body.error, 'VALIDATION');
    assert.equal((await send({ payment_id: 'f', license_id: license.id, paid_at: '2099-01-01T00:00:00Z' })).body.error, 'VALIDATION');
    assert.equal((await send({ payment_id: 'g', license_id: license.id, periods: 0 })).body.error, 'VALIDATION');
    assert.equal((await send({ payment_id: 'h', license_id: 'KDR-2026-999999' })).status, 404);
  });
});
