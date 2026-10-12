/**
 * Licence keys, `KDR-XXXXX-XXXXX-XXXXX-XXXXX` for KADRA and
 * `SALDO-XXXXX-XXXXX-XXXXX-XXXXX` for SALDO (10.1, src/products.ts).
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
import { DEFAULT_PRODUCT, PRODUCT_CODES, product, type ProductCode } from '../products.ts';

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

function group(prefix: string, chars: string): string {
  return `${prefix}-${chars.match(/.{5}/g)!.join('-')}`;
}

export function generateLicenseKey(code: ProductCode = DEFAULT_PRODUCT): string {
  const bytes = crypto.randomBytes(RANDOM_CHARS);
  const body = Array.from(bytes, byte => ALPHABET[byte % 32]).join('');
  return group(product(code).prefix, body + checkSymbol(body));
}

/**
 * The canonical form of what a person typed: case, spaces, dashes and the
 * look-alike letters do not matter. `null` when it cannot be a key.
 */
export function normalizeLicenseKey(input: string, code: ProductCode = DEFAULT_PRODUCT): string | null {
  const prefix = product(code).prefix;
  let chars = input.toUpperCase().replace(/[\s-]/g, '');
  // The prefix is optional, and the body itself may start with its letters,
  // so it is recognised by length as well - before the look-alike letters
  // (O, L) are folded into digits.
  if (chars.length === RANDOM_CHARS + 1 + prefix.length && chars.startsWith(prefix)) chars = chars.slice(prefix.length);
  chars = chars.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (chars.length !== RANDOM_CHARS + 1) return null;
  if ([...chars].some(c => !ALPHABET.includes(c))) return null;
  if (checkSymbol(chars.slice(0, -1)) !== chars.at(-1)) return null;
  return group(prefix, chars);
}

/**
 * What a typed key can be: one normalised form per product it fits. A key
 * typed with its prefix fits one product; without the prefix it fits every
 * product, and the stored hashes decide which licence - if any - it is.
 */
export function licenseKeyCandidates(input: string): { product: ProductCode; key: string }[] {
  return PRODUCT_CODES.flatMap(code => {
    const key = normalizeLicenseKey(input, code);
    return key ? [{ product: code, key }] : [];
  });
}

/**
 * The stored form of a normalised key. Salted with the key's own prefix, so
 * a KADRA key hashes exactly as it always has (`KDR-key-v1:`), and a SALDO
 * key as SALDO's own server hashed it (`SALDO-key-v1:`).
 */
export function hashLicenseKey(normalized: string): string {
  const prefix = normalized.slice(0, normalized.indexOf('-'));
  return crypto.createHash('sha256').update(`${prefix}-key-v1:${normalized}`).digest('hex');
}
