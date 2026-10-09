import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from '../../server';

let server: Server | null = null;
let baseUrl = '';

/** Поднимает Express-приложение на свободном порту (без vite-мидлвари). */
export async function startApi(): Promise<string> {
  if (server) return baseUrl;
  server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

export async function stopApi(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  baseUrl = '';
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Обёртка над fetch: возвращает статус и разобранное тело. */
export async function api<T = any>(
  method: Method,
  route: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  const res = await fetch(baseUrl + route, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* оставляем как текст */
  }
  return { status: res.status, body: parsed };
}

/**
 * Учётная запись владельца для тестов.
 *
 * Приложение работает и вовсе без учётной записи, а у заведённой пароля по
 * умолчанию нет — поэтому здесь два шага: создать владельца и отдельно
 * задать ему пароль. Проверкам пароль нужен: без него нечего отклонять.
 *
 * Функция идемпотентна и не зависит от порядка файлов: повторное сохранение
 * владельца правит ту же строку, а повторная установка пароля с пустым
 * текущим получает 401 и ничего не меняет.
 */
export const OWNER_EMAIL = 'owner@example.com';
export const OWNER_PASSWORD = 'test-owner-password';

export async function ensureOwner(): Promise<void> {
  await api('POST', '/api/auth/owner', {
    name: 'Владелец Устройства',
    email: OWNER_EMAIL,
  });
  await api('POST', '/api/auth/change-password', {
    email: OWNER_EMAIL,
    currentPassword: '',
    newPassword: OWNER_PASSWORD,
  });
}
