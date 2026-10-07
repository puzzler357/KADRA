import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '..', '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

/**
 * Лицензия выпускается на версию (max_version), а версию приложения
 * сообщает оболочка из Cargo.toml. Три разных числа в трёх файлах значили бы,
 * что продавец и программа говорят о разных версиях.
 */
describe('версия приложения', () => {
  it('одна и та же в package.json, tauri.conf.json и Cargo.toml', () => {
    const npm = JSON.parse(read('package.json')).version;
    const tauri = JSON.parse(read('src-tauri/tauri.conf.json')).version;
    const cargo = read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    expect(tauri).toBe(npm);
    expect(cargo).toBe(npm);
  });
});
