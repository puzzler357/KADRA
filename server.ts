import './src/env';
import express from 'express';
import path from 'path';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createServer as createViteServer } from 'vite';
import db, { RESETTABLE_TABLES } from './src/db/sqlite';
import { ENTITIES, ENTITY_BY_TABLE, AUDIT_TABLE, BACKUP_TABLES, insertSql, selectSql, updateSql, rowToObject, objectToValues } from './src/data/entities';
import { employeePatchFor, employeeUpdate } from './src/data/movements';

export const app = express();
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-local-key-2024';

app.use(cors());
app.use(express.json());

// Журнал аудита пишется здесь, а не на экранах: событие должно попадать в
// журнал вместе с самим изменением, а не тогда, когда клиент про это вспомнит.
const insertAudit = () => db.prepare(
  'INSERT INTO audit_log (id, ts, action, entity, entity_id, diff) VALUES (?, ?, ?, ?, ?, ?)',
);

function audit(action: string, entity: string, entityId?: string | null, diff?: string | null) {
  insertAudit().run(
    Math.random().toString(36).substring(2, 12),
    new Date().toISOString(),
    action, entity, entityId ?? null, diff ?? null,
  );
}

// API Auth
// Есть ли владелец. Пока нет — приложение показывает экран первичной
// настройки вместо входа: пароль по умолчанию в поставке не предусмотрен.
app.get('/api/auth/status', (_req, res) => {
  const { c } = db.prepare('SELECT count(*) as c FROM users').get() as { c: number };
  res.json({ needsSetup: c === 0 });
});

// Владелец без проверки пароля. Нужен для входа, когда пароль при входе
// выключен: учётная запись всё равно одна и лежит на этом же устройстве.
app.get('/api/auth/owner', (_req, res) => {
  const user = db.prepare("SELECT id, email, name, role FROM users ORDER BY id LIMIT 1").get() as any;
  if (!user) return res.json({ user: null });
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ user, token });
});

app.post('/api/auth/setup', (req, res) => {
  const { name, email, password } = req.body ?? {};

  const { c } = db.prepare('SELECT count(*) as c FROM users').get() as { c: number };
  if (c > 0) return res.status(409).json({ error: 'Владелец уже назначен' });

  if (!email || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Нужны email и пароль не короче 8 символов' });
  }

  const id = '1';
  db.prepare('INSERT INTO users (id, email, password_hash, role, name) VALUES (?, ?, ?, ?, ?)')
    .run(id, email, bcrypt.hashSync(password, 10), 'ADMIN', name || email);

  audit('setup', 'auth', id, email);

  const token = jwt.sign({ id, role: 'ADMIN' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ user: { id, email, name: name || email, role: 'ADMIN' }, token });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
  
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    audit('login_failed', 'auth', null, String(email ?? ''));
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  audit('login', 'auth', user.id, user.email);
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role }, token });
});

app.post('/api/auth/change-password', (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Неверный текущий пароль' });
  }
  
  audit('password_change', 'auth', user.id, user.email);
  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
  
  res.json({ success: true });
});

