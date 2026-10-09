import { test as setup, expect } from '@playwright/test';
import { storageStatePath } from './paths';

/**
 * Первый заход в приложение.
 *
 * Учётная запись приложению не нужна: на чистой базе оно открывается сразу —
 * ни экрана входа, ни создания владельца. Проходим это один раз и сохраняем
 * localStorage (zustand persist), чтобы остальные тесты стартовали из того
 * же состояния.
 */
setup('на чистой базе приложение открывается сразу', async ({ page }) => {
  await page.goto('/');

  // Рендерится Layout с боковым меню, а не форма.
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('nav')).toBeVisible();

  // Ни поля пароля, ни экрана заведения учётной записи на пути нет.
  await expect(page.locator('#password')).toHaveCount(0);

  await page.context().storageState({ path: storageStatePath });
});
