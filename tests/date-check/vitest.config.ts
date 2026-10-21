/**
 * Модульная проверка дат на стыке годов (не входит в обычный npm test).
 * Запуск из корня проекта: npx vitest run -c tests/date-check/vitest.config.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  test: {
    include: ['tests/date-check/**/*.test.ts'],
    environment: 'node',
    env: { TZ: 'Asia/Ashgabat' },
  },
});
