/**
 * Loads the signing keys the server issues files with (3.3) - one per
 * application, since each application trusts only its own (src/products.ts).
 *
 * The private keys stay in their encrypted PEM files; the passphrases come
 * from the environment at start-up and are never written anywhere by the
 * server. Without a key for an application the server still runs - the
 * License Manager can be used for bookkeeping - but refuses to issue that
 * application's files.
 *
 *   KADRA: KDR_SIGNING_KEY,   KDR_SIGNING_KID,   KDR_SIGNING_PASSPHRASE,   KDR_DEV_SIGNING=1
 *   SALDO: SALDO_SIGNING_KEY, SALDO_SIGNING_KID, SALDO_SIGNING_PASSPHRASE, SALDO_DEV_SIGNING=1
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawPublicKey, type Signer } from './core/envelope.ts';
import { PRODUCT_CODES, PRODUCTS, type ProductCode } from './products.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Development keys, whose public halves are in each application's
 * src-tauri/license-keys.dev.json: keys a release build is not meant to carry,
 * so files signed with them are for testing only. SALDO's lives in its own
 * repository too; this is a copy, so the server does not reach into it.
 */
const DEV_KEYS: Record<ProductCode, string> = {
  KADRA: path.resolve(HERE, '../../tools/kdr-license/dev/dev.key'),
  SALDO: path.resolve(HERE, '../dev/saldo-dev.key')
};

export type Signers = Partial<Record<ProductCode, Signer | null>>;

/**
 * One application's key, or null when none is configured.
 *
 * A key whose kid the application's builds know must be the very key they
 * know: a mistake here (SALDO's variables pointing at KADRA's key file, say)
 * would otherwise turn into files every client refuses. Such a key is not
 * used, and the reason is returned for the start-up log.
 */
export function loadProductSigner(env: NodeJS.ProcessEnv, code: ProductCode):
  { signer: Signer | null; problem: string | null } {
  const product = PRODUCTS[code];
  const prefix = product.env;
  let signer: Signer | null;
  if (env[`${prefix}_DEV_SIGNING`] === '1') {
    signer = { kid: 'dev', key: crypto.createPrivateKey(fs.readFileSync(DEV_KEYS[code])) };
  } else {
    const file = env[`${prefix}_SIGNING_KEY`];
    const kid = env[`${prefix}_SIGNING_KID`];
    if (!file || !kid) return { signer: null, problem: null };
    const key = crypto.createPrivateKey({
      key: fs.readFileSync(file),
      passphrase: env[`${prefix}_SIGNING_PASSPHRASE`] ?? ''
    });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an Ed25519 key`);
    signer = { kid, key };
  }

  const expected = product.publicKeys[signer.kid];
  if (expected === undefined) {
    return {
      signer,
      problem: `kid "${signer.kid}" is not among the keys ${code} builds carry (${Object.keys(product.publicKeys).join(', ')}): `
        + `${code} will refuse these files unless its build was given this key`
    };
  }
  if (rawPublicKey(signer.key) !== expected) {
    return {
      signer: null,
      problem: `the key loaded as "${signer.kid}" is not ${code}'s "${signer.kid}" key - not used; ${code} files cannot be issued`
    };
  }
  return { signer, problem: null };
}

/** Every application's key from the environment, with what is worth logging about each. */
export function loadSigners(env: NodeJS.ProcessEnv = process.env): { signers: Signers; problems: string[] } {
  const signers: Signers = {};
  const problems: string[] = [];
  for (const code of PRODUCT_CODES) {
    const { signer, problem } = loadProductSigner(env, code);
    signers[code] = signer;
    if (problem) problems.push(`${code}: ${problem}`);
  }
  return { signers, problems };
}

export function loadDevSigner(code: ProductCode = 'KADRA'): Signer {
  return { kid: 'dev', key: crypto.createPrivateKey(fs.readFileSync(DEV_KEYS[code])) };
}
