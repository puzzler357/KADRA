/**
 * Licence keys, `HRD-XXXXX-XXXXX-XXXXX-XXXXX` (10.1).
 *
 * Crockford base32, so the characters people confuse (O/0, I/L/1) read the
 * same. The last character is a Luhn mod 32 check symbol: a mistyped key is
 * caught on the client's screen instead of spending a rate-limited attempt.
 * That leaves 19 random characters, 95 bits - the spec's "100+" does not fit
 * the 4×5 format together with a check symbol, and 95 bits behind a stored
 * hash and a rate limit are far beyond guessing.
 *
 * The key is stored only as a hash. A plain SHA-256 is enough here: unlike a
 * password the key is random, so there is no dictionary to try.
 */

import crypto from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_CHARS = 19;

function checkSymbol(body: string): string {
  // Luhn mod N over the code points of the alphabet.
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    let addend = factor * ALPHABET.indexOf(body[i]);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }
  return ALPHABET[(32 - (sum % 32)) % 32];
}

function group(chars: string): string {
  return `HRD-${chars.match(/.{5}/g)!.join('-')}`;
}

export function generateLicenseKey(): string {
  const bytes = crypto.randomBytes(RANDOM_CHARS);
  const body = Array.from(bytes, byte => ALPHABET[byte % 32]).join('');
  return group(body + checkSymbol(body));
}

/**
 * The canonical form of what a person typed: case, spaces, dashes and the
 * look-alike letters do not matter. `null` when it cannot be a key.
 */
export function normalizeLicenseKey(input: string): string | null {
  let chars = input.toUpperCase().replace(/[\s-]/g, '');
  // The prefix is optional, and the body itself may start with "HRD", so it
  // is recognised by length rather than by its letters.
  if (chars.length === RANDOM_CHARS + 1 + 3 && chars.startsWith('HRD')) chars = chars.slice(3);
  chars = chars.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (chars.length !== RANDOM_CHARS + 1) return null;
  if ([...chars].some(c => !ALPHABET.includes(c))) return null;
  if (checkSymbol(chars.slice(0, -1)) !== chars.at(-1)) return null;
  return group(chars);
}

export function hashLicenseKey(normalized: string): string {
  return crypto.createHash('sha256').update(`HRD-key-v1:${normalized}`).digest('hex');
}
