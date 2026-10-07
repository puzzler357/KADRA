import { defineConfig, devices } from '@playwright/test';
import { rmSync } from 'node:fs';
import { artifactsDir, e2eDbPath, reportDir, storageStatePath } from './tests/e2e/paths';

const PORT = Number(process.env.E2E_PORT) || 3210;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Каждый прогон стартует с чистой базы, засеянной значениями по умолчанию,
// чтобы e2e никогда не трогали рабочую local-hr-docs.db.
//
// Только в главном процессе: конфиг заново читает и каждый воркер, уже после
// старта сервера. На Windows занятый файл не удаляется, а на Linux удаление
// проходит, и сервер остаётся с отвязанной базой («readonly database»).
const isWorker = process.env.TEST_WORKER_INDEX !== undefined;
for (const suffix of isWorker ? [] : ['', '-wal', '-shm']) {
  try {
    rmSync(e2eDbPath + suffix, { force: true });
  } catch {
    // Файл занят ещё живущим сервером — сервер всё равно поднимется заново.
  }
}

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: artifactsDir,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: reportDir, open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    locale: 'ru-RU',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: storageStatePath },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'node node_modules/tsx/dist/cli.mjs server.ts',
    url: `${BASE_URL}/api/employees`,
    env: {
      PORT: String(PORT),
      DB_PATH: e2eDbPath,
      JWT_SECRET: 'e2e-secret',
      // Без HMR: его WebSocket шумит в консоли и мешает дождаться networkidle.
      DISABLE_HMR: 'true',
    },
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
