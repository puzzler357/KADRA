/**
 * The online endpoints the KADRA client calls (5.2): /v1/activate and
 * /v1/refresh, authenticated by the device signature alone.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openEnvelope } from '../src/core/envelope.ts';
import { Device, customerWithLicense, setup } from './helpers.ts';

describe('online endpoints', () => {
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
  const open = (envelope: unknown) => openEnvelope(envelope as any, env.keys);

  const activated = async (plan = 'MONTHLY') => {
    const { key, license } = customerWithLicense(env.service, plan, 'ONLINE');
    const device = new Device();
    const res = await post('/v1/activate', device.request('ACTIVATE', { license_key: key }));
    assert.equal(res.status, 200);
    const payload = open(res.body.license);
    assert.equal(payload.verified, true);
    const ids = { license_id: license.id, activation_id: (payload.payload.activation as any).activation_id };
    return { device, ids, license, payload: payload.payload };
  };

  test('activation over the network returns a signed ONLINE file', async () => {
    const { payload } = await activated();
    assert.equal(payload.activation_mode, 'ONLINE');
    assert.equal(payload.lease_until, '2026-10-27T16:00:00Z');
    assert.equal(payload.refresh_after, '2026-10-04T16:00:00Z');
  });

  test('refresh issues the next revision', async () => {
    const { device, ids } = await activated();
    const res = await post('/v1/refresh', device.request('REFRESH', ids));
    assert.equal(res.status, 200);
    const opened = open(res.body.license);
    assert.equal(opened.verified, true);
    assert.equal(opened.payload.revision, 2);
  });

  test('a revoked licence answers a signed REVOKED echoing the nonce', async () => {
    const { device, ids, license } = await activated();
    env.service.revokeLicense(license.id, 'test', 'admin:t');
    const request = device.request('REFRESH', ids);
    const nonce = JSON.parse(Buffer.from(request.payload, 'base64url').toString()).nonce;
    const res = await post('/v1/refresh', request);
    assert.equal(res.status, 200);
    const opened = open(res.body.status);
    assert.equal(opened.verified, true);
    assert.equal(opened.payload.kind, 'REVOKED');
    assert.equal(opened.payload.nonce, nonce);
  });

  test('a released seat answers TRANSFERRED', async () => {
    const { device, ids } = await activated();
    env.service.releaseActivation(ids.activation_id, 'admin:t');
    const res = await post('/v1/refresh', device.request('REFRESH', ids));
    assert.equal(open(res.body.status).payload.kind, 'TRANSFERRED');
  });

  test('another device key cannot refresh someone else\'s activation', async () => {
    const { ids } = await activated();
    const res = await post('/v1/refresh', new Device().request('REFRESH', ids));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'KEY_MISMATCH');
    assert.equal(res.body.license, undefined);
  });

  test('forged, unknown and wrong-type requests are plain refusals', async () => {
    const { device, ids } = await activated();
    const forged = device.request('REFRESH', ids);
    forged.device_sig = new Device().request('REFRESH', ids).device_sig;
    assert.equal((await post('/v1/refresh', forged)).body.error, 'BAD_SIGNATURE');
    assert.equal((await post('/v1/refresh', device.request('REFRESH', { ...ids, activation_id: 'ACT-none' }))).status, 404);
    assert.equal((await post('/v1/activate', device.request('REFRESH', ids))).body.error, 'WRONG_TYPE');
  });

  test('online activation never approves a transfer by itself', async () => {
    const { key } = customerWithLicense(env.service, 'ANNUAL', 'ONLINE', 1);
    assert.equal((await post('/v1/activate', new Device().request('ACTIVATE', { license_key: key }))).status, 200);
    const second = await post('/v1/activate', new Device().request('ACTIVATE', { license_key: key }));
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'MACHINE_LIMIT_REACHED');
  });
});
