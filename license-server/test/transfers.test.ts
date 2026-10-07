/**
 * Stage 5 on the server: online rebind and deactivation, and clone
 * detection by the request counter. Test numbers are LICENSING.md 13.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openEnvelope } from '../src/core/envelope.ts';
import { Device, customerWithLicense, setup } from './helpers.ts';

describe('transfers and forks', () => {
  let env: ReturnType<typeof setup>;
  let base: string;
  let close: () => void;

  before(async () => {
    env = setup('2026-09-27T16:00:00Z');
    const server = createApp(env.service, { secureCookie: false }).listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  after(() => close());

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() as any };
  };

  const activated = async () => {
    const { key, license } = customerWithLicense(env.service, 'ANNUAL', 'ONLINE', 1);
    const device = new Device();
    const res = await post('/v1/activate', device.request('ACTIVATE', { license_key: key }));
    const payload = openEnvelope(res.body.license, env.keys).payload as any;
    return { device, license, ids: { license_id: license.id, activation_id: payload.activation.activation_id } };
  };

  test('test 5, online: a reinstall rebinds itself and is not a transfer', async () => {
    const { device, ids, license } = await activated();
    device.reinstall();
    device.counter = 0; // a new vault starts counting again
    const res = await post('/v1/rebind', device.request('REBIND', ids));
    assert.equal(res.status, 200);
    const opened = openEnvelope(res.body.license, env.keys);
    assert.equal(opened.verified, true);
    assert.equal((opened.payload as any).activation.activation_id, ids.activation_id);
    assert.equal(opened.payload.revision, 2);
    assert.equal(env.service.licenseDetails(license.id).transfers_last_year, 0);
    assert.equal(env.service.activation(ids.activation_id).status, 'ACTIVE');

    // The rebound device refreshes with its new key and new counter.
    const refreshed = await post('/v1/refresh', device.request('REFRESH', ids));
    assert.equal(refreshed.status, 200);
    assert.equal(env.service.activation(ids.activation_id).status, 'ACTIVE', 'the counter restart is not a fork');
  });

  test('a rebind from another computer is left to the seller', async () => {
    const { ids } = await activated();
    const res = await post('/v1/rebind', new Device().request('REBIND', ids));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'APPROVAL_REQUIRED');
  });

  test('test 18: two refreshes with the same counter are FORK_SUSPECTED', async () => {
    const { device, ids } = await activated();
    const first = device.request('REFRESH', ids);
    assert.equal((await post('/v1/refresh', first)).status, 200);

    // A clone of the same machine sends the same counter again.
    device.counter -= 1;
    const clone = await post('/v1/refresh', device.request('REFRESH', ids));
    assert.equal(clone.status, 200, 'flagged for review, not refused');
    assert.equal(env.service.activation(ids.activation_id).status, 'FORK_SUSPECTED');
    assert.ok(env.service.suspicious().fork_suspected.length >= 1);

    env.service.clearForkSuspicion(ids.activation_id, 'admin:t');
    assert.equal(env.service.activation(ids.activation_id).status, 'ACTIVE');
  });

  test('a seat rebound again and again is flagged', async () => {
    const { device, ids } = await activated();
    for (let i = 0; i < 4; i++) {
      device.reinstall();
      device.counter = 0;
      assert.equal((await post('/v1/rebind', device.request('REBIND', ids))).status, 200);
      device.fp = { ...device.fp, mg: device.fp.mg.replace(/(-new)+$/, '') };
    }
    assert.equal(env.service.activation(ids.activation_id).status, 'FORK_SUSPECTED');
  });

  test('online deactivation frees the seat and answers a signed TRANSFERRED with the nonce', async () => {
    const { device, ids, license } = await activated();
    assert.equal((await post('/v1/deactivate', new Device().request('DEACTIVATE', ids))).body.error, 'PROOF_KEY_MISMATCH');

    const request = device.request('DEACTIVATE', ids);
    const nonce = JSON.parse(Buffer.from(request.payload, 'base64url').toString()).nonce;
    const res = await post('/v1/deactivate', request);
    assert.equal(res.status, 200);
    const opened = openEnvelope(res.body.status, env.keys);
    assert.equal(opened.verified, true);
    assert.equal(opened.payload.kind, 'TRANSFERRED');
    assert.equal(opened.payload.nonce, nonce);
    assert.equal(env.service.activation(ids.activation_id).status, 'RELEASED');

    const details = env.service.licenseDetails(license.id);
    assert.equal((details.transfers as any[])[0].method, 'proof');

    // A lost answer: asking again answers again.
    assert.equal((await post('/v1/deactivate', device.request('DEACTIVATE', ids))).status, 200);
  });
});
