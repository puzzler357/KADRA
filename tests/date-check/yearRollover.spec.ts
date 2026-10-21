import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Интерфейс на стыке годов. Часы браузера подменяются (page.clock),
 * часовой пояс — Ашхабад. Каждый тест печатает наблюдения в консоль.
 */
test.use({ timezoneId: 'Asia/Ashgabat' });
const SHOTS = 'tests/.tmp/date-check-shots';
mkdirSync(SHOTS, { recursive: true });

const T = (s: string) => new Date(`${s}+05:00`);
async function openAt(page: Page, time: string, path: string) {
  await page.clock.install({ time: T(time) });
  await page.goto(path);
  await expect(page.locator('main')).toBeVisible();
  await page.waitForLoadState('networkidle');
}
const log = (...a: unknown[]) => console.log('  ▸', ...a);

async function putEmployee(request: APIRequestContext, id: string, body: object) {
  const r = await request.put(`/api/employees/${id}`, { data: body });
  expect(r.ok()).toBeTruthy();
}

test('Архив: «Закрыть месяц из табеля» 10 января 2027 (ДТ-01)', async ({ page }) => {
  await openAt(page, '2027-01-10T10:00:00', '/archive');
  await page.getByRole('button', { name: 'Закрыть месяц из табеля' }).click();
  const month = await page.locator('#close-month option:checked').textContent();
  const year = await page.locator('#close-year').inputValue();
  log('предложено по умолчанию:', month, year);
  expect(month).toBe('Декабрь');
  expect(year).toBe('2026');
  await page.screenshot({ path: `${SHOTS}/archive-default.png` });

  // Декабрь 2026 закончился — обычный вопрос без предупреждения
  await page.getByRole('button', { name: 'Перенести в архив' }).click();
  await expect(page.getByText('Перенести в архив Декабрь 2026?')).toBeVisible();
  await page.getByRole('button', { name: 'Отмена' }).last().click();

  // Незаконченный январь 2027 — сначала предупреждение
  await page.locator('#close-month').selectOption({ label: 'Январь' });
  await page.locator('#close-year').fill('2027');
  await page.getByRole('button', { name: 'Перенести в архив' }).click();
  const warn = page.getByText(/Январь 2027 ещё не закончился/);
  await expect(warn).toBeVisible();
  log('январь 2027:', await warn.textContent());
  await page.screenshot({ path: `${SHOTS}/archive-not-ended.png` });
  await page.getByRole('button', { name: 'Отмена' }).last().click();
  const rows = await (await page.request.get('/api/archives?year=2027')).json();
  log('в архиве за 2027 год строк:', rows.length);
  expect(rows).toHaveLength(0);
});

test('Календарь: январские события видны в декабре (ДТ-02)', async ({ page, request }) => {
  await putEmployee(request, '1', { birthDate: '1990-01-03' }); // Иванов — ДР 3 января
  await openAt(page, '2026-12-15T10:00:00', '/calendar');
  const panel = page.getByRole('heading', { name: 'Предстоящие события' }).locator('..');
  const text = (await panel.innerText()).replace(/\s+/g, ' ');
  log('15.12.2026 предстоящие:', text.slice(0, 300));
  expect(text).toContain('Аманмурадов'); // годовщина 10.01
  expect(text).toContain('Иванов'); // ДР 03.01
  await page.screenshot({ path: `${SHOTS}/calendar-dec15.png`, fullPage: true });

  // Сетка декабря, когда «Предстоящие» январь ещё не захватывают (сегодня 01.10)
  const p2 = await page.context().newPage();
  await openAt(p2, '2026-10-01T10:00:00', '/calendar');
  await p2.getByRole('button', { name: 'Следующий месяц' }).click();
  await p2.getByRole('button', { name: 'Следующий месяц' }).click();
  await expect(p2.getByTestId('calendar-month')).toHaveText('Декабрь 2026');
  const upcoming2 = await p2.getByRole('heading', { name: 'Предстоящие события' }).locator('..').innerText();
  const grid = await p2.locator('main').innerText();
  log('сетка декабря: ДР 03.01 в хвосте недели виден:', grid.includes('Иванов') && !upcoming2.includes('Иванов'));
  expect(upcoming2).not.toContain('Иванов');
  expect(grid).toContain('Иванов');
  await p2.screenshot({ path: `${SHOTS}/calendar-dec-grid.png`, fullPage: true });
  await p2.close();
});

