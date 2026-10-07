import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopSchema, desktopSchemaJson } from '../../src/data/desktopSchema';
import { LATEST_VERSION } from '../../src/data/schema';

const file = path.join(__dirname, '..', '..', 'src-tauri', 'schema.json');

describe('src-tauri/schema.json', () => {
  // Rust применяет миграции из этого файла. Если схему поправили, а файл не
  // пересобрали, десктопная база молча разойдётся с веб-режимом.
  it('совпадает со схемой в TypeScript (npm run schema:export)', () => {
    expect(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(desktopSchemaJson());
  });

  it('содержит все миграции до последней и посев', () => {
    const schema = desktopSchema();
    expect(schema.latest).toBe(LATEST_VERSION);
    expect(schema.migrations.map((m) => m.version)).toEqual(
      Array.from({ length: LATEST_VERSION }, (_, i) => i + 1),
    );
    expect(schema.seed.batches.length).toBeGreaterThan(0);
    // Учётной записи владельца в посеве нет: её создают при первом запуске.
    expect(schema.seed.batches.some((b) => /INTO users\b/.test(b.sql))).toBe(false);
  });
});
