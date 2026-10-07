import { test, expect } from '@playwright/test';
import { OWNER_EMAIL } from './owner';

// Эти тесты идут без сохранённой сессии. Владелец к этому моменту уже создан
// проектом setup.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Включает запрос пароля при входе до загрузки приложения.
 *
 * Пароль выключен по умолчанию, поэтому без этой подготовки экрана входа не
 * будет вовсе: приложение само подставит владельца. zustand persist кладёт
 * настройки в localStorage и мержит их поверх значений по умолчанию, так что
 * одного ключа достаточно.
 */
async function enablePasswordGate(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'hr-docs-app-storage',
      JSON.stringify({ state: { requirePassword: true }, version: 0 }),
    );
  });
}

test.describe('вход без пароля (по умолчанию)', () => {
  test('приложение открывается сразу, без формы входа', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('#password')).toHaveCount(0);
  });
});

test.describe('экран входа, когда пароль включён', () => {
  test.beforeEach(({ page }) => enablePasswordGate(page));

  test('без сессии показывается форма входа, а не приложение', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('main')).toHaveCount(0);
  });

  test('экран входа не подсказывает учётные данные', async ({ page }) => {
    await page.goto('/');

    // Раньше здесь были предзаполненные admin@global.tech / password123
    // и строка «Вход владельца: …» прямо на боевом экране.
    await expect(page.locator('#email')).toHaveValue('');
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

    await page.locator('#email').fill(OWNER_EMAIL);
    await page.locator('#password').fill('definitely-wrong');
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByText(/Неверный/i)).toBeVisible();
    await expect(page.locator('main')).toHaveCount(0);
  });
});