test('Отпуска: отпуск через Новый год и остаток (ДТ-03, ДТ-04)', async ({ page, request }) => {
  const created = await request.post('/api/time-off', {
    data: { employeeId: '4', type: 'vacation', dateFrom: '2026-12-25', dateTo: '2027-01-14', days: 21, status: 'approved' },
  });
  expect(created.ok()).toBeTruthy();

  const balanceOf = async (p: Page) => {
    const card = p.getByText(/Отпуск в \d{4} году/).locator('xpath=ancestor::div[2]');
    await card.locator('select').selectOption({ label: 'Аманмурадов Мердан' });
    const title = await p.getByText(/Отпуск в \d{4} году/).textContent();
    const figures = (await p.getByTestId('vacation-left').locator('xpath=ancestor::div[2]').innerText()).replace(/\s+/g, ' ');
    log(title, figures);
    return { title, left: await p.getByTestId('vacation-left').textContent() };
  };

  await openAt(page, '2026-12-31T23:59:00', '/timeoff');
  expect(await balanceOf(page)).toEqual({ title: 'Отпуск в 2026 году', left: '17' });
  await page.screenshot({ path: `${SHOTS}/timeoff-dec31.png` });

  const p2 = await page.context().newPage();
  await openAt(p2, '2027-01-01T00:01:00', '/timeoff');
  expect(await balanceOf(p2)).toEqual({ title: 'Отпуск в 2027 году', left: '10' });
  await p2.screenshot({ path: `${SHOTS}/timeoff-jan01.png` });
  await p2.close();

  // Декабрь: заявка на январь, когда норма 2026 года уже выбрана
  await request.post('/api/time-off', {
    data: { employeeId: '2', type: 'vacation', dateFrom: '2026-06-01', dateTo: '2026-06-24', days: 24, status: 'approved' },
  });
  const p3 = await page.context().newPage();
  await openAt(p3, '2026-12-10T10:00:00', '/timeoff');
  await p3.getByRole('button', { name: 'Подать заявку' }).click();
  await p3.locator('#to-employee').selectOption({ label: 'Петров Петр Петрович' });
  await p3.locator('#to-from').fill('2027-01-11');
  await p3.locator('#to-to').fill('2027-01-20');
  await expect(p3.getByText('остаток на 2027 год: 24 дн.')).toBeVisible();
  await expect(p3.getByText(/больше дней, чем осталось/)).toHaveCount(0);
  log('10.12.2026, заявка Петрова на 11–20.01.2027: предупреждения нет, остаток на 2027 год 24');

  // Заявка через Новый год: предупреждение только про 2026 год
  await p3.locator('#to-from').fill('2026-12-28');
  await p3.locator('#to-to').fill('2027-01-05');
  const warn = p3.getByText(/больше дней, чем осталось/);
  await expect(warn).toHaveCount(1);
  log('заявка 28.12–05.01:', await warn.textContent());
  await expect(warn).toContainText('На 2026 год');
  await p3.screenshot({ path: `${SHOTS}/timeoff-dec-request-jan.png` });
  await p3.close();
});

test('Дашборд: день рождения 1 января и приложение, открытое через полночь', async ({ page, request }) => {
  await putEmployee(request, '2', { birthDate: '1985-01-01' }); // Петров — ДР 1 января
  await openAt(page, '2027-01-01T00:10:00', '/dashboard');
  const bday = (p: Page) => p.getByRole('heading', { name: 'Дни рождения сегодня' }).locator('xpath=ancestor::div[2]').innerText();
  log('01.01.2027 00:10 — Петров среди именинников:', (await bday(page)).includes('Петров'));
  await page.screenshot({ path: `${SHOTS}/dashboard-jan01.png`, fullPage: true });

  const p2 = await page.context().newPage();
  await openAt(p2, '2026-12-31T23:58:00', '/dashboard');
  const before = (await bday(p2)).includes('Петров');
  await p2.clock.runFor('05:00'); // часы идут 5 минут, страница не перезагружается
  await p2.waitForTimeout(500);
  const after = (await bday(p2)).includes('Петров');
  log('открыт в 23:58, через 5 минут (00:03) Петров появился:', before, '→', after);
  // переход по меню (без перезагрузки)
  await p2.getByRole('link', { name: 'Сотрудники' }).first().click();
  await p2.getByRole('link', { name: 'Главная' }).first().click();
  await p2.waitForTimeout(500);
  log('после перехода по меню и обратно:', (await bday(p2)).includes('Петров'));
  await p2.screenshot({ path: `${SHOTS}/dashboard-overnight.png`, fullPage: true });
  await p2.close();
});

test('Табель: январь 2027, 1 января', async ({ page }) => {
  await openAt(page, '2027-01-01T09:00:00', '/timesheet');
  log('заголовок месяца:', (await page.locator('main').innerText()).match(/Январь \d{4}|январь \d{4}/i)?.[0]);
  await page.screenshot({ path: `${SHOTS}/timesheet-jan2027.png`, fullPage: false });
  await page.getByRole('button', { name: /Предыдущий месяц|предыдущ/i }).first().click().catch(() => {});
  await page.waitForLoadState('networkidle');
  log('после «назад»:', (await page.locator('main').innerText()).match(/Декабрь \d{4}/i)?.[0]);
});

test('Отчёты и оценка 1 января 2027', async ({ page }) => {
  await openAt(page, '2027-01-01T03:00:00', '/performance');
  const sel = page.locator('select[aria-label="Период"]').first();
  log('оценка: период по умолчанию:', await sel.locator('option:checked').textContent());
  await page.screenshot({ path: `${SHOTS}/performance-jan01.png` });
});
