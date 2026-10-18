import './src/env';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import { randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createServer as createViteServer } from 'vite';
import db, { RESETTABLE_TABLES } from './src/db/sqlite';
import { ENTITIES, ENTITY_BY_TABLE, AUDIT_TABLE, BACKUP_TABLES, insertSql, selectSql, updateSql, rowToObject, objectToValues } from './src/data/entities';
import { employeePatchFor, employeeUpdate, movementError, movementRecord } from './src/data/movements';
import { demoCleanupStatements } from './src/data/demo';
import { employeeErrors, departmentNameError, parentError, positionErrors, hasErrors, templateError } from './src/lib/validation';

export const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Адрес, на котором слушает сервер. По умолчанию — только этот компьютер:
// кадровые данные не должны быть видны всей локальной сети. Открыть сервер
// в сеть можно явно, HOST=0.0.0.0, — и тогда это осознанное решение.
const HOST = process.env.HOST || '127.0.0.1';

// Секрет подписи JWT. Встроенного значения больше нет: оно лежало бы в
// открытом коде и позволяло бы подделать токен. Без JWT_SECRET секрет
// случайный на каждый запуск — токены сервер сам не проверяет, клиент лишь
// хранит их, так что смена секрета при перезапуске ничего не ломает.
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');

/** Идентификатор новой записи: 122 случайных бита, без шанса совпадения. */
const makeId = () => randomUUID();

// ---- Защита API от чужих сайтов и от сети ----
//
// Сервер отвечает браузеру владельца, и только ему. Опасность — не только
// другие компьютеры сети (их отсекает HOST), но и любая открытая в том же
// браузере вкладка: страница с чужого сайта может отправить запрос на
// http://localhost:3000. Раньше cors() разрешал ей ещё и читать ответы,
// а простой POST формой (его браузер шлёт без предварительной проверки)
// доходил до сброса данных и без этого.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const hostnameOf = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
};

const isLoopback = (hostname: string | null): boolean =>
  hostname !== null && (LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost'));

/** Сервер открыт только этому компьютеру — тогда и Host обязан быть локальным. */
const servesLoopbackOnly = (): boolean => isLoopback(hostnameOf(HOST));

export function guardRequest(req: Request, res: Response, next: NextFunction) {
  // Host: защита от DNS rebinding — чужой домен, который «переехал» на
  // 127.0.0.1, приходит с собственным именем в Host.
  if (servesLoopbackOnly() && !isLoopback(hostnameOf(req.headers.host))) {
    return res.status(403).json({ error: 'Доступ разрешён только с этого компьютера' });
  }

  if (!req.path.startsWith('/api/')) return next();

  // Браузер сам помечает запросы со сторонних сайтов. Подделать эти
  // заголовки страница не может.
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({ error: 'Запрос с другого сайта отклонён' });
  }

  // Origin браузер ставит на любой запрос, изменяющий данные, если тот
  // пришёл не со страницы самого приложения. Разрешаем только свой адрес
  // (а при работе на этом компьютере — любой локальный порт, это тоже мы).
  const origin = req.headers.origin;
  // Origin «null» (локальный файл, песочница iframe) сюда тоже попадает и
  // отклоняется: своего адреса у такой страницы нет.
  if (origin !== undefined) {
    let originHost: string | null = null;
    try { originHost = new URL(origin).host; } catch { /* «null» и мусор */ }
    const sameOrigin = originHost !== null && originHost === req.headers.host;
    const bothLocal = originHost !== null
      && isLoopback(hostnameOf(origin)) && isLoopback(hostnameOf(req.headers.host));
    if (!sameOrigin && !bothLocal) {
      return res.status(403).json({ error: 'Запрос с другого сайта отклонён' });
    }
  }

  next();
}

app.use(guardRequest);

// Лимит тела запроса. По умолчанию express принимает 100 КБ — это меньше,
// чем импорт 2 000 сотрудников, а на целевом объёме (10 000 сотрудников и год
// табеля) резервная копия весит около 60 МБ и не восстановилась бы вовсе.
// Сервер доступен только с этого компьютера, поэтому большой лимит безопасен.
app.use(express.json({ limit: '200mb' }));

// Журнал аудита пишется здесь, а не на экранах: событие должно попадать в
// журнал вместе с самим изменением, а не тогда, когда клиент про это вспомнит.
const insertAudit = () => db.prepare(
  'INSERT INTO audit_log (id, ts, action, entity, entity_id, diff) VALUES (?, ?, ?, ?, ?, ?)',
);

function audit(action: string, entity: string, entityId?: string | null, diff?: string | null) {
  insertAudit().run(
    makeId(),
    new Date().toISOString(),
    action, entity, entityId ?? null, diff ?? null,
  );
}

