/**
 * Loads the signing key the server issues files with (3.3).
 *
 * The private key stays in its encrypted PEM file; the passphrase comes from
 * the environment at start-up and is never written anywhere by the server.
 * Without a key the server still runs - the License Manager can be used for
 * bookkeeping - but refuses to issue files.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Signer } from './core/envelope.ts';

const DEV_KEY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/kdr-license/dev/dev.key');

export function loadSigner(env: NodeJS.ProcessEnv = process.env): Signer | null {
  if (env.KDR_DEV_SIGNING === '1') {
    // The development key, whose public half is in
    // src-tauri/license-keys.dev.json: a key a release build of KADRA is
    // not meant to carry, so files signed with it are for testing only.
    return { kid: 'dev', key: crypto.createPrivateKey(fs.readFileSync(DEV_KEY)) };
  }
  const file = env.KDR_SIGNING_KEY;
  const kid = env.KDR_SIGNING_KID;
  if (!file || !kid) return null;
  const key = crypto.createPrivateKey({
    key: fs.readFileSync(file),
    passphrase: env.KDR_SIGNING_PASSPHRASE ?? ''
  });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file} is not an Ed25519 key`);
  return { kid, key };
}

export function loadDevSigner(): Signer {
  return { kid: 'dev', key: crypto.createPrivateKey(fs.readFileSync(DEV_KEY)) };
}
