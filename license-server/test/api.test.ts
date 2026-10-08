/**
 * The HTTP surface: sign-in, the guards around the admin API, and the
 * License Manager paths of tests 17 and 20.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { addAdmin, currentStep, totpAt } from '../src/auth.ts';
import { openEnvelope } from '../src/core/envelope.ts';
import { Device, setup } from './helpers.ts';

async function start() {
  const env = setup();
  const app = createApp(env.service, { secureCookie: false });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { secret } = addAdmin(env.service.db, 'owner', 'correct horse battery');
  return { ...env, server, base, secret };
}

type Started = Awaited<ReturnType<typeof start>>;

async function signIn(ctx: Started, step: number) {
  const res = await fetch(`${ctx.base}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'correct horse battery', code: totpAt(ctx.secret, step) })
  });
  return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

function client(ctx: Started, cookie: string) {
  return async (method: string, url: string, body?: unknown, extra: Record<string, string> = { 'X-KDR-LM': '1' }) => {
    const res = await fetch(`${ctx.base}${url}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() as any };
  };
}

describe('License Manager API', () => {
  let ctx: Started;
  let api: ReturnType<typeof client>;

  before(async () => {
    ctx = await start();
    const { res, cookie } = await signIn(ctx, currentStep(new Date()));
    assert.equal(res.status, 200);
    api = client(ctx, cookie);
  });
  after(() => ctx.server.close());

  test('nothing without a session', async () => {
    const res = await fetch(`${ctx.base}/admin/api/licenses`);
    assert.equal(res.status, 401);
    const offline = await fetch(`${ctx.base}/v1/offline/process`, { method: 'POST' });
    assert.equal(offline.status, 401);
  });

  test('a second-factor code works once', async () => {
    const { res } = await signIn(ctx, currentStep(new Date()));
    assert.equal(res.status, 401);
  });

  test('a wrong password or code is refused', async () => {
    const res = await fetch(`${ctx.base}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'wrong', code: '000000' })
    });
    assert.equal(res.status, 401);
  });

  test('writes need the anti-CSRF header', async () => {
    const res = await api('POST', '/admin/api/customers', { name: 'X' }, {});
    assert.equal(res.status, 403);
  });

  test('security headers are set', async () => {
    const res = await fetch(`${ctx.base}/admin/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  test('test 20: MONTHLY + OFFLINE cannot be created in the License Manager', async () => {
    const customer = (await api('POST', '/admin/api/customers', { name: 'Тест' })).body;
    const res = await api('POST', '/admin/api/licenses', { customer_id: customer.id, plan: 'MONTHLY', activation_mode: 'OFFLINE' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'MODE_NOT_ALLOWED');
  });

  test('offline flow and test 17 through the API', async () => {
    const customer = (await api('POST', '/admin/api/customers', { name: 'ABC Ltd.' })).body;
    const created = await api('POST', '/admin/api/licenses',
      { customer_id: customer.id, plan: 'ANNUAL', activation_mode: 'OFFLINE', seats: 3 });
    assert.equal(created.status, 200);
    const key = created.body.license_key;
    assert.match(key, /^KDR-/);

    const details = await api('GET', `/admin/api/licenses/${created.body.license.id}`);
    assert.equal(JSON.stringify(details.body).includes(key), false, 'the key is shown once, never stored');

    const request = new Device().request('ACTIVATE', { license_key: key });
    const preview = await api('POST', '/v1/offline/inspect', { request });
    assert.equal(preview.body.action, 'ACTIVATE_NEW');

    const processed = await api('POST', '/v1/offline/process', { request });
    assert.equal(processed.status, 200);
    const opened = openEnvelope(JSON.parse(processed.body.file.content), ctx.keys);
    assert.equal(opened.verified, true);

    for (let i = 0; i < 2; i++) {
      assert.equal((await api('POST', '/v1/offline/process', { request: new Device().request('ACTIVATE', { license_key: key }) })).status, 200);
    }
    const fourth = await api('POST', '/v1/offline/process', { request: new Device().request('ACTIVATE', { license_key: key }) });
    assert.equal(fourth.status, 409);
    assert.equal(fourth.body.error, 'MACHINE_LIMIT_REACHED');
  });

  test('a malformed request file is a clear 400', async () => {
    const res = await api('POST', '/v1/offline/inspect', { request: { payload: 'x', device_sig: 'y' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'BAD_REQUEST_FILE');
  });
});

describe('login rate limit', () => {
  test('the eleventh attempt in 15 minutes is refused', async () => {
    const ctx = await start();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await fetch(`${ctx.base}/admin/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'owner', password: 'wrong', code: '000000' })
        });
        statuses.push(res.status);
      }
      assert.equal(statuses.at(-1), 429);
      assert.ok(statuses.slice(0, 10).every(s => s === 401));
    } finally {
      ctx.server.close();
    }
  });
});