// ---- Учётная запись владельца ----
//
// Учётная запись одна, и её может не быть вовсе: приложение открывается и без
// неё. Пустой password_hash — пароль не задан. require_password — владелец сам
// включил запрос пароля при входе; хранится в базе, а не в браузере, поэтому
// очистка данных браузера его не выключает.

interface OwnerRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  name: string;
  require_password: number;
}

const getOwner = (): OwnerRow | undefined =>
  db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get() as OwnerRow | undefined;

/** Пароль при входе действует: он задан и владелец включил запрос. */
const passwordRequired = (owner: OwnerRow | undefined): boolean =>
  Boolean(owner?.password_hash) && Boolean(owner?.require_password);

const publicUser = (u: OwnerRow) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const signToken = (u: { id: string; role: string }) => jwt.sign({ id: u.id, role: u.role }, JWT_SECRET, { expiresIn: '7d' });

/** Ответ-ошибка с кодом: текст на нужном языке подставляет клиент. */
function fail(res: Response, status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ error, code, ...extra });
}

/**
 * Логин подходит, если он пуст (владелец один, спрашивать его незачем) или
 * совпадает с email либо именем владельца. Раньше вход шёл только по email,
 * и учётная запись, заведённая с одним именем, запиралась насовсем.
 */
function loginMatches(owner: OwnerRow, login: unknown): boolean {
  const value = String(login ?? '').trim().toLocaleLowerCase('ru');
  if (!value) return true;
  return value === String(owner.email ?? '').trim().toLocaleLowerCase('ru')
    || value === String(owner.name ?? '').trim().toLocaleLowerCase('ru');
}

/** Пароль администратора для опасных операций — только если он задан. */
function adminPasswordOk(adminPassword: unknown): boolean {
  const owner = getOwner();
  return !owner?.password_hash || bcrypt.compareSync(String(adminPassword ?? ''), owner.password_hash);
}

// Когда пароль при входе включён, данные отдаются только по токену сессии.
// Без этого запрос пароля был бы лишь экраном поверх открытого API.
const OPEN_ROUTES = new Set(['GET /api/auth/status', 'POST /api/auth/login']);

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || OPEN_ROUTES.has(`${req.method} ${req.path}`)) return next();
  if (!passwordRequired(getOwner())) return next();
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return fail(res, 401, 'auth.sessionRequired', 'Требуется вход по паролю');
  }
});

app.get('/api/auth/status', (_req, res) => {
  const owner = getOwner();
  res.json({
    hasOwner: Boolean(owner),
    hasPassword: Boolean(owner?.password_hash),
    requirePassword: passwordRequired(owner),
    ownerName: owner?.name ?? null,
  });
});

// Владелец без ввода пароля — когда запрос пароля выключен. Когда включён,
// сюда без токена не пустит проверка сессии выше.
app.get('/api/auth/owner', (_req, res) => {
  const owner = getOwner();
  if (!owner) return res.json({ user: null });
  res.json({ user: publicUser(owner), token: signToken(owner) });
});

// Завести или поправить учётную запись. Строка в таблице всегда одна, и
// «создать» от «переименовать» отличается только тем, была ли она до этого.
app.post('/api/auth/owner', (req, res) => {
  const { name, email } = req.body ?? {};
  const cleanName = String(name ?? '').trim();
  const cleanEmail = String(email ?? '').trim();

  if (!cleanName && !cleanEmail) {
    return fail(res, 400, 'auth.ownerRequired', 'Нужно имя или email');
  }

  const existing = getOwner();
  const id = existing?.id ?? '1';
  const displayName = cleanName || cleanEmail;

  if (existing) {
    db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(displayName, cleanEmail, id);
    audit('owner_update', 'auth', id, cleanEmail || displayName);
  } else {
    // Пустой password_hash — пароль не задан.
    db.prepare('INSERT INTO users (id, email, password_hash, role, name) VALUES (?, ?, ?, ?, ?)')
      .run(id, cleanEmail, '', 'ADMIN', displayName);
    audit('owner_create', 'auth', id, cleanEmail || displayName);
  }

  res.json({ user: { id, email: cleanEmail, name: displayName, role: 'ADMIN' }, token: signToken({ id, role: 'ADMIN' }) });
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body ?? {};
  const login = req.body?.login ?? req.body?.email;
  const owner = getOwner();

  // Пустой хэш — пароль не задан: входить по паролю не через что, и ни одна
  // строка к нему не подойдёт.
  if (!owner || !owner.password_hash || !loginMatches(owner, login)
    || !bcrypt.compareSync(String(password ?? ''), owner.password_hash)) {
    audit('login_failed', 'auth', null, String(login ?? ''));
    return fail(res, 401, 'auth.invalid', 'Неверный пароль');
  }

  audit('login', 'auth', owner.id, owner.email || owner.name);
  res.json({ user: publicUser(owner), token: signToken(owner) });
});

