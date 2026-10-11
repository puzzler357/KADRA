import { test, expect } from '@playwright/test';
import { ROUTES, ROOT_REDIRECT } from './routes';
import { describeProblems, hasProblems, watchForProblems } from './pageWatcher';

test.describe('обход всех страниц приложения', () => {
  test(`корень редиректит на ${ROOT_REDIRECT.to}`, async ({ page }) => {
    await page.goto(ROOT_REDIRECT.from);
    await expect(page).toHaveURL(new RegExp(`${ROOT_REDIRECT.to}$`));
  });

  for (const { path, title } of ROUTES) {
    test(`${path} — ${title}: открывается без ошибок`, async ({ page }) => {
      const problems = watchForProblems(page);

      await page.goto(path);

      // Страница действительно отрисовалась внутри Layout, а не осталась пустой.
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('nav')).toBeVisible();

      // Экраны грузятся по требованию (React.lazy в App.tsx): main появляется
      // раньше, чем пришёл файл экрана, поэтому ждём текст, а не читаем сразу.
      await expect
        .poll(async () => (await page.locator('main').innerText()).trim().length, {
          message: `Страница ${path} отрисовала пустой main`,
        })
        .toBeGreaterThan(0);

      // Даём догрузиться запросам к /api, которые страница делает при монтировании.
      await page.waitForLoadState('networkidle');

      expect(hasProblems(problems), `Проблемы на ${path}:\n${describeProblems(problems)}`).toBe(false);
    });
  }
});

test.describe('навигация по боковому меню', () => {
  test('все пункты меню ведут на рабочие страницы', async ({ page }) => {
    const problems = watchForProblems(page);

    await page.goto('/dashboard');
    await expect(page.locator('nav')).toBeVisible();

    const links = page.locator('nav a[href]');
    const count = await links.count();
    expect(count, 'В боковом меню не найдено ни одной ссылки').toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute('href');
      if (!href || href.startsWith('http')) continue;

      await links.nth(i).click();
      await expect(page).toHaveURL(new RegExp(`${href.replace(/\//g, '\\/')}$`));
      await expect(page.locator('main')).toBeVisible();
    }

    await page.waitForLoadState('networkidle');
    expect(hasProblems(problems), `Проблемы при навигации:\n${describeProblems(problems)}`).toBe(false);
  });
});
