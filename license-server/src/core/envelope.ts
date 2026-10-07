/**
 * Signed containers (3.1, 5.1): the seller's envelope around licences and
 * statuses, and the device-signed request.
 *
 * The signature covers the exact payload bytes, so neither side needs a
 * canonical JSON form; the client verifies before it parses.
 */

import crypto from 'node:crypto';
import { RuleError, type Fingerprint } from './rules.ts';

export interface Envelope {
  kid: string;
  payload: string;
  sig: string;
}

export interface SignedRequest {
  payload: string;
  device_sig: string;
}

export type RequestType = 'ACTIVATE' | 'REFRESH' | 'REBIND' | 'DEACTIVATE';

/** 5.1 */
export interface RequestPayload {
  type: RequestType;
  license_key?: string;
  license_id?: string;
  activation_id?: string;
  current_revision?: number;
  device_name: string;
  device_pubkey: string;
  fp: Fingerprint;
  app_version: string;
  client_time: string;
  counter: number;
  nonce: string;
}

export interface Signer {
  kid: string;
  key: crypto.KeyObject;
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export function seal(signer: Signer, payload: object): Envelope {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return { kid: signer.kid, payload: b64u(bytes), sig: b64u(crypto.sign(null, bytes, signer.key)) };
}

export function publicKeyFromRaw(raw: string): crypto.KeyObject {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

/** The 32-byte public key as base64url, from a public or a private key. */
export function rawPublicKey(key: crypto.KeyObject): string {
  const publicKey = key.type === 'public' ? key : crypto.createPublicKey(key);
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('not an Ed25519 key');
  return jwk.x;
}

/** Opens an envelope; `verified` is null when the kid is not among `keys`. */
export function openEnvelope(envelope: Envelope, keys: Record<string, string>) {
  const bytes = Buffer.from(envelope.payload, 'base64url');
  const key = keys[envelope.kid];
  const verified = key
    ? crypto.verify(null, bytes, publicKeyFromRaw(key), Buffer.from(envelope.sig, 'base64url'))
    : null;
  return { payload: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, verified };
}

const REQUEST_TYPES: RequestType[] = ['ACTIVATE', 'REFRESH', 'REBIND', 'DEACTIVATE'];

/**
 * A device request, checked against the key it names. Proves the request was
 * made on the device holding that key - not that the device is entitled to
 * anything; the service decides that.
 */
export function verifyRequest(signed: unknown): RequestPayload {
  const bad = (why: string) => new RuleError('BAD_REQUEST_FILE', `Файл запроса не читается: ${why}`);
  if (!signed || typeof signed !== 'object') throw bad('это не JSON-объект');
  const { payload, device_sig } = signed as Partial<SignedRequest>;
  if (typeof payload !== 'string' || typeof device_sig !== 'string') throw bad('нет payload или device_sig');

  const bytes = Buffer.from(payload, 'base64url');
  let parsed: RequestPayload;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw bad('payload не JSON');
  }
  if (!REQUEST_TYPES.includes(parsed.type)) throw bad(`неизвестный тип ${String(parsed.type)}`);
  if (typeof parsed.device_pubkey !== 'string' || !parsed.fp) throw bad('нет ключа или отпечатка устройства');

  let ok = false;
  try {
    ok = crypto.verify(null, bytes, publicKeyFromRaw(parsed.device_pubkey), Buffer.from(device_sig, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw new RuleError('BAD_SIGNATURE', 'Подпись устройства в запросе неверна');
  return parsed;
}

export const sha256 = (text: string | Buffer) => crypto.createHash('sha256').update(text).digest('hex');
