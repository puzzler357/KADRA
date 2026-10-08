import { rmSync } from 'node:fs';
import path from 'node:path';

// Две базы: общая для тестов и отдельная для теста сброса системы —
// он чистит таблицы и не может их восстановить (см. resetDbPath.ts).
const testDbPaths = [
  path.join(__dirname, '..', '.tmp', 'api-test.db'),
  path.join(__dirname, '..', '.tmp', 'api-reset-test.db'),
  path.join(__dirname, '..', '.tmp', 'api-nopassword-test.db'),
];

// Каждый прогон стартует с чистой базы: sqlite.ts сам создаст таблицы и засеет данные.
//
// tolerant нужен только после прогона: на Windows файл БД держит ещё не
// закрытое соединение, и удаление падает с EBUSY. Перед прогоном ошибку,
// наоборот, глушить нельзя — уцелевшая база молча исказила бы тесты.
function wipe(tolerant = false) {
  for (const dbPath of testDbPaths) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(dbPath + suffix, { force: true });
      } catch (err) {
        if (!tolerant) throw err;
      }
    }
  }
}

export function setup() {
  wipe();
}

export function teardown() {
  wipe(true);
}
