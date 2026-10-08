/**
 * Administrator accounts for the License Manager.
 *
 *   npm run admin -- add <name>     create, or reset password and second factor
 *   npm run admin -- list
 *   npm run admin -- webhook <source>   a payment webhook sender; prints its secret once
 *
 * The password is read from ADMIN_PASSWORD or asked for. The second-factor
 * secret is printed once: add it to an authenticator app.
 */

import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { addAdmin } from './auth.ts';
import { openDb } from './db.ts';
import { createWebhookSource } from './payments.ts';
import { LicenseService } from './service.ts';

const [command, username] = process.argv.slice(2);
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
    const { secret, uri } = addAdmin(db, username, password);
    console.log(`Администратор ${username} сохранён.`);
    console.log('Второй фактор: добавьте в приложение-аутентификатор (Google Authenticator, Aegis и т. п.)');
    console.log(`  секрет: ${secret}`);
    console.log(`  или ссылку: ${uri}`);
    console.log('Секрет больше не будет показан.');
  } else if (command === 'webhook' && username) {
    const { name, secret } = createWebhookSource(new LicenseService(db, null), username, 'cli');
    console.log(`Источник webhook «${name}» создан. URL: https://<сервер>/v1/payments/${name}`);
    console.log(`Секрет подписи (больше не будет показан): ${secret}`);
  } else if (command === 'list') {
    console.table(db.prepare('SELECT username, created_at FROM admins').all());
  } else {
    console.log('Команды: add <имя>, list, webhook <источник>');
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`Ошибка: ${(error as Error).message}`);
  process.exitCode = 1;
}
