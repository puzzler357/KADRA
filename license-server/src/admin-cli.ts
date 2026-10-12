/**
 * Administrator accounts for the License Manager.
 *
 *   npm run admin -- add <name>          create, or reset: a new password, second factor off
 *   npm run admin -- add <name> --totp   the same with a second factor; prints its secret once
 *   npm run admin -- list
 *   npm run admin -- webhook <source>    a payment webhook sender; prints its secret once
 *
 * The password is read from ADMIN_PASSWORD or asked for. `add` on an existing
 * name is the way back in when the password or the authenticator app is gone.
 *
 * Adding a real administrator also retires the `admin` account a fresh
 * installation starts with, as long as it still has its default password.
 */

import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { addAdmin } from './auth.ts';
import { openDb } from './db.ts';
import { createWebhookSource } from './payments.ts';
import { LicenseService } from './service.ts';

const args = process.argv.slice(2);
const totp = args.includes('--totp');
const [command, username] = args.filter(arg => !arg.startsWith('--'));
const db = openDb(process.env.KDR_LICENSE_DB ?? 'data/license.db');

/**
 * Reads a password without echoing it: the prompt is written to the terminal,
 * but readline's own output goes nowhere. A password left on screen is a
 * password in the next screenshot or over the admin's shoulder.
 */
async function askSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = readline.createInterface({ input: process.stdin, output: silent, terminal: true });
  try {
    return await rl.question('');
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

try {
  if (command === 'add' && username) {
    const password = process.env.ADMIN_PASSWORD ?? await askSecret('Пароль (не короче 12 символов, ввод не отображается): ');
    const factor = addAdmin(db, username, password, { totp });
    console.log(`Администратор ${username} сохранён.`);
    if (factor) {
      console.log('Второй фактор: добавьте в приложение-аутентификатор (Google Authenticator, Aegis и т. п.)');
      console.log(`  секрет: ${factor.secret}`);
      console.log(`  или ссылку: ${factor.uri}`);
      console.log('Секрет больше не будет показан.');
    } else {
      console.log('Вход — по имени и паролю. Второй фактор включается в панели: «Учётная запись».');
    }
  } else if (command === 'webhook' && username) {
    const { name, secret } = createWebhookSource(new LicenseService(db, null), username, 'cli');
    console.log(`Источник webhook «${name}» создан. URL: https://<сервер>/v1/payments/${name}`);
    console.log(`Секрет подписи (больше не будет показан): ${secret}`);
  } else if (command === 'list') {
    // Who still has the password a fresh installation hands out, and who
    // signs in on a password alone - both worth seeing at a glance.
    console.table(db.prepare(`SELECT username, created_at, must_change_password,
      totp_secret <> '' AS second_factor FROM admins`).all());
  } else {
    console.log('Команды: add <имя> [--totp], list, webhook <источник>');
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`Ошибка: ${(error as Error).message}`);
  process.exitCode = 1;
}
