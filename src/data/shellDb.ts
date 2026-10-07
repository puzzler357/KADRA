/**
 * Доступ к базе в нативном приложении — через команды оболочки Tauri.
 *
 * Раньше окно держало собственное соединение через @tauri-apps/plugin-sql, и
 * режим «только чтение» был бы лишь вежливой просьбой: изменённый скрипт
 * писал бы в базу напрямую. Теперь соединение одно и живёт в Rust
 * (src-tauri/src/db/), а каждая команда проходит охрану guard.rs, которая
 * сверяется с режимом лицензии. Здесь только тонкая обёртка с тем же
 * интерфейсом select/execute, что был у плагина, плюс пакетная транзакция.
 *
 * Схему и первичный посев применяет оболочка при открытии базы
 * (src-tauri/src/db/schema.rs) — окно их больше не выполняет.
 */
import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n';

/** Запись отклонена: лицензия в режиме «только чтение». */
export class ReadOnlyError extends Error {
  constructor(message = i18n.t('license.readOnlyError')) {
    super(message);
    this.name = 'ReadOnlyError';
  }
}

export const isReadOnlyError = (error: unknown): boolean =>
  error instanceof ReadOnlyError || (typeof error === 'string' && error.startsWith('READ_ONLY'));

/** Команды отвечают отказом в виде строки; READ_ONLY превращается в понятную ошибку. */
function toError(error: unknown): Error {
  if (isReadOnlyError(error)) return new ReadOnlyError();
  return error instanceof Error ? error : new Error(String(error));
}

export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

export class ShellDb {
  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    try {
      return await invoke<T>('db_select', { sql, params });
    } catch (error) {
      throw toError(error);
    }
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    try {
      await invoke('db_execute', { sql, params });
    } catch (error) {
      throw toError(error);
    }
  }

  /** Несколько записей одним целым: все или ни одной. */
  async transaction(statements: SqlStatement[]): Promise<void> {
    if (statements.length === 0) return;
    try {
      await invoke('db_transaction', {
        statements: statements.map(({ sql, params }) => ({ sql, params: params ?? [] })),
      });
    } catch (error) {
      throw toError(error);
    }
  }
}

export const shellDb = new ShellDb();
