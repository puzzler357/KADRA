// Идентификаторы новых записей.
//
// Раньше здесь был Math.random().toString(36).substring(7) — пять-шесть
// символов. При импорте 10 000 сотрудников (целевой объём) совпадение двух
// таких ID вполне вероятно, а вторая запись с тем же ID роняет вставку.
// UUID v4 — 122 случайных бита из криптографического генератора.
//
// randomUUID есть только в «безопасном контексте» (https или localhost);
// если страницу открыли по адресу в сети, собираем тот же UUID из
// getRandomValues, который доступен везде.

export function newId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();

  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // версия 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // вариант RFC 4122
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
