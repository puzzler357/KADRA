// Первой строкой: модуль подменяет DB_PATH до загрузки серверных модулей.
import './noPasswordDbPath';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, startApi, stopApi } from './helpers';

// Приложение не требует ни учётной записи, ни пароля: открывается сразу.
// Файл идёт по всему пути — от пустой базы до заведённого владельца, потом
// пароль, потом снятие пароля, — потому что состояния переходят одно в
// другое и по отдельности проверять их бессмысленно.
//
// Работает на собственной базе (см. noPasswordDbPath.ts): владельца здесь
// сначала нет, а общая база тестов засеяна владельцем с паролем.

const EMAIL = 'nopass@example.com';
const PASSWORD = 'first-password-123';

beforeAll(startApi);
afterAll(stopApi);

describe('работа без учётной записи', () => {
  it('на пустой базе владельца нет и пароля тоже', async () => {
    const { status, body } = await api('GET', '/api/auth/status');

    expect(status).toBe(200);
    expect(body.hasOwner).toBe(false);
    expect(body.hasPassword).toBe(false);
  });

  it('владельца нет — отдаётся null, а не ошибка', async () => {
    const { status, body } = await api('GET', '/api/auth/owner');

    expect(status).toBe(200);
    expect(body.user).toBeNull();
  });

  // Пустой хэш не должен оказаться «паролем, который подходит всем».
  it.each([
    ['пустой пароль', ''],
    ['произвольная строка', 'что угодно'],
  ])('войти по паролю нельзя: %s', async (_name, password) => {
    const { status } = await api('POST', '/api/auth/login', { email: EMAIL, password });

    expect(status).toBe(401);
  });

  it('данные чистятся без подтверждения паролем — подтверждать нечем', async () => {
    const { status, body } = await api('POST', '/api/reset/tables', { tables: ['candidates'] });

    expect(status).toBe(200);
    expect(body.cleared).toEqual(['candidates']);
  });
});

describe('заведение учётной записи', () => {
  it('создаётся без пароля и сразу выдаёт токен', async () => {
    const { status, body } = await api('POST', '/api/auth/owner', {
      name: 'Владелец Без Пароля',
      email: EMAIL,
    });

    expect(status).toBe(200);
    expect(body.user.email).toBe(EMAIL);
    expect(body.user.password_hash).toBeUndefined();
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('теперь владелец есть, а пароля по-прежнему нет', async () => {
    const { body } = await api('GET', '/api/auth/status');

    expect(body.hasOwner).toBe(true);
    expect(body.hasPassword).toBe(false);
  });

  it('открывает приложение без ввода пароля', async () => {
    const { status, body } = await api('GET', '/api/auth/owner');

    expect(status).toBe(200);
    expect(body.user.email).toBe(EMAIL);
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('достаточно одного имени — email необязателен', async () => {
    const { status, body } = await api('POST', '/api/auth/owner', { name: 'Только Имя' });

    expect(status).toBe(200);
    expect(body.user.name).toBe('Только Имя');

    // Возвращаем email: дальше по файлу он нужен для пароля.
    await api('POST', '/api/auth/owner', { name: 'Владелец Без Пароля', email: EMAIL });
  });
});

describe('пароль появляется и снимается', () => {
  it('задаётся без ввода текущего — его ещё нет', async () => {
    const { status } = await api('POST', '/api/auth/change-password', {
      email: EMAIL,
      currentPassword: '',
      newPassword: PASSWORD,
    });

    expect(status).toBe(200);
    expect((await api('GET', '/api/auth/status')).body.hasPassword).toBe(true);
  });

  it('вход по нему работает, по чужому — нет', async () => {
    expect((await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(200);
    expect((await api('POST', '/api/auth/login', { email: EMAIL, password: 'wrong' })).status).toBe(401);
  });

  it('очистка модулей снова требует пароль', async () => {
    expect((await api('POST', '/api/reset/tables', { tables: ['candidates'] })).status).toBe(401);
    expect((await api('POST', '/api/reset/tables', {
      adminPassword: PASSWORD, tables: ['candidates'],
    })).status).toBe(200);
  });

  it('снять пароль чужим паролем нельзя', async () => {
    const { status } = await api('POST', '/api/auth/remove-password', {
      email: EMAIL,
      currentPassword: 'not-my-password',
    });

    expect(status).toBe(401);
    expect((await api('GET', '/api/auth/status')).body.hasPassword).toBe(true);
  });

  it('снимается своим паролем, и всё возвращается к исходному', async () => {
    const { status } = await api('POST', '/api/auth/remove-password', {
      email: EMAIL,
      currentPassword: PASSWORD,
    });

    expect(status).toBe(200);

    const after = (await api('GET', '/api/auth/status')).body;
    expect(after.hasOwner).toBe(true);
    expect(after.hasPassword).toBe(false);

    // Учётная запись цела, вход по снятому паролю закрыт.
    expect((await api('GET', '/api/auth/owner')).body.user.email).toBe(EMAIL);
    expect((await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(401);
  });
});
