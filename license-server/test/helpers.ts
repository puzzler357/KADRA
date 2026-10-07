import crypto from 'node:crypto';
import { openDb } from '../src/db.ts';
import { LicenseService, type Clock } from '../src/service.ts';
import { rawPublicKey, type RequestType } from '../src/core/envelope.ts';
import type { Fingerprint } from '../src/core/rules.ts';

export class TestClock implements Clock {
  current: Date;
  constructor(start: string) {
    this.current = new Date(start);
  }
  now() {
    return new Date(this.current);
  }
  set(value: string) {
    this.current = new Date(value);
  }
}

export function setup(start = '2026-09-27T16:00:00Z') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const clock = new TestClock(start);
  const service = new LicenseService(openDb(':memory:'), { kid: 'test', key: privateKey }, clock);
  return { service, clock, keys: { test: rawPublicKey(publicKey) } };
}

let machines = 0;

/** A computer running HRDesk: its fingerprint and device key, signing requests as the client does. */
export class Device {
  fp: Fingerprint;
  key = crypto.generateKeyPairSync('ed25519');
  counter = 0;
  name: string;

  constructor(fp?: Fingerprint) {
    const n = ++machines;
    this.name = `PC-${n}`;
    this.fp = fp ?? { mg: `mg-${n}`, smbios: `sm-${n}`, disk: `disk-${n}` };
  }

  /** Windows reinstalled: new MachineGuid and a new device key. */
  reinstall() {
    this.fp = { ...this.fp, mg: `${this.fp.mg}-new` };
    this.key = crypto.generateKeyPairSync('ed25519');
  }

  request(type: RequestType, fields: Record<string, unknown> = {}) {
    const payload = {
      type,
      ...fields,
      device_name: this.name,
      device_pubkey: rawPublicKey(this.key.publicKey),
      fp: this.fp,
      app_version: '1.0.0',
      client_time: new Date().toISOString(),
      counter: ++this.counter,
      nonce: crypto.randomBytes(16).toString('base64url')
    };
    const bytes = Buffer.from(JSON.stringify(payload));
    return {
      payload: bytes.toString('base64url'),
      device_sig: crypto.sign(null, bytes, this.key.privateKey).toString('base64url')
    };
  }
}

export function customerWithLicense(service: LicenseService, plan = 'ANNUAL', mode: 'ONLINE' | 'OFFLINE' = 'OFFLINE', seats = 1) {
  const customer = service.createCustomer({ name: 'ABC Ltd.' }, 'test');
  const { license, license_key } = service.createLicense(
    { customer_id: customer.id, plan, activation_mode: mode, seats }, 'test');
  return { customer, license, key: license_key };
}

export function decode(content: string) {
  const envelope = JSON.parse(content);
  return JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
}
