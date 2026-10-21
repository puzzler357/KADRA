/**
 * Проверка интерфейса на стыке годов (не входит в обычный test:e2e).
 * Запуск из корня проекта: npx playwright test -c tests/date-check/playwright.config.ts
 * Наблюдения печатаются в консоль (строки «▸»), снимки — в tests/.tmp/date-check-shots.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default defineConfig({
  ...base,
  testDir: '..',
  reporter: [['list']],
  projects: [
    { ...base.projects![0], testMatch: /e2e[\\/]auth\.setup\.ts/ },
    { ...base.projects![1], testIgnore: undefined, testMatch: /date-check[\\/]yearRollover\.spec\.ts/ },
  ],
  webServer: { ...(base.webServer as object), cwd: root } as any,
});
