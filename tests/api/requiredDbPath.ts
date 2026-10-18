import path from 'node:path';

/**
 * Отдельная база для режима «пароль при входе обязателен».
 *
 * В этом режиме сервер отклоняет запросы без сессии, и общая база тестов
 * стала бы недоступна остальным файлам. Модуль импортируется первой строкой
 * passwordRequired.test.ts — до загрузки server.ts, читающего DB_PATH.
 */
export const REQUIRED_DB_PATH = path.join(__dirname, '..', '.tmp', 'api-required-test.db');

process.env.DB_PATH = REQUIRED_DB_PATH;