app.post('/api/auth/change-password', (req, res) => {
  const { email, currentPassword, newPassword } = req.body ?? {};
  const owner = getOwner();

  // Пароля ещё нет — подтверждать нечем, форма задаёт первый.
  if (!owner || !loginMatches(owner, email)
    || (owner.password_hash && !bcrypt.compareSync(String(currentPassword ?? ''), owner.password_hash))) {
    return fail(res, 401, 'auth.invalidCurrent', 'Неверный текущий пароль');
  }
  if (String(newPassword ?? '').length < 6) {
    return fail(res, 400, 'auth.tooShort', 'Пароль должен быть не менее 6 символов');
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 10), owner.id);
  audit('password_change', 'auth', owner.id, owner.email || owner.name);
  res.json({ success: true });
});

// Снять пароль: учётная запись остаётся, приложение снова открывается сразу.
// Текущий пароль спрашиваем — иначе снять его мог бы любой, кто подошёл к
// открытому приложению. Запрос пароля при входе выключается заодно.
app.post('/api/auth/remove-password', (req, res) => {
  const { email, currentPassword } = req.body ?? {};
  const owner = getOwner();
  if (!owner || !loginMatches(owner, email)
    || (owner.password_hash && !bcrypt.compareSync(String(currentPassword ?? ''), owner.password_hash))) {
    return fail(res, 401, 'auth.invalidCurrent', 'Неверный текущий пароль');
  }

  db.prepare("UPDATE users SET password_hash = '', require_password = 0 WHERE id = ?").run(owner.id);
  audit('password_remove', 'auth', owner.id, owner.email || owner.name);
  res.json({ success: true });
});

// Включить или выключить запрос пароля при входе. Включить можно только
// заданный пароль: иначе владелец запер бы себя снаружи.
app.post('/api/auth/require-password', (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const owner = getOwner();
  if (!owner) return fail(res, 400, 'auth.ownerRequired', 'Нужно имя или email');
  if (enabled && !owner.password_hash) return fail(res, 400, 'auth.noPassword', 'Сначала задайте пароль');

  db.prepare('UPDATE users SET require_password = ? WHERE id = ?').run(enabled ? 1 : 0, owner.id);
  audit('settings', 'auth', owner.id, `requirePassword: ${enabled}`);
  res.json({ requirePassword: enabled });
});