app.post('/api/auth/reset-system', (req, res) => {
  const { adminPassword } = req.body;
  
  const admin = db.prepare('SELECT * FROM users WHERE role = ?').get('ADMIN') as any;
  if (!admin || !bcrypt.compareSync(adminPassword, admin.password_hash)) {
    return res.status(401).json({ error: 'Неверный пароль администратора' });
  }
  
  // Чистим все таблицы данных одной транзакцией; учётная запись владельца
  // в список не входит и переживает сброс.
  db.transaction(() => {
    for (const table of RESETTABLE_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  })();

  
  audit('reset', 'system', null, RESETTABLE_TABLES.join(', '));
  res.json({ success: true, message: 'Все данные системы были успешно сброшены' });
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
    const id = req.body.id || Math.random().toString(36).substring(7);
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
    return res.status(400).json({ error: 'Нужны employeeId, type и date' });
  }

  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(movement.employeeId) as any;
  if (!employee) return res.status(404).json({ error: 'Сотрудник не найден' });

  // Прежние значения фиксируются на сервере, а не приходят от клиента:
  // иначе в истории осело бы то, что было открыто в форме, а не в базе.
  const record = {
    ...movement,
    fromPosition: employee.position,
    fromDepartment: employee.department,
    fromSalary: employee.salary ?? 0,
  };

  const entity = ENTITY_BY_TABLE.get('movements')!;
  const id = movement.id || Math.random().toString(36).substring(7);
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

  const admin = db.prepare('SELECT * FROM users WHERE role = ?').get('ADMIN') as any;
  if (!admin || !bcrypt.compareSync(adminPassword, admin.password_hash)) {
    return res.status(401).json({ error: 'Неверный пароль администратора' });
  }

  const requested = Array.isArray(tables) ? tables.filter((t: string) => BACKUP_TABLES.includes(t)) : [];
  if (requested.length === 0) return res.status(400).json({ error: 'Не выбрано ни одной известной таблицы' });

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
app.get('/api/employees', (_req, res) => {
  const employees = db.prepare('SELECT * FROM employees').all().map((e: any) => ({
    id: e.id,
    fullName: e.full_name,
    position: e.position,
    department: e.department,
    status: e.status,
    hireDate: e.hire_date,
    tabNumber: e.tab_number ?? undefined,
    birthDate: e.birth_date,
    paymentType: e.payment_type || 'salary',
    salary: e.salary || 0,
    rate: e.rate || 1
  }));
  res.json(employees);
});

const insertEmployee = () => db.prepare(
  'INSERT INTO employees (id, full_name, position, department, status, hire_date, tab_number, birth_date, payment_type, salary, rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
);

const newEmployeeId = () => Math.random().toString(36).substring(7);

app.post('/api/employees', (req, res) => {
  const { id, fullName, position, department, status, hireDate, tabNumber, birthDate, paymentType = 'salary', salary = 0, rate = 1 } = req.body;
  const newId = id || newEmployeeId();
  insertEmployee().run(newId, fullName, position, department, status, hireDate, tabNumber ?? null, birthDate, paymentType, salary, rate);
  audit('create', 'employees', newId, fullName);
  res.json({ id: newId });
});

// Массовая вставка для импорта из Excel: одна транзакция на весь файл.
app.post('/api/employees/bulk', (req, res) => {
  const rows = Array.isArray(req.body?.employees) ? req.body.employees : null;
  if (!rows) return res.status(400).json({ error: 'Ожидался массив employees' });

  const stmt = insertEmployee();
  const ids: string[] = [];
  db.transaction(() => {
    for (const e of rows) {
      const newId = e.id || newEmployeeId();
      stmt.run(newId, e.fullName, e.position, e.department, e.status, e.hireDate, e.tabNumber ?? null, e.birthDate ?? null, e.paymentType ?? 'salary', e.salary ?? 0, e.rate ?? 1);
      ids.push(newId);
    }
  })();

  audit('import', 'employees', null, `${ids.length}`);
  res.json({ ids });
});

app.put('/api/employees/:id', (req, res) => {
  const { fullName, position, department, status, hireDate, tabNumber, birthDate, paymentType, salary, rate } = req.body;
  db.prepare('UPDATE employees SET full_name = ?, position = ?, department = ?, status = ?, hire_date = ?, tab_number = ?, birth_date = ?, payment_type = ?, salary = ?, rate = ? WHERE id = ?')
    .run(fullName, position, department, status, hireDate, tabNumber ?? null, birthDate, paymentType, salary, rate, req.params.id);
  audit('update', 'employees', req.params.id, fullName);
  res.json({ success: true });
});

app.delete('/api/employees/:id', (req, res) => {
  db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  audit('delete', 'employees', req.params.id, null);
  res.json({ success: true });
});

// API Departments
app.get('/api/departments', (_req, res) => {
  const deps = db.prepare('SELECT * FROM departments').all().map((d: any) => ({
    id: d.id, name: d.name, parentId: d.parent_id
  }));
  res.json(deps);
});
app.post('/api/departments', (req, res) => {
  const { id, name, parentId } = req.body;
  const newId = id || Math.random().toString(36).substring(7);
  db.prepare('INSERT INTO departments (id, name, parent_id) VALUES (?, ?, ?)').run(newId, name, parentId || null);
  audit('create', 'departments', newId, name);
  res.json({ id: newId });
});
app.put('/api/departments/:id', (req, res) => {
  db.prepare('UPDATE departments SET name = ?, parent_id = ? WHERE id = ?').run(req.body.name, req.body.parentId || null, req.params.id);
  audit('update', 'departments', req.params.id, req.body.name);
  res.json({ success: true });
});
app.delete('/api/departments/:id', (req, res) => {
  db.prepare('DELETE FROM departments WHERE id = ?').run(req.params.id);
  audit('delete', 'departments', req.params.id, null);
  res.json({ success: true });
});

// API Positions
app.get('/api/positions', (_req, res) => {
  const pos = db.prepare('SELECT * FROM positions').all().map((p: any) => ({
    id: p.id, departmentId: p.department_id, title: p.title, maxCount: p.max_count, salary: p.salary
  }));
  res.json(pos);
});
app.post('/api/positions', (req, res) => {
  const { id, departmentId, title, maxCount, salary } = req.body;
  const newId = id || Math.random().toString(36).substring(7);
  db.prepare('INSERT INTO positions (id, department_id, title, max_count, salary) VALUES (?, ?, ?, ?, ?)').run(newId, departmentId, title, maxCount, salary);
  audit('create', 'positions', newId, title);
  res.json({ id: newId });
});
app.put('/api/positions/:id', (req, res) => {
  const { departmentId, title, maxCount, salary } = req.body;
  db.prepare('UPDATE positions SET department_id = ?, title = ?, max_count = ?, salary = ? WHERE id = ?').run(departmentId, title, maxCount, salary, req.params.id);
  audit('update', 'positions', req.params.id, title);
  res.json({ success: true });
});
app.delete('/api/positions/:id', (req, res) => {
  db.prepare('DELETE FROM positions WHERE id = ?').run(req.params.id);
  audit('delete', 'positions', req.params.id, null);
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

app.post('/api/templates', (req, res) => {
  const { id, name, blocks } = req.body;
  const newId = id || Math.random().toString(36).substring(7);
  db.prepare('INSERT INTO templates (id, name, blocks) VALUES (?, ?, ?)')
    .run(newId, name, JSON.stringify(blocks));
  audit('create', 'templates', newId, name);
  res.json({ id: newId });
});

app.put('/api/templates/:id', (req, res) => {
  const { name, blocks } = req.body;
  db.prepare('UPDATE templates SET name = ?, blocks = ? WHERE id = ?')
    .run(name, JSON.stringify(blocks), req.params.id);
  audit('update', 'templates', req.params.id, name);
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
  const newId = id || Math.random().toString(36).substring(7);
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
  res.json({ years, departments });
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
  const newId = id || Math.random().toString(36).substring(7);
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// HR_NO_AUTOSTART=1 — импорт без запуска слушателя (используется API-тестами).
if (process.env.HR_NO_AUTOSTART !== '1') {
  startServer();
}
