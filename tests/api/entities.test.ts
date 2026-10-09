import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, startApi, stopApi, ensureOwner, OWNER_EMAIL, OWNER_PASSWORD } from './helpers';
import { ENTITIES, SEEDED_ENTITIES } from '../../src/data/entities';

beforeAll(async () => {
  await startApi();
  await ensureOwner();
});
afterAll(stopApi);

// Маршруты для этих таблиц строятся из описания в src/data/entities.ts.
// Тест идёт по тому же описанию: добавится сущность — проверка появится сама.
describe('таблицы экранов подбора, отпусков, онбординга, оценки и базы знаний', () => {
  it.each(ENTITIES.map((e) => [e.route, e.table]))('GET /api/%s отдаёт массив', async (route) => {
    const { status, body } = await api('GET', `/api/${route}`);

    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it.each(ENTITIES.map((e) => [e.route, e]))('CRUD /api/%s', async (route, entity: any) => {
    // Значение под каждый тип колонки, чтобы не описывать тело руками.
    const payload: Record<string, unknown> = {};
    for (const c of entity.columns) {
      if (c.kind === 'bool') payload[c.field] = true;
      else if (c.kind === 'number') payload[c.field] = 7;
      else payload[c.field] = `${c.field}-значение`;
    }

    const created = await api('POST', `/api/${route}`, payload);
    expect(created.status).toBe(200);
    const id: string = created.body.id;
    expect(id).toBeTruthy();

    const row = (await api('GET', `/api/${route}`)).body.find((r: any) => r.id === id);
    expect(row).toBeTruthy();
    for (const c of entity.columns) {
      expect(row[c.field]).toEqual(payload[c.field]);
    }

    // Частичное обновление не должно затирать остальные поля: экраны меняют
    // по одному свойству за раз (перетащили карточку, поставили галочку).
    const first = entity.columns[0];
    const patched = first.kind === 'bool' ? false : first.kind === 'number' ? 42 : 'обновлено';
    await api('PUT', `/api/${route}/${id}`, { [first.field]: patched });

    const afterUpdate = (await api('GET', `/api/${route}`)).body.find((r: any) => r.id === id);
    expect(afterUpdate[first.field]).toEqual(patched);
    for (const c of entity.columns.slice(1)) {
      expect(afterUpdate[c.field]).toEqual(payload[c.field]);
    }

    expect((await api('DELETE', `/api/${route}/${id}`)).status).toBe(200);
    expect((await api('GET', `/api/${route}`)).body.find((r: any) => r.id === id)).toBeUndefined();
  });
});

describe('булевы поля', () => {
  it('done приходит булевым, а не нулём и единицей SQLite', async () => {
    const created = await api('POST', '/api/checklist-tasks', {
      employeeId: '1', kind: 'onboarding', title: 'Проверка типа', assignee: 'HR', done: false, orderIndex: 1,
    });
    const id: string = created.body.id;

    const row = (await api('GET', '/api/checklist-tasks')).body.find((r: any) => r.id === id);
    expect(row.done).toBe(false);

    await api('PUT', `/api/checklist-tasks/${id}`, { done: true });
    const toggled = (await api('GET', '/api/checklist-tasks')).body.find((r: any) => r.id === id);
    expect(toggled.done).toBe(true);
    expect(toggled.title).toBe('Проверка типа');

    await api('DELETE', `/api/checklist-tasks/${id}`);
  });
});

describe('посев экранов', () => {
  it('заполняет таблицы экранов, чтобы они не открывались пустыми', async () => {
    // Таблицы, помеченные selfFilling, в посев не входят намеренно: журнал
    // пишется сам, наборы конструктора создаёт пользователь.
    for (const entity of SEEDED_ENTITIES) {
      const { body } = await api('GET', `/api/${entity.route}`);
      expect(body.length, `таблица ${entity.table} пуста`).toBeGreaterThan(0);
    }
  });
});

describe('учётная запись владельца', () => {
  it('статус сообщает, что владелец заведён и пароль у него есть', async () => {
    const { status, body } = await api('GET', '/api/auth/status');
    expect(status).toBe(200);
    expect(body.hasOwner).toBe(true);
    expect(body.hasPassword).toBe(true);
  });

  // Запрос один на создание и на правку, поэтому важно, что второй вызов
  // правит ту же строку: вторая учётная запись сломала бы всё остальное.
  it('повторное сохранение правит ту же запись, а не заводит вторую', async () => {
    const renamed = await api('POST', '/api/auth/owner', {
      name: 'Переименованный', email: OWNER_EMAIL,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.user.name).toBe('Переименованный');

    const owner = await api('GET', '/api/auth/owner');
    expect(owner.body.user.name).toBe('Переименованный');

    // Возвращаем как было: база общая с остальными файлами.
    await api('POST', '/api/auth/owner', { name: 'Владелец Устройства', email: OWNER_EMAIL });
  });

  it('пустой запрос отклоняется — сохранять нечего', async () => {
    const { status } = await api('POST', '/api/auth/owner', { name: '  ', email: '' });
    expect(status).toBe(400);
  });
});

describe('журнал аудита', () => {
  it('пишется вместе с изменением, а не по просьбе экрана', async () => {
    const before = (await api('GET', '/api/audit-log')).body.length;

    const created = await api('POST', '/api/employees', {
      fullName: 'Аудит Тест', position: 'Инженер', department: 'IT', status: 'active', hireDate: '2026-03-01',
    });
    const id: string = created.body.id;

    const afterCreate = (await api('GET', '/api/audit-log')).body;
    expect(afterCreate.length).toBe(before + 1);
    expect(afterCreate[0]).toMatchObject({ action: 'create', entity: 'employees', entityId: id });

    await api('DELETE', `/api/employees/${id}`);
    const afterDelete = (await api('GET', '/api/audit-log')).body;
    expect(afterDelete[0]).toMatchObject({ action: 'delete', entity: 'employees', entityId: id });
  });

  it('фиксирует вход и неудачную попытку входа', async () => {
    await api('POST', '/api/auth/login', { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect((await api('GET', '/api/audit-log')).body[0]).toMatchObject({ action: 'login', entity: 'auth' });

    await api('POST', '/api/auth/login', { email: OWNER_EMAIL, password: 'неверный' });
    expect((await api('GET', '/api/audit-log')).body[0]).toMatchObject({ action: 'login_failed', entity: 'auth' });
  });

  it('записывает кадровую операцию', async () => {
    const moved = await api('POST', '/api/movements/apply', {
      employeeId: '1', type: 'transfer', date: '2026-04-01', toPosition: 'Тимлид', toDepartment: 'IT', toSalary: 700000,
    });
    expect(moved.status).toBe(200);

    const [latest] = (await api('GET', '/api/audit-log')).body;
    expect(latest).toMatchObject({ action: 'movement', entity: 'employees', entityId: '1' });

    await api('DELETE', `/api/movements/${moved.body.id}`);
  });
});
