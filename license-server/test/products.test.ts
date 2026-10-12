/**
 * One server for two applications: KADRA and SALDO licences side by side in
 * one database, each producing files only its own application accepts - and
 * a database from the KADRA-only days carrying on unchanged.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { addAdmin } from '../src/auth.ts';
import { openEnvelope, rawPublicKey } from '../src/core/envelope.ts';
import { generateLicenseKey, hashLicenseKey, licenseKeyCandidates, normalizeLicenseKey } from '../src/core/licenseKey.ts';
import { openDb } from '../src/db.ts';
import { createWebhookSource, signPayload } from '../src/payments.ts';
import { PRODUCTS, productOfFilename } from '../src/products.ts';
import { LicenseService } from '../src/service.ts';
import { loadSigners } from '../src/signer.ts';
import { Device, TestClock, decode } from './helpers.ts';

/** A service with a separate key for each application, as the server runs. */
function setupBoth(start = '2026-10-12T08:00:00Z', options: { saldoKey?: boolean } = {}) {
  const kadra = crypto.generateKeyPairSync('ed25519');
  const saldo = crypto.generateKeyPairSync('ed25519');
  const clock = new TestClock(start);
  const service = new LicenseService(openDb(':memory:'), {
    KADRA: { kid: 'kdr-test', key: kadra.privateKey },
    SALDO: options.saldoKey === false ? null : { kid: 'saldo-test', key: saldo.privateKey }
  }, clock);
  // What each application's build trusts: its own key only.
  const keyrings = {
    KADRA: { 'kdr-test': rawPublicKey(kadra.publicKey) },
    SALDO: { 'saldo-test': rawPublicKey(saldo.publicKey) }
  };
  const customer = service.createCustomer({ name: 'Arslan Ruhabat' }, 'test');
  return { service, clock, keyrings, customer };
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

describe('licence keys of two applications', () => {
  test('a SALDO key is SALDO-XXXXX-XXXXX-XXXXX-XXXXX and reads back with or without its prefix', () => {
    for (let i = 0; i < 100; i++) {
      const key = generateLicenseKey('SALDO');
      assert.match(key, /^SALDO-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      assert.equal(normalizeLicenseKey(key, 'SALDO'), key);
      assert.equal(normalizeLicenseKey(key.slice('SALDO-'.length), 'SALDO'), key);
      assert.equal(normalizeLicenseKey(key.toLowerCase().replace(/-/g, ' '), 'SALDO'), key);
    }
  });

  test('a key typed with its prefix fits one application only; without it, both', () => {
    const kadra = generateLicenseKey('KADRA');
    const saldo = generateLicenseKey('SALDO');
    assert.deepEqual(licenseKeyCandidates(kadra).map(c => c.product), ['KADRA']);
    assert.deepEqual(licenseKeyCandidates(saldo).map(c => c.product), ['SALDO']);
    assert.equal(normalizeLicenseKey(saldo, 'KADRA'), null);
    assert.equal(normalizeLicenseKey(kadra, 'SALDO'), null);
    assert.deepEqual(licenseKeyCandidates(saldo.slice(6)).map(c => c.product), ['KADRA', 'SALDO']);
  });

  test('stored hashes are the ones each server has always written', () => {
    // KADRA's keys already sold must still be found: same salt, same input.
    const kadra = generateLicenseKey('KADRA');
    assert.equal(hashLicenseKey(kadra), sha256(`KDR-key-v1:${kadra}`));
    // And SALDO's as SALDO's own server hashed them.
    const saldo = generateLicenseKey('SALDO');
    assert.equal(hashLicenseKey(saldo), sha256(`SALDO-key-v1:${saldo}`));
  });

  test('the extension of a request file names its application', () => {
    assert.equal(productOfFilename('client.kdrreq'), 'KADRA');
    assert.equal(productOfFilename('C:\\Users\\a\\Desktop\\SALDO request.SALDOREQ'), 'SALDO');
    assert.equal(productOfFilename('proof.saldodeact'), 'SALDO');
    assert.equal(productOfFilename('request.json'), null);
    assert.equal(productOfFilename(undefined), null);
  });
});

describe('SALDO licences next to KADRA ones', () => {
  test('each application numbers its licences on its own; KADRA keeps its sequence', () => {
    const { service, customer } = setupBoth();
    const make = (product?: 'KADRA' | 'SALDO') =>
      service.createLicense({ customer_id: customer.id, plan: 'PERPETUAL', activation_mode: 'OFFLINE', product }, 'test');
    assert.equal(make().license.id, 'KDR-2026-000001', 'no product given: KADRA, as before');
    const saldo = make('SALDO');
    assert.equal(saldo.license.id, 'SALDO-2026-000001');
    assert.equal(saldo.license.product, 'SALDO');
    assert.match(saldo.license_key, /^SALDO-/);
    assert.equal(make('KADRA').license.id, 'KDR-2026-000002');
    assert.equal(make('SALDO').license.id, 'SALDO-2026-000002');
    assert.deepEqual(service.listLicenses({ product: 'SALDO' }).map((l: any) => l.id).sort(),
      ['SALDO-2026-000001', 'SALDO-2026-000002']);
    assert.throws(() => make('GAS' as never), /Неизвестное приложение/);
  });

  test('an offline SALDO activation gives a .saldolic for SALDO, signed with SALDO\'s key', () => {
    const { service, customer, keyrings } = setupBoth();
    const { license, license_key } = service.createLicense(
      { customer_id: customer.id, plan: 'ANNUAL', activation_mode: 'OFFLINE', product: 'SALDO' }, 'test');
    const { file } = service.processRequest(new Device().request('ACTIVATE', { license_key }),
      { actor: 'test', product: 'SALDO' });
    assert.match(file!.filename, new RegExp(`^${license.id}_ACT-[0-9a-f]{8}_r1\\.saldolic$`));
    const envelope = JSON.parse(file!.content);
    assert.equal(envelope.kid, 'saldo-test');
    assert.equal(openEnvelope(envelope, keyrings.SALDO).verified, true);
    assert.equal(openEnvelope(envelope, keyrings.KADRA).verified, null, 'KADRA does not know this key');
    assert.equal(decode(file!.content).product, 'SALDO');
  });

  test('KADRA files stay exactly as they were', () => {
    const { service, customer, keyrings } = setupBoth();
    const { license_key } = service.createLicense(
      { customer_id: customer.id, plan: 'PERPETUAL', activation_mode: 'OFFLINE' }, 'test');
    const { file } = service.processRequest(new Device().request('ACTIVATE', { license_key }), { actor: 'test', product: 'KADRA' });
    assert.match(file!.filename, /\.kdrlic$/);
    assert.equal(openEnvelope(JSON.parse(file!.content), keyrings.KADRA).verified, true);
    assert.equal(decode(file!.content).product, 'KADRA');
  });

  test('a request file from one application cannot use a licence of the other', () => {
    const { service, customer } = setupBoth();
    const saldo = service.createLicense({ customer_id: customer.id, plan: 'PERPETUAL', activation_mode: 'OFFLINE', product: 'SALDO' }, 'test');
    const request = new Device().request('ACTIVATE', { license_key: saldo.license_key });
    const decision = service.inspectRequest(request, { product: 'KADRA' });
    assert.equal(decision.blocked?.code, 'WRONG_PRODUCT');
    assert.equal(decision.license?.id, saldo.license.id);
    assert.throws(() => service.processRequest(request, { actor: 'test', product: 'KADRA' }), { code: 'WRONG_PRODUCT' });
    assert.equal(service.licenseDetails(saldo.license.id).activations.length, 0, 'no seat taken');
  });

  test('clock unlock and renewal files carry SALDO\'s extension and key', () => {
    const { service, customer, keyrings } = setupBoth();
    const { license, license_key } = service.createLicense(
      { customer_id: customer.id, plan: 'ANNUAL', activation_mode: 'OFFLINE', product: 'SALDO' }, 'test');
    const { file } = service.processRequest(new Device().request('ACTIVATE', { license_key }), { actor: 'test' });
    const reset = service.issueClockReset(file!.activation_id, null, 'test');
    assert.match(reset.filename, /\.saldoclock$/);
    assert.equal(openEnvelope(JSON.parse(reset.content), keyrings.SALDO).verified, true);
    const { files } = service.renewLicense(license.id, { source: 'cash' }, 'test');
    assert.equal(files.length, 1);
    assert.match(files[0].filename, /\.saldolic$/);
    assert.equal(openEnvelope(JSON.parse(files[0].content), keyrings.SALDO).verified, true);
  });

  test('without SALDO\'s key SALDO files are refused, KADRA\'s are not', () => {
    const { service, customer } = setupBoth(undefined, { saldoKey: false });
    const saldo = service.createLicense({ customer_id: customer.id, plan: 'PERPETUAL', activation_mode: 'OFFLINE', product: 'SALDO' }, 'test');
    assert.throws(() => service.processRequest(new Device().request('ACTIVATE', { license_key: saldo.license_key }), { actor: 'test' }),
      { code: 'NO_SIGNING_KEY', message: /SALDO/ });
    assert.equal(service.licenseDetails(saldo.license.id).activations.length, 0, 'rolled back: no seat taken');
    const kadra = service.createLicense({ customer_id: customer.id, plan: 'PERPETUAL', activation_mode: 'OFFLINE' }, 'test');
    assert.ok(service.processRequest(new Device().request('ACTIVATE', { license_key: kadra.license_key }), { actor: 'test' }).file);
    assert.deepEqual(service.products().map(p => [p.code, p.kid]), [['KADRA', 'kdr-test'], ['SALDO', null]]);
  });
});

describe('both applications over HTTP', () => {
  let env: ReturnType<typeof setupBoth>;
  let base: string;
  let cookie: string;
  let close: () => void;

  before(async () => {
    env = setupBoth();
    const server = createApp(env.service, { secureCookie: false }).listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    addAdmin(env.service.db, 'owner', 'correct horse battery');
    const res = await fetch(`${base}/admin/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery' })
    });
    cookie = res.headers.get('set-cookie')!.split(';')[0];
  });
  after(() => close());

  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', 'X-KDR-LM': '1', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() as any };
  };

  test('the panel lists both applications and creates a SALDO licence', async () => {
    const products = await call('GET', '/admin/api/products');
    assert.deepEqual(products.body.map((p: any) => [p.code, p.ext.request]), [['KADRA', 'kdrreq'], ['SALDO', 'saldoreq']]);
    const created = await call('POST', '/admin/api/licenses',
      { customer_id: env.customer.id, plan: 'PERPETUAL', activation_mode: 'OFFLINE', product: 'SALDO' });
    assert.equal(created.status, 200);
    assert.equal(created.body.license.product, 'SALDO');
    assert.match(created.body.license_key, /^SALDO-/);
    const listed = await call('GET', '/admin/api/licenses?product=SALDO');
    assert.ok(listed.body.every((l: any) => l.product === 'SALDO'));
    assert.equal((await call('GET', '/admin/api/licenses?product=XYZ')).status, 400);
  });

  test('a .saldoreq is taken by the offline page; a .kdrreq with a SALDO key is refused', async () => {
    const { body } = await call('POST', '/admin/api/licenses',
      { customer_id: env.customer.id, plan: 'PERPETUAL', activation_mode: 'OFFLINE', product: 'SALDO' });
    const request = new Device().request('ACTIVATE', { license_key: body.license_key });
    const wrong = await call('POST', '/v1/offline/inspect', { request, filename: 'client.kdrreq' });
    assert.equal(wrong.body.blocked.code, 'WRONG_PRODUCT');
    const right = await call('POST', '/v1/offline/inspect', { request, filename: 'client.saldoreq' });
    assert.equal(right.body.blocked, null);
    assert.equal(right.body.action, 'ACTIVATE_NEW');
    const done = await call('POST', '/v1/offline/process', { request, filename: 'client.saldoreq' });
    assert.equal(done.status, 200);
    assert.match(done.body.file.filename, /\.saldolic$/);
  });

  test('SALDO activates and refreshes online at the same addresses as KADRA', async () => {
    const created = env.service.createLicense(
      { customer_id: env.customer.id, plan: 'MONTHLY', activation_mode: 'ONLINE', product: 'SALDO' }, 'test');
    const device = new Device();
    const post = async (url: string, payload: unknown) => {
      const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: res.status, body: await res.json() as any };
    };
    const activated = await post('/v1/activate', device.request('ACTIVATE', { license_key: created.license_key }));
    assert.equal(activated.status, 200);
    const opened = openEnvelope(activated.body.license, env.keyrings.SALDO);
    assert.equal(opened.verified, true);
    assert.equal(opened.payload.product, 'SALDO');
    const activationId = (opened.payload.activation as any).activation_id;
    const refreshed = await post('/v1/refresh', device.request('REFRESH', { license_id: created.license.id, activation_id: activationId }));
    assert.equal(refreshed.status, 200);
    assert.equal(openEnvelope(refreshed.body.license, env.keyrings.SALDO).verified, true);
    env.service.revokeLicense(created.license.id, 'test', 'test');
    const revoked = await post('/v1/refresh', device.request('REFRESH', { license_id: created.license.id, activation_id: activationId }));
    assert.equal(openEnvelope(revoked.body.status, env.keyrings.SALDO).verified, true, 'statuses are SALDO-signed too');
  });

  test('a payment webhook finds a SALDO licence by its key, under SALDO\'s header name too', async () => {
    const { secret } = createWebhookSource(env.service, 'bank', 'test');
    const created = env.service.createLicense(
      { customer_id: env.customer.id, plan: 'ANNUAL', activation_mode: 'ONLINE', product: 'SALDO' }, 'test');
    const raw = JSON.stringify({ payment_id: 'p-1', license_key: created.license_key });
    const res = await fetch(`${base}/v1/payments/bank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-SALDO-Signature': signPayload(secret, raw, Math.floor(Date.now() / 1000)) },
      body: raw
    });
    const body = await res.json() as any;
    assert.equal(res.status, 200);
    assert.equal(body.license_id, created.license.id);
  });
});

describe('a database from the KADRA-only days', () => {
  test('keeps its licences as KADRA licences: keys, numbering and files carry on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-'));
    const file = path.join(dir, 'license.db');
    const kadra = crypto.generateKeyPairSync('ed25519');
    const keyring = { 'kdr-test': rawPublicKey(kadra.publicKey) };
    const clock = new TestClock('2026-10-12T02:00:00Z');

    // Schema 2, as the server wrote it before SALDO: no product column.
    let db = openDb(file);
    let service = new LicenseService(db, { kid: 'kdr-test', key: kadra.privateKey }, clock);
    const customer = service.createCustomer({ name: 'Bahar Sapayewa' }, 'test');
    const old = service.createLicense({ customer_id: customer.id, plan: 'PERPETUAL', activation_mode: 'OFFLINE' }, 'test');
    const device = new Device();
    const first = service.processRequest(device.request('ACTIVATE', { license_key: old.license_key }), { actor: 'test' }).file!;
    db.exec('ALTER TABLE licenses DROP COLUMN product');
    db.exec('PRAGMA user_version = 2');
    db.close();

    db = openDb(file);
    assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 3);
    service = new LicenseService(db, { kid: 'kdr-test', key: kadra.privateKey }, clock);
    assert.equal(service.license(old.license.id).product, 'KADRA');
    // The same device asking again by the same key: found, same seat, next revision.
    const again = service.processRequest(device.request('ACTIVATE', { license_key: old.license_key }), { actor: 'test' });
    assert.equal(again.decision.action, 'REISSUE_SAME_DEVICE');
    assert.equal(again.file!.activation_id, first.activation_id);
    assert.equal(decode(again.file!.content).product, 'KADRA');
    assert.equal(openEnvelope(JSON.parse(again.file!.content), keyring).verified, true);
    const next = service.createLicense({ customer_id: customer.id, plan: 'PERPETUAL', activation_mode: 'OFFLINE' }, 'test');
    assert.equal(next.license.id, 'KDR-2026-000002');
    db.close();

    // Opening it a second time changes nothing more.
    db = openDb(file);
    assert.equal(db.prepare('SELECT count(*) AS n FROM licenses').get()!.n, 2);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('signing keys from the environment', () => {
  test('each application gets its own development key', () => {
    const { signers, problems } = loadSigners({ KDR_DEV_SIGNING: '1', SALDO_DEV_SIGNING: '1' });
    assert.deepEqual(problems, []);
    assert.equal(rawPublicKey(signers.KADRA!.key), PRODUCTS.KADRA.publicKeys.dev);
    assert.equal(rawPublicKey(signers.SALDO!.key), PRODUCTS.SALDO.publicKeys.dev);
  });

  test('nothing configured for SALDO: KADRA alone, as before', () => {
    const { signers, problems } = loadSigners({ KDR_DEV_SIGNING: '1' });
    assert.ok(signers.KADRA);
    assert.equal(signers.SALDO, null);
    assert.deepEqual(problems, []);
  });

  test('SALDO\'s variables pointing at a key that is not SALDO\'s: not used', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-key-'));
    const file = path.join(dir, 'saldo-2026-1.key');
    fs.writeFileSync(file, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const { signers, problems } = loadSigners({ SALDO_SIGNING_KEY: file, SALDO_SIGNING_KID: 'saldo-2026-1' });
    assert.equal(signers.SALDO, null);
    assert.match(problems.join('\n'), /SALDO: .*not used/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
