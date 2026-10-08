import path from 'node:path';

/**
 * Отдельная база для сценария «владелец без пароля».
 *
 * Общая база тестов засевается владельцем с паролем (ensureOwner), а здесь
 * нужен ровно обратный случай, и создать владельца можно только один раз за
 * жизнь файла БД. Вдобавок файл чистит таблицы через /api/reset/tables.
 *
 * Модуль импортируется первой строкой noPassword.test.ts: значение должно
 * попасть в окружение до загрузки server.ts, который тянет src/db/sqlite.ts,
 * читающий DB_PATH на этапе импорта.
 */
export const NO_PASSWORD_DB_PATH = path.join(__dirname, '..', '.tmp', 'api-nopassword-test.db');

process.env.DB_PATH = NO_PASSWORD_DB_PATH;
