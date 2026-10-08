#!/usr/bin/env node
/**
 * kdr-license: the licence server's operations from the console, on the
 * seller's own computer (LICENSING.md 10.3). Same code as the server
 * (license-server/src/service.ts) and the same database format, so moving to
 * the server later means copying one file.
 *
 *   keygen   --kid kdr-2026-1
 *   customer --name "ABC Ltd." [--email ..] [--phone ..] [--contact ..]
 *   license  --customer CUST-000001 --plan ANNUAL [--mode OFFLINE] [--seats 1] [--start 2026-10-01] [--max-version 1.99.99]
 *   issue    --request client.kdrreq [--approve-transfer] [--transfer-from ACT-..] [--override-limit] [--out dir]
 *   release  --proof old-pc.kdrdeact
 *   renew    --license-id KDR-2026-000001 [--paid-on 2027-09-20] [--periods 1]
 *            [--source cash|bank_transfer|card|other] [--amount 1200 --currency TMT] [--receipt №] [--out dir]
 *   revoke   --license-id KDR-2026-000001 --reason "..."
 *   reissue  --activation ACT-.. [--out dir]
 *   clock-reset --activation ACT-.. [--high-water-to 2026-10-01] [--out dir]
 *   inspect  file.kdrlic|.kdrclock|.kdrreq|.kdrdeact
 *   list
 *
 * Signing: --kid K [--key path] with the passphrase in KDR_LICENSE_PASSPHRASE
 * or asked for; or --dev for the development key, which only debug builds of
 * KADRA accept. Database: --db path, default ~/.kdr-license/license.db (with
 * --dev: tools/kdr-license/dev/license.db).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { openDb } from '../../license-server/src/db.ts';
import { LicenseService } from '../../license-server/src/service.ts';
import { openEnvelope, rawPublicKey } from '../../license-server/src/core/envelope.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const HOME = path.join(os.homedir(), '.kdr-license');
const DEV_KEY = path.join(HERE, 'dev', 'dev.key');
const KEYRING = path.join(REPO, 'src-tauri', 'license-keys.json');
const DEV_KEYRING = path.join(REPO, 'src-tauri', 'license-keys.dev.json');
const ACTOR = `cli:${os.userInfo().username}`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const next = rest[i + 1];
      options[arg.slice(2)] = next === undefined || next.startsWith('--') ? true : rest[++i];
    } else {
      options._.push(arg);
    }
  }
  return { command, options };
}

function need(options, name) {
  const value = options[name];
  if (value === undefined || value === true) throw new Error(`Нужен параметр --${name}`);
  return value;
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

async function passphrase() {
  if (process.env.KDR_LICENSE_PASSPHRASE) return process.env.KDR_LICENSE_PASSPHRASE;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Пароль ключа подписи: ');
  rl.close();
  return answer;
}

async function signer(options) {
  if (options.dev) return { kid: 'dev', key: crypto.createPrivateKey(fs.readFileSync(DEV_KEY)) };
  const kid = need(options, 'kid');
  const file = options.key ?? path.join(HOME, 'keys', `${kid}.key`);
  return { kid, key: crypto.createPrivateKey({ key: fs.readFileSync(file), passphrase: await passphrase() }) };
}

async function service(options, { signing = true } = {}) {
  const file = options.db ?? (options.dev ? path.join(HERE, 'dev', 'license.db') : path.join(HOME, 'license.db'));
  return new LicenseService(openDb(file), signing ? await signer(options) : null);
}

function save(file, options) {
  const dir = options.out ?? '.';
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file.filename);
  fs.writeFileSync(target, file.content);
  console.log(`${file.kind}: ${target} (ревизия ${file.revision})`);
}

const commands = {
  async keygen(options) {
    const kid = need(options, 'kid');
    const dir = options.out ?? path.join(HOME, 'keys');
    const file = path.join(dir, `${kid}.key`);
    if (fs.existsSync(file)) throw new Error(`${file} уже существует`);
    const secret = await passphrase();
    if (secret.length < 12) throw new Error('Пароль ключа — не короче 12 символов');

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: secret }),
      { mode: 0o600 });
    const keyring = fs.existsSync(KEYRING) ? readJson(KEYRING) : {};
    keyring[kid] = rawPublicKey(publicKey);
    fs.writeFileSync(KEYRING, JSON.stringify(keyring, null, 2) + '\n');

    console.log(`Публичный ключ добавлен в ${path.relative(REPO, KEYRING)}`);
    console.log(`Закрытый ключ: ${file}`);
    console.log('Сделайте две резервные копии на отдельных носителях: без этого ключа');
    console.log('нельзя выпускать файлы для уже проданных копий (ТЗ 3.3).');
  },

  async customer(options) {
    const s = await service(options, { signing: false });
    const customer = s.createCustomer({
      name: need(options, 'name'), contact: options.contact, email: options.email, phone: options.phone
    }, ACTOR);
    console.log(`Клиент ${customer.id}: ${customer.name}`);
  },

  async license(options) {
    const s = await service(options, { signing: false });
    const { license, license_key } = s.createLicense({
      customer_id: need(options, 'customer'),
      plan: need(options, 'plan'),
      activation_mode: options.mode ?? 'OFFLINE',
      seats: Number(options.seats ?? 1),
      edition: options.edition,
      features: options.features ? String(options.features).split(',') : [],
      max_version: options['max-version'] ?? '1.99.99',
      start: options.start ? new Date(options.start).toISOString() : undefined
    }, ACTOR);
    console.log(`Лицензия ${license.id}, оплачено до ${license.paid_until ?? 'бессрочно'}`);
    console.log(`Ключ лицензии (показывается один раз): ${license_key}`);
  },

  async issue(options) {
    const s = await service(options);
    const request = readJson(options.request ?? options.proof ?? need(options, 'request'));
    const processOptions = {
      actor: ACTOR,
      approveTransfer: Boolean(options['approve-transfer']),
      transferFrom: options['transfer-from'],
      overrideTransferLimit: Boolean(options['override-limit'])
    };
    const decision = s.inspectRequest(request, processOptions);
    console.log(`${decision.request.type} от ${decision.request.device_name}: ${decision.action ?? '—'}`);
    if (decision.blocked) {
      if (decision.transfer_candidates.length) {
        console.log('Действующие активации (для --transfer-from):');
        for (const a of decision.transfer_candidates) console.log(`  ${a.id}  ${a.device_name}  последняя связь ${a.last_seen}`);
      }
      throw new Error(decision.blocked.message);
    }
    if (decision.needs_approval) throw new Error('Это перенос на другой компьютер: повторите с --approve-transfer');
    const { file } = s.processRequest(request, processOptions);
    if (file) save(file, options);
    else console.log('Место освобождено.');
  },

  async release(options) {
    return commands.issue({ ...options, request: need(options, 'proof') });
  },

  async renew(options) {
    const s = await service(options);
    const { license, files } = s.renewLicense(need(options, 'license-id'), {
      periods: Number(options.periods ?? 1),
      paid_on: options['paid-on'] ? new Date(options['paid-on']).toISOString() : undefined,
      amount: options.amount ? Number(options.amount) : null,
      currency: options.currency ?? null,
      source: options.source ?? 'other',
      external_id: options.receipt ?? null
    }, ACTOR);
    console.log(`Оплачено до ${license.paid_until}`);
    for (const file of files) save(file, options);
  },

  async revoke(options) {
    const s = await service(options, { signing: false });
    const license = s.revokeLicense(need(options, 'license-id'), String(options.reason ?? ''), ACTOR);
    console.log(`Лицензия ${license.id} отозвана. Онлайн-клиенты узнают об этом при ближайшем обновлении;`);
    console.log('офлайн-файлы работают до окончания оплаченного срока (ТЗ 7.3).');
  },

  async reissue(options) {
    const s = await service(options);
    save(s.issueLicenseFile(need(options, 'activation'), ACTOR), options);
  },

  async 'clock-reset'(options) {
    const s = await service(options);
    const target = options['high-water-to'] ? new Date(options['high-water-to']).toISOString() : null;
    save(s.issueClockReset(need(options, 'activation'), target, ACTOR), options);
  },

  async inspect(options) {
    const content = readJson(options._[0] ?? need(options, 'file'));
    if ('device_sig' in content) {
      const { verifyRequest } = await import('../../license-server/src/core/envelope.ts');
      try {
        console.log('Подпись устройства: верна');
        console.log(JSON.stringify(verifyRequest(content), null, 2));
      } catch (error) {
        console.log(`Подпись устройства: НЕВЕРНА (${error.message})`);
      }
      return;
    }
    const keys = {};
    for (const file of [KEYRING, DEV_KEYRING]) if (fs.existsSync(file)) Object.assign(keys, readJson(file));
    const { payload, verified } = openEnvelope(content, keys);
    console.log(`Ключ: ${content.kid}; подпись: ${verified === null ? 'ключ неизвестен' : verified ? 'верна' : 'НЕВЕРНА'}`);
    console.log(JSON.stringify(payload, null, 2));
  },

  async list(options) {
    const s = await service(options, { signing: false });
    console.table(s.listLicenses().map(l => ({
      id: l.id, клиент: l.customer_name, тариф: l.plan, режим: l.activation_mode,
      места: `${l.seats_used}/${l.seats}`, оплачено_до: l.paid_until ?? 'бессрочно', статус: l.status
    })));
  }
};

const { command, options } = parseArgs(process.argv.slice(2));
const run = commands[command];
if (!run) {
  console.log('Команды: keygen, customer, license, issue, release, renew, revoke, reissue, clock-reset, inspect, list.');
  console.log('Подробности — в начале tools/kdr-license/cli.js.');
  process.exit(command ? 1 : 0);
}
try {
  await run(options);
} catch (error) {
  console.error(`Ошибка: ${error.message}`);
  process.exit(1);
}
