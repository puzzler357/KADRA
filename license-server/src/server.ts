/**
 * Entry point. Configuration comes from the environment:
 *
 *   KDR_LICENSE_DB          database file            (default ./data/license.db)
 *   PORT / HOST             where to listen          (default 8787 on 127.0.0.1 -
 *                           put nginx or Caddy with HTTPS in front)
 *   KDR_SIGNING_KEY         KADRA's key: encrypted PEM from `kdr-license keygen`
 *   KDR_SIGNING_KID         its kid, e.g. kdr-2026-1
 *   KDR_SIGNING_PASSPHRASE  its passphrase
 *   KDR_DEV_SIGNING=1       sign KADRA files with the dev key instead (debug KADRA builds only)
 *   SALDO_SIGNING_KEY       SALDO's key: encrypted PEM from SALDO's `saldo-license keygen`
 *   SALDO_SIGNING_KID       its kid, e.g. saldo-2026-1
 *   SALDO_SIGNING_PASSPHRASE its passphrase
 *   SALDO_DEV_SIGNING=1     sign SALDO files with the dev key instead (debug SALDO builds only)
 *   TRUST_PROXY             value for Express "trust proxy" (default 1: one proxy)
 *   INSECURE_COOKIE=1       allow the session cookie over plain HTTP (local dev)
 */

import { createApp } from './app.ts';
import { BOOTSTRAP_PASSWORD, BOOTSTRAP_USERNAME, ensureBootstrapAdmin } from './auth.ts';
import { openDb } from './db.ts';
import { LicenseService } from './service.ts';
import { loadSigners } from './signer.ts';
import { PRODUCT_CODES } from './products.ts';

const db = openDb(process.env.KDR_LICENSE_DB ?? 'data/license.db');
const { signers, problems } = loadSigners();
for (const code of PRODUCT_CODES) {
  const signer = signers[code];
  if (!signer) console.warn(`[license-server] ${code}: no signing key - ${code} files cannot be issued until one is configured`);
  else console.log(`[license-server] ${code}: signing with kid "${signer.kid}"`);
}
for (const problem of problems) console.warn(`[license-server] ${problem}`);

const service = new LicenseService(db, signers);

// A database with nobody in it gets the account a fresh installation starts
// with. It is announced loudly: until someone signs in with it and sets a
// password, these two words are all the panel asks for.
if (ensureBootstrapAdmin(db)) {
  console.warn(`[license-server] no administrator yet: sign in as "${BOOTSTRAP_USERNAME}" with the password `
    + `"${BOOTSTRAP_PASSWORD}" - the panel then asks for a new one at once, and nothing else works until it is set`);
}

const trustProxy = process.env.TRUST_PROXY ?? '1';
const app = createApp(service, {
  secureCookie: process.env.INSECURE_COOKIE !== '1',
  trustProxy: /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy === 'false' ? false : trustProxy
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
app.listen(port, host, () => {
  console.log(`[license-server] License Manager on http://${host}:${port}/admin/`);
});
