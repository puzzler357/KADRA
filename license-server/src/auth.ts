/**
 * License Manager sign-in (10.2): password plus a second factor.
 *
 * Passwords are scrypt hashes. The second factor is TOTP (RFC 6238, the codes
 * any authenticator app shows), with each 30-second step accepted once so a
 * code seen over someone's shoulder cannot be replayed. Sessions are random
 * tokens stored only as hashes.
 */

import crypto from 'node:crypto';
import type { Db } from './db.ts';

const SESSION_HOURS = 12;
const TOTP_STEP = 30;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ----------------------------------------------------------------- passwords

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length,
    { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------- TOTP

export function newTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return bits.match(/.{5}/g)!.map(chunk => BASE32[parseInt(chunk, 2)]).join('');
}

function base32Decode(secret: string): Buffer {
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('bad base32');
    bits += index.toString(2).padStart(5, '0');
  }
  return Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)));
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

export const currentStep = (now: Date) => Math.floor(now.getTime() / 1000 / TOTP_STEP);

export function otpauthUri(username: string, secret: string): string {
  return `otpauth://totp/KADRA%20License%20Manager:${encodeURIComponent(username)}?secret=${secret}&issuer=KADRA%20License%20Manager`;
}

/**
 * The step a code belongs to, allowing one step of clock drift either way;
 * null when it matches none, or matches one already used.
 */
function matchingStep(secret: string, code: string, now: Date, lastStep: number): number | null {
  const step = currentStep(now);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate <= lastStep) continue;
    const expected = Buffer.from(totpAt(secret, candidate));
    const given = Buffer.from(code.padEnd(6).slice(0, 6));
    if (crypto.timingSafeEqual(expected, given)) return candidate;
  }
  return null;
}

// ------------------------------------------------------------------ accounts

interface AdminRow {
  username: string;
  password_hash: string;
  totp_secret: string;
  totp_last_step: number;
}

export function addAdmin(db: Db, username: string, password: string): { secret: string; uri: string } {
  if (!/^[a-z0-9._-]{3,32}$/i.test(username)) throw new Error('Имя: 3–32 символа, латиница, цифры, . _ -');
  if (password.length < 12) throw new Error('Пароль — не короче 12 символов');
  const secret = newTotpSecret();
  db.prepare(`INSERT INTO admins (username, password_hash, totp_secret, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, totp_secret = excluded.totp_secret,
    totp_last_step = 0`)
    .run(username, hashPassword(password), secret, new Date().toISOString());
  // A changed password or second factor ends every open session.
  db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
  return { secret, uri: otpauthUri(username, secret) };
}

/** Checks all three factors; on success returns a new session token. */
export function login(db: Db, username: string, password: string, code: string, now = new Date()): string | null {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as AdminRow | undefined;
  // Without an account, still spend the time a password check takes, so the
  // response time does not reveal which usernames exist.
  const passwordOk = admin
    ? verifyPassword(password, admin.password_hash)
    : (verifyPassword(password, hashPassword('timing-equaliser')), false);
  if (!admin || !passwordOk) return null;

  const step = matchingStep(admin.totp_secret, String(code ?? ''), now, Number(admin.totp_last_step));
  if (step === null) return null;
  db.prepare('UPDATE admins SET totp_last_step = ? WHERE username = ?').run(step, username);

  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), username, now.toISOString(), new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString());
  return token;
}

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function sessionUser(db: Db, token: string | undefined, now = new Date()): string | null {
  if (!token) return null;
  const row = db.prepare('SELECT username, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
    { username: string; expires_at: string } | undefined;
  if (!row) return null;
  if (row.expires_at <= now.toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return row.username;
}

export function logout(db: Db, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export const SESSION_COOKIE = 'kdr_lm';
export const SESSION_MAX_AGE_MS = SESSION_HOURS * 3_600_000;
