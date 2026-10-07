import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, startApi, stopApi, ensureOwner, OWNER_EMAIL, OWNER_PASSWORD } from './helpers';

const EMAIL = OWNER_EMAIL;
const PASSWORD = OWNER_PASSWORD;

beforeAll(async () => {
  await startApi();
  await ensureOwner();
});
afterAll(stopApi);

describe('POST /api/auth/login', () => {
  it('пускает владельца с корректными данными и выдаёт JWT', async () => {
    const { status, body } = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });

    expect(status).toBe(200);
    expect(body.user).toMatchObject({ email: EMAIL, role: 'ADMIN' });
    expect(body.user.password_hash).toBeUndefined();
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('отклоняет неверный пароль', async () => {
    const { status, body } = await api('POST', '/api/auth/login', { email: EMAIL, password: 'wrong' });

    expect(status).toBe(401);
    expect(body.error).toBeTruthy();
  });

  it('отклоняет несуществующего пользователя', async () => {
    const { status } = await api('POST', '/api/auth/login', { email: 'nobody@example.com', password: PASSWORD });

    expect(status).toBe(401);
  });
});

describe('GET /api/auth/owner', () => {
  it('отдаёт владельца без пароля — для входа, когда пароль при входе выключен', async () => {
    const { status, body } = await api('GET', '/api/auth/owner');

    expect(status).toBe(200);
    expect(body.user).toMatchObject({ email: EMAIL, role: 'ADMIN' });
    expect(body.user.password_hash).toBeUndefined();
    expect(typeof body.token).toBe('string');
  });
});

describe('POST /api/auth/change-password', () => {
  it('меняет пароль и старый перестаёт работать', async () => {
    const temp = 'temp-password-999';

    const changed = await api('POST', '/api/auth/change-password', {
      email: EMAIL,
      currentPassword: PASSWORD,
      newPassword: temp,
    });
    expect(changed.status).toBe(200);

    expect((await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { email: EMAIL, password: temp })).status).toBe(200);

    // Возвращаем исходный пароль, чтобы база осталась пригодной для остальных тестов.
    const restored = await api('POST', '/api/auth/change-password', {
      email: EMAIL,
      currentPassword: temp,
      newPassword: PASSWORD,
    });
    expect(restored.status).toBe(200);
    expect((await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it('не меняет пароль при неверном текущем', async () => {
    const { status } = await api('POST', '/api/auth/change-password', {
      email: EMAIL,
      currentPassword: 'not-my-password',
      newPassword: 'hacked',
    });

    expect(status).toBe(401);
    expect((await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(200);
  });
});
