/**
 * The seller-side rules through the service. Test numbers are those of
 * LICENSING.md 13.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { openEnvelope } from '../src/core/envelope.ts';
import {
  DEFAULT_PLANS, addDays, addMonths, assertLeaseInvariant, fileTerms, iso, renewalStart,
  type ActivationMode
} from '../src/core/rules.ts';
import { generateLicenseKey, normalizeLicenseKey } from '../src/core/licenseKey.ts';
import { Device, customerWithLicense, decode, setup } from './helpers.ts';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('licence keys', () => {
  test('a generated key survives the ways people retype it', () => {
    for (let i = 0; i < 200; i++) {
      const key = generateLicenseKey();
      assert.match(key, /^KDR-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
      assert.equal(normalizeLicenseKey(key), key);
      assert.equal(normalizeLicenseKey(key.toLowerCase().replace(/-/g, ' ')), key);
      assert.equal(normalizeLicenseKey(key.slice(4)), key, 'without the prefix');
    }
  });

  test('a single mistyped character is caught by the check symbol', () => {
    const key = generateLicenseKey();
    const chars = [...key];
    const i = 6;
    chars[i] = chars[i] === 'A' ? 'B' : 'A';
    assert.equal(normalizeLicenseKey(chars.join('')), null);
  });
});

describe('test 15: lease_until never exceeds paid_until + grace_days', () => {
  test('for every plan, mode and moment, including after expiry', () => {
    const paidUntil = new Date('2027-01-31T23:59:59Z');
    for (const plan of DEFAULT_PLANS) {
      for (const mode of plan.allowed_modes as ActivationMode[]) {
        for (let offset = -400; offset <= 400; offset += 3) {
          const now = addDays(paidUntil, offset);
          const terms = fileTerms(plan, mode, plan.term_months === null ? null : paidUntil, plan.grace_days, now);
          assert.doesNotThrow(() => assertLeaseInvariant({ ...terms, grace_days: plan.grace_days }));
          if (terms.lease_until && terms.paid_until) {
            assert.ok(new Date(terms.lease_until) <= addDays(new Date(terms.paid_until), plan.grace_days));
          }
        }
      }
    }
  });

  test('an ONLINE file gets 30 days, but not past paid + grace', () => {
    const { service, clock } = setup('2026-09-27T16:00:00Z');
    const { key } = customerWithLicense(service, 'MONTHLY', 'ONLINE');
    const device = new Device();
    const first = decode(service.processRequest(device.request('ACTIVATE', { license_key: key }), { actor: 't' }).file!.content);
    assert.equal(first.paid_until, '2026-10-27T23:59:59Z');
    assert.equal(first.lease_until, '2026-10-27T16:00:00Z');
    assert.equal(first.refresh_after, '2026-10-04T16:00:00Z');

    clock.set('2026-10-25T00:00:00Z');
    const later = decode(service.processRequest(device.request('ACTIVATE', { license_key: key }), { actor: 't' }).file!.content);
    assert.equal(later.lease_until, '2026-11-03T23:59:59Z', 'clamped to paid_until + 7');
  });

  test('an OFFLINE file carries the whole paid period', () => {
    const { service } = setup('2026-09-27T16:00:00Z');
    const { key } = customerWithLicense(service, 'ANNUAL', 'OFFLINE');
    const file = decode(service.processRequest(new Device().request('ACTIVATE', { license_key: key }), { actor: 't' }).file!.content);
    assert.equal(file.paid_until, '2027-09-27T23:59:59Z');
    assert.equal(file.lease_until, '2027-10-04T23:59:59Z');
    assert.equal(file.refresh_after, null);
  });

  test('a perpetual file has neither date', () => {
    const { service } = setup();
    const { key } = customerWithLicense(service, 'PERPETUAL', 'OFFLINE');
    const file = decode(service.processRequest(new Device().request('ACTIVATE', { license_key: key }), { actor: 't' }).file!.content);
    assert.equal(file.paid_until, null);
    assert.equal(file.lease_until, null);
  });
});

describe('test 16: renewal rule 5.4', () => {
  test('31.01 + 1 month = 28.02 (29.02 in a leap year)', () => {
    assert.equal(iso(addMonths(new Date('2027-01-31T00:00:00Z'), 1)), '2027-02-28T00:00:00Z');
    assert.equal(iso(addMonths(new Date('2028-01-31T00:00:00Z'), 1)), '2028-02-29T00:00:00Z');
  });

  test('paid before the end of grace: counted from the old paid_until', () => {
    const paid = new Date('2027-09-27T23:59:59Z');
    assert.equal(renewalStart(paid, 7, new Date('2027-09-20T00:00:00Z')), paid);
    assert.equal(renewalStart(paid, 7, new Date('2027-10-03T00:00:00Z')), paid);
  });

  test('paid after grace: counted from the payment date', () => {
    const late = new Date('2027-10-20T10:00:00Z');
    assert.equal(renewalStart(new Date('2027-09-27T23:59:59Z'), 7, late), late);
  });

  test('through the service, with the month clamped', () => {
    const { service } = setup('2026-12-31T10:00:00Z');
    const { license } = customerWithLicense(service, 'MONTHLY', 'ONLINE');
    assert.equal(license.paid_until, '2027-01-31T23:59:59Z');

    const early = service.renewLicense(license.id, { paid_on: '2027-01-25T00:00:00Z' }, 't').license;
    assert.equal(early.paid_until, '2027-02-28T23:59:59Z');

    const late = service.renewLicense(license.id, { paid_on: '2027-04-10T12:00:00Z' }, 't').license;
    assert.equal(late.paid_until, '2027-05-10T23:59:59Z');

    const payments = service.licenseDetails(license.id).payments as { period_to: string }[];
    assert.equal(payments.length, 2);
  });

  test('an OFFLINE renewal comes with a new file for every active device (5.3)', () => {
    const { service, keys } = setup('2026-09-27T16:00:00Z');
    const { license, key } = customerWithLicense(service, 'ANNUAL', 'OFFLINE', 2);
    service.processRequest(new Device().request('ACTIVATE', { license_key: key }), { actor: 't' });
    service.processRequest(new Device().request('ACTIVATE', { license_key: key }), { actor: 't' });

    const { files } = service.renewLicense(license.id, { paid_on: '2027-09-01T00:00:00Z' }, 't');
    assert.equal(files.length, 2);
    for (const file of files) {
      const opened = openEnvelope(JSON.parse(file.content), keys);
      assert.equal(opened.verified, true);
      assert.equal(opened.payload.paid_until, '2028-09-27T23:59:59Z');
      assert.equal(opened.payload.revision, 2);
    }
  });

  test('a cash payment is recorded with its source and receipt, an unknown source is refused', () => {
    const { service } = setup('2026-09-27T16:00:00Z');
    const { license } = customerWithLicense(service, 'ANNUAL', 'OFFLINE');
    service.renewLicense(license.id,
      { paid_on: '2027-09-20T00:00:00Z', source: 'cash', amount: 1200, currency: 'TMT', external_id: 'ПКО-17' }, 't');
    const [payment] = service.licenseDetails(license.id).payments as any[];
    assert.equal(payment.source, 'cash');
    assert.equal(payment.amount, 1200);
    assert.equal(payment.external_id, 'ПКО-17');
    assert.equal(payment.period_to, '2028-09-27T23:59:59Z');

    assert.equal(code(() => service.renewLicense(license.id, { source: 'webhook:bank' }, 't')), 'VALIDATION');
    assert.equal(code(() => service.renewLicense(license.id, { source: 'cash', amount: -5 }, 't')), 'VALIDATION');
    assert.equal((service.licenseDetails(license.id).payments as any[]).length, 1, 'a refused renewal records nothing');
  });

  test('a perpetual licence is not renewed', () => {
    const { service } = setup();
    const { license } = customerWithLicense(service, 'PERPETUAL', 'OFFLINE');
    assert.equal(code(() => service.renewLicense(license.id, {}, 't')), 'PERPETUAL_NOT_RENEWABLE');
  });
});

describe('test 17: seats', () => {
  test('the fourth activation with seats = 3 is MACHINE_LIMIT_REACHED', () => {
    const { service } = setup();
    const { key, license } = customerWithLicense(service, 'ANNUAL', 'OFFLINE', 3);
    for (let i = 0; i < 3; i++) {
      assert.ok(service.processRequest(new Device().request('ACTIVATE', { license_key: key }), { actor: 't' }).file);
    }
    assert.equal(code(() => service.processRequest(new Device().request('ACTIVATE', { license_key: key }), { actor: 't' })),
      'MACHINE_LIMIT_REACHED');
    const refused = service.listEvents({ license_id: license.id }).find((e: any) => e.action === 'REQUEST_REFUSED');
    assert.ok(refused, 'the refusal is journalled');
  });

  test('the same device asking again does not take a second seat', () => {
    const { service } = setup();
    const { key, license } = customerWithLicense(service, 'ANNUAL', 'OFFLINE', 1);
    const device = new Device();
    service.processRequest(device.request('ACTIVATE', { license_key: key }), { actor: 't' });
    const again = service.processRequest(device.request('ACTIVATE', { license_key: key }), { actor: 't' });
    assert.equal(again.decision.action, 'REISSUE_SAME_DEVICE');
    assert.equal(decode(again.file!.content).revision, 2);
    assert.equal((service.licenseDetails(license.id).activations as unknown[]).length, 1);
  });

  test('a wiped computer activating by key again keeps its seat', () => {
    const { service } = setup();
    const { key } = customerWithLicense(service, 'ANNUAL', 'OFFLINE', 1);
    const device = new Device();
    service.processRequest(device.request('ACTIVATE', { license_key: key }), { actor: 't' });
    device.reinstall();
    const again = service.processRequest(device.request('ACTIVATE', { license_key: key }), { actor: 't' });
    assert.equal(again.decision.action, 'REBIND');
  });

  test('a wrong key is refused and journalled as a warning', () => {
    const { service } = setup();
    customerWithLicense(service);
    assert.equal(code(() => service.processRequest(new Device().request('ACTIVATE', { license_key: generateLicenseKey() }), { actor: 't' })),
      'INVALID_KEY');
    assert.ok(service.listEvents({ severity: 'warning' }).length >= 1);
  });
});

describe('test 20: MONTHLY + OFFLINE', () => {
  test('cannot be created', () => {
    const { service } = setup();
    const customer = service.createCustomer({ name: 'X' }, 't');
    assert.equal(code(() => service.createLicense({ customer_id: customer.id, plan: 'MONTHLY', activation_mode: 'OFFLINE' }, 't')),
      'MODE_NOT_ALLOWED');
    assert.equal(service.listLicenses().length, 0);
  });
});

describe('rebind and transfer (7.1, 7.2)', () => {
  const activated = () => {
    const env = setup();
    const { key, license } = customerWithLicense(env.service, 'ANNUAL', 'OFFLINE', 1);
    const device = new Device();
    const result = env.service.processRequest(device.request('ACTIVATE', { license_key: key }), { actor: 't' });
    const ids = { license_id: license.id, activation_id: result.file!.activation_id };
    return { ...env, device, ids, license };
  };

  test('test 5, server side: a reinstall is a rebind, not a transfer', () => {
    const { service, device, ids, license } = activated();
    device.reinstall();
    const result = service.processRequest(device.request('REBIND', ids), { actor: 't' });
    assert.equal(result.decision.action, 'REBIND');
    assert.equal(result.file!.activation_id, ids.activation_id);
    assert.equal(decode(result.file!.content).revision, 2);
    assert.equal(service.licenseDetails(license.id).transfers_last_year, 0);
  });

  test('another computer is a transfer and needs approval, within the yearly limit', () => {
    const { service, ids, license } = activated();
    const other = new Device();
    assert.equal(code(() => service.processRequest(other.request('REBIND', ids), { actor: 't' })), 'APPROVAL_REQUIRED');

    const moved = service.processRequest(other.request('REBIND', ids), { actor: 't', approveTransfer: true });
    assert.equal(moved.decision.action, 'TRANSFER');
    assert.notEqual(moved.file!.activation_id, ids.activation_id);
    assert.equal(service.activation(ids.activation_id).status, 'RELEASED');

    // Second transfer, then the limit (2 per year).
    const next = { license_id: license.id, activation_id: moved.file!.activation_id };
    const third = new Device();
    const moved2 = service.processRequest(third.request('REBIND', next), { actor: 't', approveTransfer: true });
    const last = { license_id: license.id, activation_id: moved2.file!.activation_id };
    assert.equal(code(() => service.processRequest(new Device().request('REBIND', last), { actor: 't', approveTransfer: true })),
      'TRANSFER_LIMIT');
    assert.ok(service.processRequest(new Device().request('REBIND', last),
      { actor: 't', approveTransfer: true, overrideTransferLimit: true }).file);
  });

  test('full seats: a new computer can replace a chosen one, with approval', () => {
    const { service } = setup();
    const { key } = customerWithLicense(service, 'ANNUAL', 'OFFLINE', 1);
    const old = service.processRequest(new Device().request('ACTIVATE', { license_key: key }), { actor: 't' }).file!;
    const replacement = new Device();

    const blocked = service.inspectRequest(replacement.request('ACTIVATE', { license_key: key }));
    assert.equal(blocked.blocked?.code, 'MACHINE_LIMIT_REACHED');
    assert.deepEqual(blocked.transfer_candidates.map(a => a.id), [old.activation_id]);

    const request = replacement.request('ACTIVATE', { license_key: key });
    assert.equal(code(() => service.processRequest(request, { actor: 't', transferFrom: old.activation_id })), 'APPROVAL_REQUIRED');
    const moved = service.processRequest(replacement.request('ACTIVATE', { license_key: key }),
      { actor: 't', transferFrom: old.activation_id, approveTransfer: true });
    assert.equal(moved.decision.action, 'TRANSFER');
    assert.equal(service.activation(old.activation_id).status, 'RELEASED');
  });

  test('offline deactivation proof frees the seat; a proof by another key is refused', () => {
    const { service, device, ids, license } = activated();
    assert.equal(code(() => service.processRequest(new Device().request('DEACTIVATE', ids), { actor: 't' })), 'PROOF_KEY_MISMATCH');

    const result = service.processRequest(device.request('DEACTIVATE', { ...ids, current_revision: 1 }), { actor: 't' });
    assert.equal(result.decision.action, 'DEACTIVATE');
    assert.equal(result.file, null);
    assert.equal(service.activation(ids.activation_id).status, 'RELEASED');
    assert.equal((service.listLicenses() as any[]).find(l => l.id === license.id).seats_used, 0);
  });
});

describe('revocation, clock reset, forgery', () => {
  test('a revoked licence issues nothing', () => {
    const { service } = setup();
    const { key, license } = customerWithLicense(service);
    const device = new Device();
    const { file } = service.processRequest(device.request('ACTIVATE', { license_key: key }), { actor: 't' });
    service.revokeLicense(license.id, 'не оплачено', 't');
    assert.equal(code(() => service.issueLicenseFile(file!.activation_id, 't')), 'LICENSE_REVOKED');
    assert.equal(code(() => service.processRequest(new Device().request('ACTIVATE', { license_key: key }), { actor: 't' })),
      'LICENSE_REVOKED');
  });

  test('a clock reset takes the next revision', () => {
    const { service, keys } = setup();
    const { key } = customerWithLicense(service);
    const { file } = service.processRequest(new Device().request('ACTIVATE', { license_key: key }), { actor: 't' });
    const reset = service.issueClockReset(file!.activation_id, '2026-09-27T00:00:00Z', 't');
    const opened = openEnvelope(JSON.parse(reset.content), keys);
    assert.equal(opened.verified, true);
    assert.equal(opened.payload.kind, 'CLOCK_RESET');
    assert.equal(opened.payload.revision, 2);
    assert.equal(opened.payload.high_water_to, '2026-09-27T00:00:00Z');
    assert.equal(reset.filename.endsWith('.kdrclock'), true);
  });

  test('a request with a forged signature is refused and journalled', () => {
    const { service } = setup();
    const { key } = customerWithLicense(service);
    const request = new Device().request('ACTIVATE', { license_key: key });
    request.device_sig = new Device().request('ACTIVATE').device_sig;
    assert.equal(code(() => service.processRequest(request, { actor: 't' })), 'BAD_SIGNATURE');
    assert.equal(service.suspicious().signature_failures_90d, 1);
  });

  test('inspect changes nothing', () => {
    const { service } = setup();
    const { key, license } = customerWithLicense(service);
    const decision = service.inspectRequest(new Device().request('ACTIVATE', { license_key: key }));
    assert.equal(decision.action, 'ACTIVATE_NEW');
    assert.deepEqual(decision.seats, { used: 0, total: 1 });
    assert.equal((service.licenseDetails(license.id).activations as unknown[]).length, 0);
  });
});
