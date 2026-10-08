// Первой строкой: модуль подменяет DB_PATH до загрузки серверных модулей.
import './noPasswordDbPath';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, startApi, stopApi } from './helpers';

// Приложение поставляется без пароля: на первом запуске он необязателен, и
// пустой password_hash означает «не задан». Файл проходит этот путь целиком —
// от создания владельца без пароля до установки первого пароля позже.
//
// Работает на собственной базе (см. noPasswordDbPath.ts): владелец создаётся
// один раз за жизнь файла БД, а общая база засеяна владельцем с паролем.

const EMAIL = 'nopass@example.com';

beforeAll(startApi);
afterAll(stopApi);

describe('владелец без пароля', () => {
  it('до настройки сообщает, что владельца нет', async () => {
    const { status, body } = await api('GET', '/api/auth/status');

    expect(status).toBe(200);
    expect(body.needsSetup).toBe(true);
    expect(body.hasPassword).toBe(false);
  });

  it('создаётся без пароля и сразу получает токен', async () => {
    const { status, body } = await api('POST', '/api/auth/setup', {
      name: 'Владелец Без Пароля',
      email: EMAIL,
    });

    expect(status).toBe(200);
    expect(body.user.email).toBe(EMAIL);
    expect(body.user.password_hash).toBeUndefined();
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('после настройки отмечен как владелец без пароля', async () => {
    const { body } = await api('GET', '/api/auth/status');

    expect(body.needsSetup).toBe(false);
    expect(body.hasPassword).toBe(false);
  });

  it('входит без ввода пароля — через владельца устройства', async () => {
    const { status, body } = await api('GET', '/api/auth/owner');

    expect(status).toBe(200);
    expect(body.user.email).toBe(EMAIL);
    expect(body.token.split('.')).toHaveLength(3);
  });

  // Пустой хэш не должен оказаться «паролем, который подходит всем»: вход по
  // паролю закрыт, пока пароль не задан, в том числе для пустой строки.
  it.each([
    ['пустой пароль', ''],
    ['произвольная строка', 'что угодно'],
  ])('не пускает по паролю: %s', async (_name, password) => {
    const { status } = await api('POST', '/api/auth/login', { email: EMAIL, password });

    expect(status).toBe(401);
  });

  it('чистит модули без подтверждения паролем — подтверждать нечем', async () => {
    const { status, body } = await api('POST', '/api/reset/tables', { tables: ['candidates'] });

    expect(status).toBe(200);
    expect(body.cleared).toEqual(['candidates']);
  });
});

describe('установка первого пароля', () => {
  const PASSWORD = 'first-password-123';

  it('задаётся без ввода текущего', async () => {
    const { status } = await api('POST', '/api/auth/change-password', {
      email: EMAIL,
      currentPassword: '',
      newPassword: PASSWORD,
    });

    expect(status).toBe(200);
  });

  it('после этого владелец отмечен как имеющий пароль', async () => {
    const { body } = await api('GET', '/api/auth/status');

    expect(body.hasPassword).toBe(true);
  });

  it('вход по новому паролю работает, по чужому — нет', async () => {
    expect((await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(200);
    expect((await api('POST', '/api/auth/login', { email: EMAIL, password: 'wrong' })).status).toBe(401);
  });

  it('очистка модулей снова требует пароль', async () => {
    expect((await api('POST', '/api/reset/tables', { tables: ['candidates'] })).status).toBe(401);
    expect((await api('POST', '/api/reset/tables', {
      adminPassword: PASSWORD, tables: ['candidates'],
    })).status).toBe(200);
  });
});
