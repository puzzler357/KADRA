import { test, expect } from '@playwright/test';

// Настройки интерфейса живут в localStorage и должны применяться при каждом
// запуске. Однажды восстановление обрывалось на ошибке в обработчике темы, и
// после перезапуска язык, акцент и плотность молча возвращались к исходным.
test('язык, акцент и плотность восстанавливаются при запуске', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('main')).toBeVisible();

  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('hr-docs-app-storage') ?? '{"state":{},"version":1}');
    raw.state = { ...raw.state, language: 'en', accentColor: 'emerald', density: 'compact', fontSize: 'large' };
    localStorage.setItem('hr-docs-app-storage', JSON.stringify(raw));
  });
  await page.reload();

  await expect(page.locator('nav')).toContainText('Employees');
  const html = await page.evaluate(() => ({ cls: document.documentElement.className, lang: document.documentElement.lang }));
  expect(html.lang).toBe('en');
  expect(html.cls).toContain('theme-emerald');
  expect(html.cls).toContain('density-compact');
  expect(html.cls).toContain('text-size-large');
});
