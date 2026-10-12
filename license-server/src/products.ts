/**
 * The applications this one licence server sells licences for.
 *
 * KADRA and SALDO share the licensing model (LICENSING.md here, and
 * LICENSING_SPEC.md in SALDO, with the same rule numbers) and the wire format;
 * what differs is only naming and the signing key. Everything that differs
 * lives here, so the rest of the server asks "which product is this licence
 * for" and never spells a prefix or an extension itself.
 *
 * A licence belongs to one product for life (`licenses.product`). Its key, its
 * id, the extension of the files it produces, the `product` field inside them
 * and the key that signs them all follow from that - which is what lets each
 * application go on checking files exactly as before.
 */

import { RuleError } from './core/rules.ts';

export type ProductCode = 'KADRA' | 'SALDO';

export interface Product {
  code: ProductCode;
  /** In front of licence keys (`KDR-XXXXX-…`) and licence ids (`KDR-2026-000001`). */
  prefix: string;
  /** File extensions without the dot: licence, clock unlock, request, deactivation proof. */
  ext: { license: string; clock: string; request: string; deactivate: string };
  /** Environment variables for the signing key: `<env>_SIGNING_KEY`, `_KID`, `_PASSPHRASE`, `_DEV_SIGNING`. */
  env: string;
  /**
   * Public signing keys the application's builds carry (src-tauri/license-keys*.json
   * in its repository). A configured private key whose kid is listed here must
   * match it - otherwise every file would be refused on the client's side.
   */
  publicKeys: Record<string, string>;
}

export const PRODUCTS: Record<ProductCode, Product> = {
  KADRA: {
    code: 'KADRA',
    prefix: 'KDR',
    ext: { license: 'kdrlic', clock: 'kdrclock', request: 'kdrreq', deactivate: 'kdrdeact' },
    env: 'KDR',
    publicKeys: {
      'kdr-2026-1': 'wzWfps3uuMr7OvKxfGi_5VtMAsBc1frzJPYcw1aSyrg',
      dev: '6KdFp_uwcYpY35GYLo1nwP5FVSCRsJXE3setxhdBG2E'
    }
  },
  SALDO: {
    code: 'SALDO',
    prefix: 'SALDO',
    ext: { license: 'saldolic', clock: 'saldoclock', request: 'saldoreq', deactivate: 'saldodeact' },
    env: 'SALDO',
    publicKeys: {
      'saldo-2026-1': 'XnK1bjPSs-y7FrPbTZ6EGSoCHdDWb90_VpXO4ZJh6V4',
      dev: 'ZVjDwabYZKsKcH6p-qPG9BmIgGlr19aoljpjTiKZbSk'
    }
  }
};

export const PRODUCT_CODES = Object.keys(PRODUCTS) as ProductCode[];

/** The licences that existed before SALDO moved in were all KADRA's. */
export const DEFAULT_PRODUCT: ProductCode = 'KADRA';

export function product(code: string | undefined | null): Product {
  const found = PRODUCTS[(code ?? DEFAULT_PRODUCT) as ProductCode];
  if (!found) throw new RuleError('VALIDATION', `Неизвестное приложение ${String(code)}: ${PRODUCT_CODES.join(' или ')}`);
  return found;
}

/** Which product a request file is for, by its extension; null when the name says nothing. */
export function productOfFilename(filename: string | undefined | null): ProductCode | null {
  const ext = String(filename ?? '').toLowerCase().split('.').pop() ?? '';
  for (const p of Object.values(PRODUCTS)) {
    if (ext === p.ext.request || ext === p.ext.deactivate) return p.code;
  }
  return null;
}
