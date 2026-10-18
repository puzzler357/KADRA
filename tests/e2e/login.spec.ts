import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { OWNER_NAME, OWNER_PASSWORD } from './owner';

// Эти тесты идут без сохранённой сессии: каждое окно — как новый запуск.
test.use({ storageState: { cookies: [], origins: [] } });

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function sessionToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { password: OWNER_PASSWORD } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).token as string;
}

async function signIn(page: Page) {
  await page.goto('/dashboard');
  await page.locator('#password').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.locator('main')).toBeVisible();
}

test.describe('вход без пароля (по умолчанию)', () => {
  test('приложение открывается сразу, без формы входа', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('#password')).toHaveCount(0);
  });

  test('подмена настроек в браузере пароль не включает и не выключает', async ({ page }) => {
    // Раньше признак «запрашивать пароль» жил в localStorage (Д-02).
    await page.addInitScript(() => {
      localStorage.setItem('hr-docs-app-storage', JSON.stringify({ state: { requirePassword: true }, version: 0 }));
    });
    await page.goto('/dashboard');
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('#password')).toHaveCount(0);
  });
});

test.describe.serial('запрос пароля при входе включён', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    // Учётная запись только с именем, без email (Д-03), пароль — по желанию.
    expect((await api.post('/api/auth/owner', { data: { name: OWNER_NAME } })).ok()).toBeTruthy();
    expect((await api.post('/api/auth/change-password', { data: { currentPassword: '', newPassword: OWNER_PASSWORD } })).ok()).toBeTruthy();
    expect((await api.post('/api/auth/require-password', { data: { enabled: true } })).ok()).toBeTruthy();
  });

  test.afterAll(async () => {
    // Возвращаем базу к режиму по умолчанию для остальных тестов.
    const token = await sessionToken(api);
    await api.post('/api/auth/require-password', { data: { enabled: false }, headers: auth(token) });
    await api.post('/api/auth/remove-password', { data: { currentPassword: OWNER_PASSWORD }, headers: auth(token) });
    await api.dispose();
  });

  test('без сессии — экран входа: только пароль, без email', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#email')).toHaveCount(0);
    await expect(page.getByTestId('login-owner')).toContainText(OWNER_NAME);
    await expect(page.locator('main')).toHaveCount(0);
  });

  test('экран входа не подсказывает учётные данные', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#password')).toHaveValue('');
    await expect(page.getByText(/password123/i)).toHaveCount(0);
  });

  test('кнопка-глаз показывает набранный пароль и прячет обратно', async ({ page }) => {
    await page.goto('/');

    const password = page.locator('#password');
    await password.fill('не видно, что набрал');
    await expect(password).toHaveAttribute('type', 'password');

    await page.getByRole('button', { name: 'Показать пароль' }).click();
    await expect(password).toHaveAttribute('type', 'text');

    await page.getByRole('button', { name: 'Скрыть пароль' }).click();
    await expect(password).toHaveAttribute('type', 'password');
  });

  test('неверный пароль показывает ошибку и не пускает внутрь', async ({ page }) => {
    await page.goto('/');

    await page.locator('#password').fill('definitely-wrong');
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByRole('alert')).toContainText('Неверный пароль');
    await expect(page.locator('main')).toHaveCount(0);
  });

  test('верный пароль открывает приложение, F5 сессию не теряет', async ({ page }) => {
    await signIn(page);
    await page.reload();
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('#password')).toHaveCount(0);
  });

  test('«Выйти» возвращает к экрану входа', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('main')).toHaveCount(0);
  });

  test('новое окно снова спрашивает пароль (Д-01)', async ({ page, browser }) => {
    await signIn(page);
    const other = await browser.newContext({ storageState: await page.context().storageState() });
    const second = await other.newPage();
    await second.goto('/dashboard');
    await expect(second.locator('#password')).toBeVisible();
    await other.close();
  });

  test('API без сессии закрыт (Д-02)', async ({ request }) => {
    const res = await request.get('/api/employees');
    expect(res.status()).toBe(401);
  });
});
