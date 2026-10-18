/**
 * Ошибки слоя данных с кодом.
 *
 * Сервер и нативная ветка раньше отвечали готовой русской фразой, и она так и
 * показывалась пользователю — в том числе в английском и туркменском
 * интерфейсе. Теперь у ошибки есть код, а текст берётся из локализации на
 * выбранном языке. Русская фраза остаётся запасным вариантом: незнакомый код
 * лучше показать по-русски, чем пустым сообщением.
 */
import i18n from '../i18n';

export class ApiError extends Error {
  readonly code: string;
  /** Подробности для подстановки в текст: например, count — сколько мешает. */
  readonly params: Record<string, unknown>;

  constructor(code: string, fallback?: string, params: Record<string, unknown> = {}) {
    super(i18n.t(`errors.${code}`, { ...params, defaultValue: fallback || code }));
    this.name = 'ApiError';
    this.code = code;
    this.params = params;
  }
}

export const apiError = (code: string, fallback?: string, params?: Record<string, unknown>): ApiError =>
  new ApiError(code, fallback, params);

export const isApiError = (error: unknown, code?: string): error is ApiError =>
  error instanceof ApiError && (code === undefined || error.code === code);
