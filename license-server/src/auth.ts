/**
 * License Manager sign-in (10.2): a password, and a second factor where the
 * account has turned one on.
 *
 * Passwords are scrypt hashes. The second factor is TOTP (RFC 6238, the codes
 * any authenticator app shows), with each 30-second step accepted once so a
 * code seen over someone's shoulder cannot be replayed. It is the account's
 * own choice: off until switched on in the panel, and on only after a code
 * made from the new secret has been shown to work. Sessions are random
 * tokens stored only as hashes.
 *
 * A database with no administrator in it gets one: `admin` / `1234`, with
 * `must_change_password` set. That account can do nothing but set its own
 * password - so the way into a fresh installation closes the first time it
 * is used.
 */

import crypto from 'node:crypto';
import { RuleError } from './core/rules.ts';
import type { Db } from './db.ts';

const SESSION_HOURS = 12;
const MIN_PASSWORD = 12;
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
  must_change_password: number;
}

const adminRow = (db: Db, username: string) =>
  db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as AdminRow | undefined;

const noSuchAdmin = () => new RuleError('NO_SUCH_ADMIN', 'Нет такого администратора', 404);

/** The account a database with no administrator in it is given. */
export const BOOTSTRAP_USERNAME = 'admin';
export const BOOTSTRAP_PASSWORD = '1234';

/**
 * Creates that account, and only while there is nobody at all: the panel is
 * the only place a licence can be issued from, and a fresh installation would
 * otherwise have no way in. Returns true when it was created.
 */
export function ensureBootstrapAdmin(db: Db): boolean {
  const { n } = db.prepare('SELECT count(*) AS n FROM admins').get() as { n: number };
  if (Number(n) > 0) return false;
  db.prepare(`INSERT INTO admins (username, password_hash, totp_secret, must_change_password, created_at)
    VALUES (?, ?, '', 1, ?)`)
    .run(BOOTSTRAP_USERNAME, hashPassword(BOOTSTRAP_PASSWORD), new Date().toISOString());
  return true;
}

/** Whether this account still has the password a fresh installation hands out. */
export function mustChangePassword(db: Db, username: string): boolean {
  return Number(adminRow(db, username)?.must_change_password ?? 0) === 1;
}

/** Whether signing in to this account takes a code as well as the password. */
export function totpEnabled(db: Db, username: string): boolean {
  return Boolean(adminRow(db, username)?.totp_secret);
}

/**
 * A new password. While the account still has the one a fresh installation
 * hands out, nothing more is asked: its session can do nothing else, and the
 * password it would have to repeat is public. After that the current one is
 * required, so that a session left open on a screen is not enough to take
 * the account over. The second factor stays as it is. Every session of the
 * account ends.
 */
export function changePassword(db: Db, username: string, password: string, current = ''): void {
  const admin = adminRow(db, username);
  if (!admin) throw noSuchAdmin();
  if (Number(admin.must_change_password) !== 1 && !verifyPassword(current, admin.password_hash)) {
    throw new RuleError('WRONG_PASSWORD', 'Текущий пароль неверен', 403);
  }
  if (password.length < MIN_PASSWORD) {
    throw new RuleError('PASSWORD_TOO_SHORT', `Пароль — не короче ${MIN_PASSWORD} символов`);
  }
  db.prepare('UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE username = ?')
    .run(hashPassword(password), username);
  db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
}

/**
 * Turns the second factor on. The secret comes back from the panel together
 * with a code made from it: a secret that never reached an authenticator app
 * must not become the thing sign-in depends on. That code is spent, like any
 * other. Every session of the account ends.
 */
export function enableTotp(db: Db, username: string, secret: string, code: string, now = new Date()): void {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new RuleError('BAD_SECRET', 'Секрет повреждён, начните заново');
  const step = /^\d{6}$/.test(code) ? matchingStep(secret, code, now, 0) : null;
  if (step === null) {
    throw new RuleError('WRONG_CODE', 'Код не подошёл: проверьте секрет в приложении и время на телефоне');
  }
  const changed = db.prepare('UPDATE admins SET totp_secret = ?, totp_last_step = ? WHERE username = ?')
    .run(secret, step, username);
  if (!changed.changes) throw noSuchAdmin();
  db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
}

