/**
 * Entry point. Configuration comes from the environment:
 *
 *   HRD_LICENSE_DB          database file            (default ./data/license.db)
 *   PORT / HOST             where to listen          (default 8787 on 127.0.0.1 -
 *                           put nginx or Caddy with HTTPS in front)
 *   HRD_SIGNING_KEY         encrypted PEM from `hrd-license keygen`
 *   HRD_SIGNING_KID         its kid, e.g. hrd-2026-1
 *   HRD_SIGNING_PASSPHRASE  its passphrase
 *   HRD_DEV_SIGNING=1       sign with the dev key instead (debug HRDesk builds only)
 *   TRUST_PROXY             value for Express "trust proxy" (default 1: one proxy)
 *   INSECURE_COOKIE=1       allow the session cookie over plain HTTP (local dev)
 */

import { createApp } from './app.ts';
import { openDb } from './db.ts';
import { LicenseService } from './service.ts';
import { loadSigner } from './signer.ts';

const db = openDb(process.env.HRD_LICENSE_DB ?? 'data/license.db');
const signer = loadSigner();
if (!signer) console.warn('[license-server] no signing key: files cannot be issued until one is configured');
else console.log(`[license-server] signing with kid "${signer.kid}"`);

const service = new LicenseService(db, signer);
const admins = Number((db.prepare('SELECT count(*) AS n FROM admins').get() as { n: number }).n);
if (!admins) console.warn('[license-server] no administrator yet: run `npm run admin -- add <name>`');

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
