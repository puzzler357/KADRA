/**
 * Administrator accounts: the one a fresh installation starts with (`admin` /
 * `1234`) and what it may do before its password is replaced; the second
 * factor, which is each account's own choice; and changing a password.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import {
  addAdmin, BOOTSTRAP_PASSWORD, BOOTSTRAP_USERNAME, changePassword, currentStep, ensureBootstrapAdmin, totpAt
} from '../src/auth.ts';
import { setup } from './helpers.ts';

/** A running server; `prepare` puts into its database whoever the test needs. */
async function start(prepare: (env: ReturnType<typeof setup>) => void) {
  const env = setup();
  prepare(env);
  const server = createApp(env.service, { secureCookie: false }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  return { ...env, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

type Started = Awaited<ReturnType<typeof start>>;

/** A server whose database has nobody in it yet, as after `npm install`. */
const startFresh = () => start(env => { ensureBootstrapAdmin(env.service.db); });

function signIn(ctx: Started, username: string, password: string, code = '') {
  return fetch(`${ctx.base}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, code })
  });
}

const sessionCookie = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? '';

/** Requests of a signed-in panel; `cookie` in the answer is a new session, when one was handed out. */
function client(ctx: Started, cookie: string) {
  return async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${ctx.base}${url}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', 'X-KDR-LM': '1' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() as any, cookie: sessionCookie(res) };
  };
}

const adminNames = (ctx: ReturnType<typeof setup>) =>
  (ctx.service.db.prepare('SELECT username FROM admins ORDER BY username').all() as { username: string }[])
    .map(row => row.username);

describe('the account a fresh installation starts with', () => {
  test('appears only while there is nobody at all', () => {
    const env = setup();
    assert.equal(ensureBootstrapAdmin(env.service.db), true);
    const row = env.service.db.prepare('SELECT username, totp_secret, must_change_password FROM admins').get() as
      { username: string; totp_secret: string; must_change_password: number };
    assert.equal(row.username, BOOTSTRAP_USERNAME);
    assert.equal(row.totp_secret, '');
    assert.equal(Number(row.must_change_password), 1);
    // A second call changes nothing: an installation that already has an
    // administrator must not be handed a default password.
    assert.equal(ensureBootstrapAdmin(env.service.db), false);

    const other = setup();
    addAdmin(other.service.db, 'owner', 'correct horse battery');
    assert.equal(ensureBootstrapAdmin(other.service.db), false);
  });

  test('a real administrator retires it', () => {
    const env = setup();
    ensureBootstrapAdmin(env.service.db);
    addAdmin(env.service.db, 'owner', 'correct horse battery');
    assert.deepEqual(adminNames(env), ['owner']);
  });

  test('but not once its own password has been changed', () => {
    const env = setup();
    ensureBootstrapAdmin(env.service.db);
    changePassword(env.service.db, BOOTSTRAP_USERNAME, 'a password of its own');
    addAdmin(env.service.db, 'owner', 'correct horse battery');
    assert.deepEqual(adminNames(env), [BOOTSTRAP_USERNAME, 'owner']);
  });
});

describe('before the default password is replaced', () => {
  let ctx: Started;
  let api: ReturnType<typeof client>;

  before(async () => {
    ctx = await startFresh();
    const res = await signIn(ctx, BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).must_change_password, true);
    api = client(ctx, sessionCookie(res));
  });
  after(() => ctx.server.close());

  test('a wrong password is still refused', async () => {
    assert.equal((await signIn(ctx, BOOTSTRAP_USERNAME, 'не тот пароль')).status, 401);
  });

  test('the session may ask who it is', async () => {
    const me = await api('GET', '/admin/api/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { username: BOOTSTRAP_USERNAME, must_change_password: true, totp_enabled: false });
  });

  test('and nothing else: no licences, no customers, no offline files, no second factor', async () => {
    for (const [method, url, body] of [
      ['GET', '/admin/api/licenses', undefined],
      ['GET', '/admin/api/customers', undefined],
      ['GET', '/admin/api/plans', undefined],
      ['POST', '/admin/api/customers', { name: 'ABC Ltd.' }],
      ['POST', '/admin/api/totp/new', undefined],
      ['POST', '/v1/offline/inspect', { request: '{}' }]
    ] as const) {
      const res = await api(method, url, body);
      assert.equal(res.status, 403, `${method} ${url}`);
      assert.equal(res.body.error, 'PASSWORD_CHANGE_REQUIRED', `${method} ${url}`);
    }
  });

  test('a short password is refused', async () => {
    const res = await api('POST', '/admin/api/password', { password: '1234' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'PASSWORD_TOO_SHORT');
  });
});

describe('replacing the default password', () => {
  let ctx: Started;

  before(async () => { ctx = await startFresh(); });
  after(() => ctx.server.close());

  test('opens the panel at once, and the default password stops working', async () => {
    const first = await signIn(ctx, BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
    const locked = client(ctx, sessionCookie(first));

    // No current password is asked for: the one it has is public.
    const changed = await locked('POST', '/admin/api/password', { password: 'correct horse battery' });
    assert.equal(changed.status, 200);

    // Every session of the account ended, and the answer carried a new one.
    assert.equal((await locked('GET', '/admin/api/me')).status, 401);
    const open = client(ctx, changed.cookie);
    assert.deepEqual((await open('GET', '/admin/api/me')).body,
      { username: BOOTSTRAP_USERNAME, must_change_password: false, totp_enabled: false });
    assert.equal((await open('GET', '/admin/api/licenses')).status, 200);
    assert.equal((await open('POST', '/admin/api/customers', { name: 'ABC Ltd.' })).status, 200);

    assert.equal((await signIn(ctx, BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD)).status, 401);
    // No authenticator app was involved, and none is needed to come back.
    const again = await signIn(ctx, BOOTSTRAP_USERNAME, 'correct horse battery');
    assert.equal(again.status, 200);
    assert.equal((await again.json()).must_change_password, false);
  });
});

describe('the second factor is the account\'s own choice', () => {
  const PASSWORD = 'correct horse battery';
  let ctx: Started;
  let api: ReturnType<typeof client>;
  let secret: string;
  /** The step whose code turned the second factor on: that code is spent. */
  let spent: number;

  before(async () => {
    ctx = await start(env => { addAdmin(env.service.db, 'owner', PASSWORD); });
  });
  after(() => ctx.server.close());

  test('off until switched on: the password alone signs in', async () => {
    const res = await signIn(ctx, 'owner', PASSWORD);
    assert.equal(res.status, 200);
    api = client(ctx, sessionCookie(res));
    assert.equal((await api('GET', '/admin/api/me')).body.totp_enabled, false);
  });

  test('a secret is nothing until a code made from it comes back', async () => {
    const fresh = await api('POST', '/admin/api/totp/new');
    assert.equal(fresh.status, 200);
    assert.match(fresh.body.secret, /^[A-Z2-7]{32}$/);
    assert.match(fresh.body.uri, /^otpauth:\/\/totp\//);
    secret = fresh.body.secret;
    assert.equal((await api('GET', '/admin/api/me')).body.totp_enabled, false);

    // A code from some other secret: the app on the phone has the wrong one.
    const other = (await api('POST', '/admin/api/totp/new')).body.secret;
    const wrong = await api('POST', '/admin/api/totp/enable', { secret, code: totpAt(other, currentStep(new Date())) });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'WRONG_CODE');
    assert.equal((await api('POST', '/admin/api/totp/enable', { secret: 'not a secret', code: '123456' })).body.error, 'BAD_SECRET');
    assert.equal((await api('GET', '/admin/api/me')).body.totp_enabled, false);
    assert.equal((await signIn(ctx, 'owner', PASSWORD)).status, 200);
  });

  test('the right code switches it on and keeps the panel open', async () => {
    spent = currentStep(new Date());
    const enabled = await api('POST', '/admin/api/totp/enable', { secret, code: totpAt(secret, spent) });
    assert.equal(enabled.status, 200);
    assert.equal((await api('GET', '/admin/api/me')).status, 401, 'the old session ended');
    api = client(ctx, enabled.cookie);
    assert.equal((await api('GET', '/admin/api/me')).body.totp_enabled, true);
    // Another secret would silently replace the one in the phone.
    assert.equal((await api('POST', '/admin/api/totp/new')).status, 409);
  });

  test('then the password alone opens nothing, and a spent code is spent', async () => {
    assert.equal((await signIn(ctx, 'owner', PASSWORD)).status, 401);
    assert.equal((await signIn(ctx, 'owner', PASSWORD, totpAt(secret, spent))).status, 401);
    assert.equal((await signIn(ctx, 'owner', PASSWORD, totpAt(secret, spent + 1))).status, 200);
  });

  test('switching it off asks for the password and is journalled as a warning', async () => {
    const refused = await api('POST', '/admin/api/totp/disable', { password: 'не тот пароль' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'WRONG_PASSWORD');
    assert.equal((await api('GET', '/admin/api/me')).body.totp_enabled, true);

    const disabled = await api('POST', '/admin/api/totp/disable', { password: PASSWORD });
    assert.equal(disabled.status, 200);
    api = client(ctx, disabled.cookie);
    assert.equal((await api('GET', '/admin/api/me')).body.totp_enabled, false);
    assert.equal((await signIn(ctx, 'owner', PASSWORD)).status, 200);

    const warnings = (await api('GET', '/admin/api/events?severity=warning')).body as { action: string }[];
    assert.ok(warnings.some(event => event.action === 'ADMIN_TOTP_DISABLED'));
  });

  test('changing a password asks for the current one', async () => {
    const NEW = 'a different long password';
    assert.equal((await api('POST', '/admin/api/password', { password: NEW })).body.error, 'WRONG_PASSWORD');
    assert.equal((await api('POST', '/admin/api/password', { password: NEW, current: 'не тот пароль' })).status, 403);

    const changed = await api('POST', '/admin/api/password', { password: NEW, current: PASSWORD });
    assert.equal(changed.status, 200);
    assert.equal((await client(ctx, changed.cookie)('GET', '/admin/api/me')).status, 200);
    assert.equal((await signIn(ctx, 'owner', PASSWORD)).status, 401);
    assert.equal((await signIn(ctx, 'owner', NEW)).status, 200);
  });
});