/** Turns it off again. Asks for the password, as changing the password does. */
export function disableTotp(db: Db, username: string, password: string): void {
  const admin = adminRow(db, username);
  if (!admin) throw noSuchAdmin();
  if (!verifyPassword(password, admin.password_hash)) throw new RuleError('WRONG_PASSWORD', 'Пароль неверен', 403);
  db.prepare("UPDATE admins SET totp_secret = '', totp_last_step = 0 WHERE username = ?").run(username);
  db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
}

/**
 * Creates an administrator, or resets one: a new password, and the second
 * factor off unless `totp` asks for it - which makes this the way back in
 * for someone whose authenticator app is gone. With `totp`, the secret is
 * returned once.
 */
export function addAdmin(db: Db, username: string, password: string, options: { totp?: boolean } = {}):
  { secret: string; uri: string } | null {
  if (!/^[a-z0-9._-]{3,32}$/i.test(username)) throw new Error('Имя: 3–32 символа, латиница, цифры, . _ -');
  if (password.length < MIN_PASSWORD) throw new Error(`Пароль — не короче ${MIN_PASSWORD} символов`);
  const secret = options.totp ? newTotpSecret() : '';
  db.prepare(`INSERT INTO admins (username, password_hash, totp_secret, must_change_password, created_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, totp_secret = excluded.totp_secret,
    totp_last_step = 0, must_change_password = 0`)
    .run(username, hashPassword(password), secret, new Date().toISOString());
  // A changed password or second factor ends every open session.
  db.prepare('DELETE FROM sessions WHERE username = ?').run(username);

  // A real administrator makes the account from the fresh installation
  // pointless, and one left behind with its default password is a way in
  // nobody is watching. It goes - unless its password was already changed,
  // which makes it an account like any other.
  if (username !== BOOTSTRAP_USERNAME
    && db.prepare('SELECT 1 FROM admins WHERE username = ? AND must_change_password = 1').get(BOOTSTRAP_USERNAME)) {
    db.prepare('DELETE FROM sessions WHERE username = ?').run(BOOTSTRAP_USERNAME);
    db.prepare('DELETE FROM admins WHERE username = ?').run(BOOTSTRAP_USERNAME);
  }
  return secret ? { secret, uri: otpauthUri(username, secret) } : null;
}

export interface Session {
  token: string;
  /** The session may do nothing but change that account's password. */
  mustChangePassword: boolean;
}

/**
 * Checks the password and, where the account has a second factor, the code;
 * on success returns a new session. Every failure looks the same: which of
 * the three was wrong is not said.
 */
export function login(db: Db, username: string, password: string, code: string, now = new Date()): Session | null {
  const admin = adminRow(db, username);
  // Without an account, still spend the time a password check takes, so the
  // response time does not reveal which usernames exist.
  const passwordOk = admin
    ? verifyPassword(password, admin.password_hash)
    : (verifyPassword(password, hashPassword('timing-equaliser')), false);
  if (!admin || !passwordOk) return null;

  // Where the account has a second factor, the password alone opens nothing.
  if (admin.totp_secret) {
    const step = matchingStep(admin.totp_secret, String(code ?? ''), now, Number(admin.totp_last_step));
    if (step === null) return null;
    db.prepare('UPDATE admins SET totp_last_step = ? WHERE username = ?').run(step, username);
  }
  return { token: openSession(db, username, now), mustChangePassword: Number(admin.must_change_password) === 1 };
}

/**
 * A session for an account already known to be who it says: after sign-in,
 * and after a change of password or second factor, which ends every session
 * of the account and would otherwise sign out the person who made it.
 */
export function openSession(db: Db, username: string, now = new Date()): string {
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