// Полный сброс: все таблицы данных одной транзакцией. Учётная запись
// владельца в список не входит и переживает сброс.
app.post('/api/auth/reset-system', (req, res) => {
  if (!adminPasswordOk(req.body?.adminPassword)) {
    return fail(res, 401, 'auth.invalidAdmin', 'Неверный пароль администратора');
  }

  db.transaction(() => {
    for (const table of RESETTABLE_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  })();

  audit('reset', 'system', null, RESETTABLE_TABLES.join(', '));
  res.json({ success: true });
});

// Удаление демонстрационных данных: ровно то, что засеял первый запуск,
// и то, что успели привязать к демо-сотрудникам. Своё не трогается.
app.post('/api/demo/clear', (_req, res) => {
  const statements = demoCleanupStatements();
  let removed = 0;
  db.transaction(() => {
    for (const { sql, params } of statements) {
      removed += db.prepare(sql).run(...params).changes;
    }
  })();
  audit('demo_clear', 'system', null, String(removed));
  res.json({ removed });
});

// Маршруты для таблиц, описанных в src/data/entities.ts: подбор, отпуска,
// онбординг, цели, оценки, база знаний. Форма у всех одинаковая, поэтому
// маршруты строятся из описания, а не копируются семь раз.
for (const entity of ENTITIES) {
  const base = `/api/${entity.route}`;

  app.get(base, (_req, res) => {
    res.json(db.prepare(selectSql(entity)).all().map((row: any) => rowToObject(entity, row)));
  });

  // Сам журнал в журнал не пишется, иначе он зациклится на себе.
  const logged = entity.table !== AUDIT_TABLE;

  app.post(base, (req, res) => {
    const id = req.body.id || makeId();
    db.prepare(insertSql(entity)).run(id, ...objectToValues(entity, req.body));
    if (logged) audit('create', entity.table, id, null);
    res.json({ id });
  });

  app.put(`${base}/:id`, (req, res) => {
    const update = updateSql(entity, req.body);
    if (update) db.prepare(update.sql).run(...update.values, req.params.id);
    if (logged) audit('update', entity.table, req.params.id, Object.keys(req.body).join(', '));
    res.json({ success: true });
  });

  app.delete(`${base}/:id`, (req, res) => {
    db.prepare(`DELETE FROM ${entity.table} WHERE id = ?`).run(req.params.id);
    if (logged) audit('delete', entity.table, req.params.id, null);
    res.json({ success: true });
  });
}

// Проведение кадровой операции. Запись в movements и изменение карточки
// сотрудника идут одной транзакцией: запись о переводе без самого перевода
// (и наоборот) — рассогласование, которое потом не разобрать.
app.post('/api/movements/apply', (req, res) => {
  const movement = req.body;
  if (!movement?.employeeId || !movement?.type || !movement?.date) {
    return fail(res, 400, 'mov.fieldsRequired', 'Нужны сотрудник, тип и дата операции');
  }

  const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(movement.employeeId) as any;
  if (!row) return fail(res, 404, 'emp.notFound', 'Сотрудник не найден');
  const employee = employeeFromRow(row);

  const invalid = movementError(movement, employee);
  if (invalid) return fail(res, 400, invalid, 'Операцию провести нельзя');

  // Прежние значения фиксируются на сервере, а не приходят от клиента:
  // иначе в истории осело бы то, что было открыто в форме, а не в базе.
  const record = movementRecord(movement, employee);

  const entity = ENTITY_BY_TABLE.get('movements')!;
  const id = movement.id || makeId();
  const patch = employeePatchFor(record);
  const update = employeeUpdate(patch);

  db.transaction(() => {
    db.prepare(insertSql(entity)).run(id, ...objectToValues(entity, record));
    if (update) {
      db.prepare(`UPDATE employees SET ${update.assignments} WHERE id = ?`).run(...update.values, movement.employeeId);
    }
  })();

  audit('movement', 'employees', movement.employeeId, `${movement.type} · ${movement.date}`);
  res.json({ id, movement: { ...record, id }, employeePatch: patch });
});

// Очистка данных отдельных модулей. Отличается от полного сброса тем, что
// трогает только выбранные таблицы и не затрагивает настройки.
app.post('/api/reset/tables', (req, res) => {
  const { adminPassword, tables } = req.body ?? {};

  // Пароля может не быть вовсе — тогда сверять нечего, и ступенью защиты
  // остаётся подтверждение в интерфейсе.
  if (!adminPasswordOk(adminPassword)) {
    return fail(res, 401, 'auth.invalidAdmin', 'Неверный пароль администратора');
  }

  const requested = Array.isArray(tables) ? tables.filter((t: string) => BACKUP_TABLES.includes(t)) : [];
  if (requested.length === 0) return fail(res, 400, 'reset.noTables', 'Не выбрано ни одной известной таблицы');

  db.transaction(() => {
    for (const table of requested) db.prepare(`DELETE FROM ${table}`).run();
  })();

  audit('reset_tables', 'system', null, requested.join(', '));
  res.json({ cleared: requested });
});

// Резервная копия — снимок таблиц данных в виде JSON. Формат намеренно
// простой: колонки как есть, чтобы копию можно было прочитать и починить
// руками, не разбирая формат SQLite.
app.get('/api/backup', (_req, res) => {
  const data: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) {
    data[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  audit('backup', 'system', null, `${BACKUP_TABLES.length}`);
  res.json({ version: 1, createdAt: new Date().toISOString(), data });
});

app.post('/api/backup/restore', (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || typeof payload.data !== 'object' || payload.data === null) {
    return res.status(400).json({ error: 'Файл не похож на резервную копию' });
  }

  // Восстанавливаем только известные таблицы: лишние ключи в файле молча
  // игнорируем, но и данные из них не подсовываем в базу.
  const tables = BACKUP_TABLES.filter((table) => Array.isArray(payload.data[table]));
  if (tables.length === 0) {
    return res.status(400).json({ error: 'В копии нет ни одной известной таблицы' });
  }

  let restored = 0;
  try {
    db.transaction(() => {
      for (const table of tables) {
        db.prepare(`DELETE FROM ${table}`).run();

        const rows = payload.data[table] as Record<string, unknown>[];
        if (rows.length === 0) continue;

        // Пишем по колонкам самой строки, но только тем, что есть в схеме:
        // копия из другой версии не должна ронять восстановление целиком.
        const known = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
        const columns = Object.keys(rows[0]).filter((c) => known.has(c));
        if (columns.length === 0) continue;

        const stmt = db.prepare(
          `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        );
        for (const row of rows) {
          stmt.run(...columns.map((c) => row[c] ?? null));
          restored += 1;
        }
      }
    })();
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Не удалось восстановить копию' });
  }

  audit('restore', 'system', null, `${restored}`);
  res.json({ restored, tables: tables.length });
});

// API Employees
const employeeFromRow = (e: any) => ({
  id: e.id,
  fullName: e.full_name,
  position: e.position,
  department: e.department,
  status: e.status,
  hireDate: e.hire_date,
  tabNumber: e.tab_number ?? undefined,
  birthDate: e.birth_date ?? undefined,
  paymentType: e.payment_type || 'salary',
  salary: e.salary || 0,
  rate: e.rate || 1,
  dismissalDate: e.dismissal_date ?? null,
});

app.get('/api/employees', (_req, res) => {
  res.json(db.prepare('SELECT * FROM employees').all().map(employeeFromRow));
});

const insertEmployee = () => db.prepare(
  'INSERT INTO employees (id, full_name, position, department, status, hire_date, tab_number, birth_date, payment_type, salary, rate, dismissal_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
);

/** Значения по умолчанию для необязательных полей карточки. */
const withEmployeeDefaults = (e: any) => ({
  ...e,
  tabNumber: e.tabNumber || null,
  birthDate: e.birthDate || null,
  paymentType: e.paymentType ?? 'salary',
  salary: e.salary ?? 0,
  rate: e.rate ?? 1,
  dismissalDate: e.dismissalDate || null,
});

const employeeParams = (id: string, e: any) => [
  id, String(e.fullName).trim(), String(e.position).trim(), String(e.department).trim(), e.status, e.hireDate,
  e.tabNumber, e.birthDate, e.paymentType, Number(e.salary), Number(e.rate), e.dismissalDate,
];

app.post('/api/employees', (req, res) => {
  const employee = withEmployeeDefaults(req.body ?? {});
  const errors = employeeErrors(employee);
  if (hasErrors(errors)) return fail(res, 400, 'emp.validation', 'Проверьте заполнение карточки', { fields: errors });

  const newId = employee.id || makeId();
  insertEmployee().run(...employeeParams(newId, employee));
  audit('create', 'employees', newId, employee.fullName);
  res.json({ id: newId });
});

// Массовая вставка для импорта из Excel: одна транзакция на весь файл.
// Строки проверяются заранее — файл импортируется целиком либо никак.
app.post('/api/employees/bulk', (req, res) => {
  const rows = Array.isArray(req.body?.employees) ? req.body.employees : null;
  if (!rows) return fail(res, 400, 'emp.bulkShape', 'Ожидался массив employees');

  const prepared = rows.map(withEmployeeDefaults);
  const invalid = prepared
    .map((e: any, index: number) => ({ index, errors: employeeErrors(e) }))
    .filter((r: { errors: object }) => hasErrors(r.errors));
  if (invalid.length > 0) {
    return fail(res, 400, 'emp.validation', 'Проверьте заполнение карточки', { rows: invalid.slice(0, 50) });
  }

  const stmt = insertEmployee();
  const ids: string[] = [];
  db.transaction(() => {
    for (const e of prepared) {
      const newId = e.id || makeId();
      stmt.run(...employeeParams(newId, e));
      ids.push(newId);
    }
  })();

  audit('import', 'employees', null, `${ids.length}`);
  res.json({ ids });
});

// Обновление поверх текущей строки: переданные поля меняются, остальные
// остаются. Раньше непереданное поле молча превращалось в NULL.
app.put('/api/employees/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, 'emp.notFound', 'Сотрудник не найден');

  const merged = withEmployeeDefaults({ ...employeeFromRow(row), ...req.body });
  const errors = employeeErrors(merged);
  if (hasErrors(errors)) return fail(res, 400, 'emp.validation', 'Проверьте заполнение карточки', { fields: errors });

  const [, ...values] = employeeParams(req.params.id, merged);
  db.prepare('UPDATE employees SET full_name = ?, position = ?, department = ?, status = ?, hire_date = ?, tab_number = ?, birth_date = ?, payment_type = ?, salary = ?, rate = ?, dismissal_date = ? WHERE id = ?')
    .run(...values, req.params.id);
  audit('update', 'employees', req.params.id, merged.fullName);
  res.json({ success: true });
});

app.delete('/api/employees/:id', (req, res) => {
  const row = db.prepare('SELECT full_name FROM employees WHERE id = ?').get(req.params.id) as { full_name: string } | undefined;
  db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  audit('delete', 'employees', req.params.id, row?.full_name ?? null);
  res.json({ success: true });
});

// API Departments
const listDepartmentRows = () => db.prepare('SELECT * FROM departments').all().map((d: any) => ({
  id: d.id, name: d.name, parentId: d.parent_id,
}));

app.get('/api/departments', (_req, res) => {
  res.json(listDepartmentRows());
});
app.post('/api/departments', (req, res) => {
  const { id, name, parentId } = req.body ?? {};
  const departments = listDepartmentRows();
  const nameError = departmentNameError(String(name ?? ''), departments);
  if (nameError) return fail(res, 400, nameError, 'Проверьте название подразделения');
  const parent = parentId || null;
  // Ссылка на несуществующего родителя допустима только для старых данных;
  // новое подразделение кладётся либо в корень, либо в настоящий узел.
  if (parent && !departments.some((d) => d.id === parent)) return fail(res, 400, 'org.parentMissing', 'Родительское подразделение не найдено');

  const newId = id || makeId();
  db.prepare('INSERT INTO departments (id, name, parent_id) VALUES (?, ?, ?)').run(newId, String(name).trim(), parent);
  audit('create', 'departments', newId, String(name).trim());
  res.json({ id: newId });
});
app.put('/api/departments/:id', (req, res) => {
  const departments = listDepartmentRows();
  const current = departments.find((d) => d.id === req.params.id);
  if (!current) return fail(res, 404, 'org.notFound', 'Подразделение не найдено');

  const body = req.body ?? {};
  const name = body.name !== undefined ? String(body.name) : current.name;
  // Отсутствие поля — родитель прежний; явный null — корень.
  const parent = 'parentId' in body ? (body.parentId || null) : current.parentId;

  const nameError = departmentNameError(name, departments, current.id);
  if (nameError) return fail(res, 400, nameError, 'Проверьте название подразделения');
  const cycle = parentError(departments, current.id, parent);
  if (cycle) return fail(res, 400, cycle, 'Нельзя выбрать такое родительское подразделение');

  // Сотрудники ссылаются на подразделение по названию, поэтому
  // переименование проходит по их карточкам той же транзакцией — иначе люди
  // «выпали» бы из штатного расписания.
  const newName = name.trim();
  let renamedEmployees = 0;
  db.transaction(() => {
    db.prepare('UPDATE departments SET name = ?, parent_id = ? WHERE id = ?').run(newName, parent, current.id);
    if (newName !== current.name) {
      renamedEmployees = db.prepare('UPDATE employees SET department = ? WHERE department = ?').run(newName, current.name).changes;
    }
  })();
  audit('update', 'departments', current.id, newName);
  res.json({ success: true, renamedEmployees });
});
// Удаление подразделения вместе с его должностями. Вложенные подразделения
// не удаляются каскадом: их сначала переносят или удаляют явно — молча
// стереть полдерева одним щелчком слишком дорого.
app.delete('/api/departments/:id', (req, res) => {
  const departments = listDepartmentRows();
  const current = departments.find((d) => d.id === req.params.id);
  if (!current) return res.json({ success: true, deletedPositions: 0 });
  if (departments.some((d) => d.parentId === current.id)) {
    return fail(res, 409, 'org.hasChildren', 'Сначала удалите или перенесите вложенные подразделения');
  }
  // Работающие сотрудники остались бы с подразделением, которого нет.
  const staff = (db.prepare("SELECT count(*) AS c FROM employees WHERE department = ? AND status != 'dismissed'").get(current.name) as { c: number }).c;
  if (staff > 0) {
    return fail(res, 409, 'org.hasEmployees', 'В подразделении числятся сотрудники', { count: staff });
  }

  let deletedPositions = 0;
  db.transaction(() => {
    deletedPositions = db.prepare('DELETE FROM positions WHERE department_id = ?').run(current.id).changes;
    db.prepare('DELETE FROM departments WHERE id = ?').run(current.id);
  })();
  audit('delete', 'departments', current.id, current.name);
  res.json({ success: true, deletedPositions });
});

// API Positions
const positionFromRow = (p: any) => ({
  id: p.id, departmentId: p.department_id, title: p.title, maxCount: p.max_count, salary: p.salary,
});

app.get('/api/positions', (_req, res) => {
  res.json(db.prepare('SELECT * FROM positions').all().map(positionFromRow));
});

function checkPosition(res: Response, draft: any, excludeId?: string): boolean {
  if (!draft.departmentId || !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(draft.departmentId)) {
    fail(res, 400, 'pos.departmentMissing', 'Подразделение не найдено');
    return false;
  }
  const siblings = db.prepare('SELECT * FROM positions WHERE department_id = ?').all(draft.departmentId).map(positionFromRow);
  const errors = positionErrors(draft, siblings, excludeId);
  if (hasErrors(errors)) {
    fail(res, 400, Object.values(errors)[0] as string, 'Проверьте заполнение должности', { fields: errors });
    return false;
  }
  return true;
}

app.post('/api/positions', (req, res) => {
  const { id, departmentId, title, maxCount, salary } = req.body ?? {};
  const draft = { departmentId, title: String(title ?? ''), maxCount, salary: salary ?? '' };
  if (!checkPosition(res, draft)) return;

  const newId = id || makeId();
  db.prepare('INSERT INTO positions (id, department_id, title, max_count, salary) VALUES (?, ?, ?, ?, ?)')
    .run(newId, departmentId, draft.title.trim(), Number(maxCount), Number(salary));
  audit('create', 'positions', newId, draft.title.trim());
  res.json({ id: newId });
});
app.put('/api/positions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, 'pos.notFound', 'Должность не найдена');
  const merged = { ...positionFromRow(row), ...req.body };
  if (!checkPosition(res, merged, req.params.id)) return;

  const before = positionFromRow(row);
  const title = String(merged.title).trim();
  let renamedEmployees = 0;
  db.transaction(() => {
    db.prepare('UPDATE positions SET department_id = ?, title = ?, max_count = ?, salary = ? WHERE id = ?')
      .run(merged.departmentId, title, Number(merged.maxCount), Number(merged.salary), req.params.id);
    // Переименование должности проходит по карточкам её подразделения.
    if (title !== before.title && merged.departmentId === before.departmentId) {
      renamedEmployees = db.prepare(
        'UPDATE employees SET position = ? WHERE position = ? AND department = (SELECT name FROM departments WHERE id = ?)',
      ).run(title, before.title, before.departmentId).changes;
    }
  })();
  audit('update', 'positions', req.params.id, title);
  res.json({ success: true, renamedEmployees });
});
app.delete('/api/positions/:id', (req, res) => {
  const row = db.prepare('SELECT title FROM positions WHERE id = ?').get(req.params.id) as { title: string } | undefined;
  db.prepare('DELETE FROM positions WHERE id = ?').run(req.params.id);
  audit('delete', 'positions', req.params.id, row?.title ?? null);
  res.json({ success: true });
});

// API Templates
app.get('/api/templates', (_req, res) => {
  const templates = db.prepare('SELECT * FROM templates').all().map((t: any) => ({
    id: t.id,
    name: t.name,
    blocks: JSON.parse(t.blocks)
  }));
  res.json(templates);
});

const TEMPLATE_ERRORS: Record<string, string> = {
  'tpl.nameRequired': 'Укажите название шаблона',
  'tpl.nameTooLong': 'Название шаблона длиннее 200 символов',
  'tpl.blocksInvalid': 'Блоки шаблона повреждены',
};

app.post('/api/templates', (req, res) => {
  const { id, name, blocks } = req.body ?? {};
  const error = templateError({ name, blocks });
  if (error) return fail(res, 400, error, TEMPLATE_ERRORS[error]);
  const newId = id || makeId();
  db.prepare('INSERT INTO templates (id, name, blocks) VALUES (?, ?, ?)')
    .run(newId, String(name).trim(), JSON.stringify(blocks));
  audit('create', 'templates', newId, String(name).trim());
  res.json({ id: newId });
});

app.put('/api/templates/:id', (req, res) => {
  const current = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id) as { name: string; blocks: string } | undefined;
  if (!current) return fail(res, 404, 'tpl.notFound', 'Шаблон не найден');
  // Частичная правка: чего нет в запросе — остаётся как было.
  const name = req.body?.name ?? current.name;
  const blocks = req.body?.blocks ?? JSON.parse(current.blocks);
  const error = templateError({ name, blocks });
  if (error) return fail(res, 400, error, TEMPLATE_ERRORS[error]);
  db.prepare('UPDATE templates SET name = ?, blocks = ? WHERE id = ?')
    .run(String(name).trim(), JSON.stringify(blocks), req.params.id);
  audit('update', 'templates', req.params.id, String(name).trim());
  res.json({ success: true });
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  audit('delete', 'templates', req.params.id, null);
  res.json({ success: true });
});

// API Timesheets
// Табель и архив растут линейно по времени и по штату, поэтому тянуть их
// целиком нельзя. Параметры запроса задают срез; без них поведение прежнее.
app.get('/api/timesheets', (req, res) => {
  const where: string[] = [];
  const params: any[] = [];
  if (req.query.year !== undefined) { where.push('year = ?'); params.push(Number(req.query.year)); }
  if (req.query.month !== undefined) { where.push('month = ?'); params.push(Number(req.query.month)); }
  const sql = `SELECT * FROM timesheets${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;

  const timesheets = db.prepare(sql).all(...params).map((t: any) => ({
    id: t.id,
    year: t.year,
    month: t.month,
    employeeId: t.employee_id,
    days: JSON.parse(t.days)
  }));
  res.json(timesheets);
});

app.post('/api/timesheets', (req, res) => {
  const { id, year, month, employeeId, days } = req.body;
  const newId = id || makeId();
  db.prepare('INSERT INTO timesheets (id, year, month, employee_id, days) VALUES (?, ?, ?, ?, ?)')
    .run(newId, year, month, employeeId, JSON.stringify(days));
  res.json({ id: newId });
});

app.put('/api/timesheets/:id', (req, res) => {
  const { year, month, employeeId, days } = req.body;
  db.prepare('UPDATE timesheets SET year = ?, month = ?, employee_id = ?, days = ? WHERE id = ?')
    .run(year, month, employeeId, JSON.stringify(days), req.params.id);
  res.json({ success: true });
});

app.delete('/api/timesheets/:id', (req, res) => {
  db.prepare('DELETE FROM timesheets WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});


// API Archives
// Значения для выпадающих фильтров архива. Считаются по всей таблице,
// поэтому список лет и подразделений не схлопывается при выбранном срезе.
app.get('/api/archives/facets', (_req, res) => {
  const years = db.prepare('SELECT DISTINCT year FROM archives ORDER BY year DESC').all().map((r: any) => r.year);
  const departments = db.prepare('SELECT DISTINCT department FROM archives ORDER BY department').all().map((r: any) => r.department);
  // Сотрудники — те, кто есть в архиве, а не нынешний штат: в архиве лежат
  // и уволенные, и удалённые из картотеки.
  const employees = db.prepare('SELECT employee_id AS id, MAX(employee_name) AS name FROM archives GROUP BY employee_id ORDER BY name')
    .all() as { id: string; name: string }[];
  res.json({ years, departments, employees });
});

// Закрытие месяца: строки архива за месяц одним целым. replace — заменить
// ранее отправленные строки этого же месяца (повторное закрытие).
app.post('/api/archives/bulk', (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : null;
  if (!records) return fail(res, 400, 'archive.bulkShape', 'Ожидался массив records');
  const replace = req.body?.replace as { year: number; month: number } | undefined;

  const stmt = db.prepare('INSERT INTO archives (id, year, month, employee_id, employee_name, department, position, salary, hours_worked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const ids: string[] = [];
  db.transaction(() => {
    if (replace) db.prepare('DELETE FROM archives WHERE year = ? AND month = ?').run(replace.year, replace.month);
    for (const r of records) {
      const newId = r.id || makeId();
      stmt.run(newId, r.year, r.month, r.employeeId, r.employeeName, r.department, r.position, r.salary ?? 0, r.hoursWorked ?? 0);
      ids.push(newId);
    }
  })();
  audit('archive_month', 'archives', null, replace ? `${replace.year}-${String(replace.month).padStart(2, '0')} · ${ids.length}` : String(ids.length));
  res.json({ ids });
});

app.get('/api/archives', (req, res) => {
  const where: string[] = [];
  const params: any[] = [];
  if (req.query.year !== undefined) { where.push('year = ?'); params.push(Number(req.query.year)); }
  if (req.query.department !== undefined) { where.push('department = ?'); params.push(String(req.query.department)); }
  if (req.query.employeeId !== undefined) { where.push('employee_id = ?'); params.push(String(req.query.employeeId)); }
  const sql = `SELECT * FROM archives${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;

  const archives = db.prepare(sql).all(...params).map((a: any) => ({
    id: a.id,
    year: a.year,
    month: a.month,
    employeeId: a.employee_id,
    employeeName: a.employee_name,
    department: a.department,
    position: a.position,
    salary: a.salary,
    hoursWorked: a.hours_worked
  }));
  res.json(archives);
});

app.post('/api/archives', (req, res) => {
  const { id, year, month, employeeId, employeeName, department, position, salary, hoursWorked } = req.body;
  const newId = id || makeId();
  db.prepare('INSERT INTO archives (id, year, month, employee_id, employee_name, department, position, salary, hours_worked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId, year, month, employeeId, employeeName, department, position, salary, hoursWorked);
  res.json({ id: newId });
});

app.delete('/api/archives/:id', (req, res) => {
  db.prepare('DELETE FROM archives WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Vite / Static setup
export async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (!servesLoopbackOnly()) {
      console.warn(`ВНИМАНИЕ: сервер открыт в сеть (HOST=${HOST}) — данные доступны с других компьютеров.`);
    }
  });
}

// HR_NO_AUTOSTART=1 — импорт без запуска слушателя (используется API-тестами).
if (process.env.HR_NO_AUTOSTART !== '1') {
  startServer();
}
