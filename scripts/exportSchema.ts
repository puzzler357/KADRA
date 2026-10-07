/**
 * Пересобирает src-tauri/schema.json из schema.ts, entities.ts и seedData.ts.
 *
 *   npm run schema:export
 *
 * Запускать после любой правки схемы или посева: оболочка Tauri читает
 * миграции из этого файла (include_str!), а не из TypeScript.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopSchemaJson } from '../src/data/desktopSchema';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src-tauri', 'schema.json');

fs.writeFileSync(target, desktopSchemaJson());
console.log(`Записано: ${path.relative(root, target)}`);
