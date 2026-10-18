// Первой строкой: модуль подменяет DB_PATH до загрузки серверных модулей.
import './requiredDbPath';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, startApi, stopApi } from './helpers';

// Пароль необязателен: приложение открывается сразу, пока владелец сам не
// включит запрос пароля. Включённый запрос раньше был только экраном поверх
// открытого API (Д-01, Д-02): признак лежал в браузере, а токен владельца
// выдавался без пароля. Теперь признак в базе, и сервер требует сессию.
// Файл идёт по всему пути, потому что состояния переходят одно в другое.

const PASSWORD = 'required-password-1';
let token = '';

beforeAll(async () => {
  await startApi();
  // Учётная запись только с именем — без email (Д-03).
  await api('POST', '/api/auth/owner', { name: 'Мерет Атаев' });
  await api('POST', '/api/auth/change-password', { currentPassword: '', newPassword: PASSWORD });
});
afterAll(stopApi);

describe('пароль задан, но запрос при входе выключен', () => {
  it('данные доступны без сессии — так и задумано по умолчанию', async () => {
    const { status } = await api('GET', '/api/employees');
    expect(status).toBe(200);
  });

  it('статус сообщает, что пароль есть, но не требуется', async () => {
    const { body } = await api('GET', '/api/auth/status');
    expect(body).toMatchObject({ hasOwner: true, hasPassword: true, requirePassword: false, ownerName: 'Мерет Атаев' });
  });
});

describe('запрос пароля при входе включён', () => {
  beforeAll(async () => {
    const { status } = await api('POST', '/api/auth/require-password', { enabled: true });
    expect(status).toBe(200);
  });

  it('без сессии данные не отдаются', async () => {
    const { status, body } = await api('GET', '/api/employees');
    expect(status).toBe(401);
    expect(body.code).toBe('auth.sessionRequired');
  });

  it('токен владельца без пароля больше не выдаётся', async () => {
    const { status } = await api('GET', '/api/auth/owner');
    expect(status).toBe(401);
  });

  it('статус открыт: экрану входа нужно знать, что спрашивать пароль', async () => {
    const { status, body } = await api('GET', '/api/auth/status');
    expect(status).toBe(200);
    expect(body).toMatchObject({ hasPassword: true, requirePassword: true, ownerName: 'Мерет Атаев' });
  });

  it('неверный пароль отклоняется с кодом ошибки', async () => {
    const { status, body } = await api('POST', '/api/auth/login', { password: 'wrong-password' });
    expect(status).toBe(401);
    expect(body.code).toBe('auth.invalid');
  });

  it('вход только по паролю — без email и логина', async () => {
    const { status, body } = await api('POST', '/api/auth/login', { password: PASSWORD });
    expect(status).toBe(200);
    expect(typeof body.token).toBe('string');
    token = body.token;
  });

  it('с сессией данные доступны', async () => {
    const { status } = await api('GET', '/api/employees', undefined, token);
    expect(status).toBe(200);
  });

  it('поддельный токен не проходит', async () => {
    const { status } = await api('GET', '/api/employees', undefined, `${token.slice(0, -4)}abcd`);
    expect(status).toBe(401);
  });

  it('очистка браузера не снимает запрос: признак хранится в базе', async () => {
    // «Новый профиль браузера» — это просто запрос без сессии.
    expect((await api('GET', '/api/departments')).status).toBe(401);
    expect((await api('POST', '/api/auth/require-password', { enabled: false })).status).toBe(401);
  });
});

describe('выключение запроса и снятие пароля', () => {
  it('выключить запрос можно только из сессии, после этого данные снова открыты', async () => {
    const { status } = await api('POST', '/api/auth/require-password', { enabled: false }, token);
    expect(status).toBe(200);
    expect((await api('GET', '/api/employees')).status).toBe(200);
  });

  it('снятие пароля выключает и запрос пароля', async () => {
    await api('POST', '/api/auth/require-password', { enabled: true }, token);
    const removed = await api('POST', '/api/auth/remove-password', { currentPassword: PASSWORD }, token);
    expect(removed.status).toBe(200);
    const { body } = await api('GET', '/api/auth/status');
    expect(body).toMatchObject({ hasPassword: false, requirePassword: false });
    expect((await api('GET', '/api/employees')).status).toBe(200);
  });

  it('без пароля полный сброс подтверждается без пароля — сброс работает', async () => {
    const { status } = await api('POST', '/api/auth/reset-system', {});
    expect(status).toBe(200);
    expect((await api('GET', '/api/employees')).body).toEqual([]);
    // Учётная запись переживает сброс.
    expect((await api('GET', '/api/auth/status')).body.hasOwner).toBe(true);
  });
});
