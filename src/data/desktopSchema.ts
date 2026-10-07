/**
 * Схема и посев для нативного приложения — в виде, который читает Rust.
 *
 * В десктопной сборке базу открывает оболочка Tauri (src-tauri/src/db/), и
 * она же применяет миграции и делает первичный посев: до того, как известен
 * режим лицензии, и в обход охраны записи. Иначе режим «только чтение» не
 * открыл бы даже пустую базу (TZ.md, раздел о лицензировании).
 *
 * Источник истины остаётся один — schema.ts, entities.ts и seedData.ts.
 * Отсюда собирается src-tauri/schema.json (npm run schema:export), а тест
 * tests/unit/desktopSchema.test.ts падает, если файл забыли пересобрать
 * после правки схемы. Веб-режим по-прежнему применяет те же миграции сам.
 */
import { ENTITIES } from './entities';
import { MIGRATIONS, MIGRATIONS_TABLE_SQL, LATEST_VERSION } from './schema';
import type { MigrationStep } from './schema';
import { CORE_SEED, seedValues } from './seedData';

export interface DesktopSchema {
  latest: number;
  migrationsTableSql: string;
  migrations: { version: number; name: string; steps: MigrationStep[] }[];
  seed: {
    /** Ключ в таблице meta: посев выполняется один раз за жизнь базы. */
    flag: string;
    batches: { sql: string; rows: unknown[][] }[];
  };
}

export const SEED_FLAG = 'seeded';

export function desktopSchema(): DesktopSchema {
  const entityBatches = ENTITIES.map((entity) => seedValues(entity.table)).filter(
    (batch): batch is { sql: string; rows: unknown[][] } => batch !== null,
  );

  return {
    latest: LATEST_VERSION,
    migrationsTableSql: MIGRATIONS_TABLE_SQL,
    migrations: MIGRATIONS.map(({ version, name, steps }) => ({ version, name, steps })),
    seed: {
      flag: SEED_FLAG,
      batches: [...CORE_SEED, ...entityBatches],
    },
  };
}

/** Текст src-tauri/schema.json ровно в том виде, в каком он лежит в репозитории. */
export function desktopSchemaJson(): string {
  return `${JSON.stringify(desktopSchema(), null, 2)}\n`;
}
