import { request as httpRequest } from 'node:http';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, startApi, stopApi } from './helpers';

// Сервер отвечает только браузеру владельца: чужой сайт, открытый в том же
// браузере, и чужое доменное имя, указывающее на 127.0.0.1 (DNS rebinding),
// получают отказ. Проверяется на изменяющем запросе — именно такой страница
// с чужого сайта может отправить формой без всякого CORS.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let baseUrl = '';
let port = 0;

beforeAll(async () => {
  baseUrl = await startApi();
  port = Number(new URL(baseUrl).port);
});
afterAll(stopApi);

async function post(route: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(baseUrl + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

async function departmentNames(): Promise<string[]> {
  const { body } = await api<{ name: string }[]>('GET', '/api/departments');
  return body.map((d) => d.name);
}

/** Запрос с произвольным Host — fetch его подменить не даёт. */
function getWithHost(route: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: route, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once('error', reject);
    req.end();
  });
}

describe('запросы с чужих сайтов', () => {
  it('изменение с чужим Origin отклоняется и ничего не пишет', async () => {
    const name = 'Отдел от чужого сайта';
    const res = await post('/api/departments', { name }, { Origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect(await departmentNames()).not.toContain(name);
  });

  it('Origin «null» (локальный файл, песочница) отклоняется', async () => {
    const res = await post('/api/departments', { name: 'Из песочницы' }, { Origin: 'null' });
    expect(res.status).toBe(403);
  });

  it('браузерная пометка cross-site отклоняется даже без Origin', async () => {
    const res = await fetch(`${baseUrl}/api/employees`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(res.status).toBe(403);
  });

  it('сброс системы формой с чужого сайта не проходит', async () => {
    const before = await api<unknown[]>('GET', '/api/employees');
    const res = await post('/api/auth/reset-system', {}, { Origin: 'https://evil.example' });
    const after = await api<unknown[]>('GET', '/api/employees');

    expect(res.status).toBe(403);
    expect(after.body.length).toBe(before.body.length);
  });

  it('свой адрес и другой локальный порт пропускаются', async () => {
    const own = await post('/api/departments', { name: 'Свой отдел' }, { Origin: baseUrl });
    const otherPort = await post(
      '/api/departments',
      { name: 'Отдел с dev-порта' },
      { Origin: 'http://localhost:5173' },
    );

    expect(own.status).toBe(200);
    expect(otherPort.status).toBe(200);
  });

  it('ответы не разрешают чтение другим сайтам', async () => {
    const res = await fetch(`${baseUrl}/api/employees`, { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Host: защита от DNS rebinding', () => {
  it('чужое имя хоста отклоняется', async () => {
    expect(await getWithHost('/api/employees', `evil.example:${port}`)).toBe(403);
  });

  it('localhost и 127.0.0.1 проходят', async () => {
    expect(await getWithHost('/api/employees', `localhost:${port}`)).toBe(200);
    expect(await getWithHost('/api/employees', `127.0.0.1:${port}`)).toBe(200);
  });
});

describe('идентификаторы новых записей', () => {
  it('сервер выдаёт UUID, а не короткую случайную строку', async () => {
    const { body } = await api<{ id: string }>('POST', '/api/departments', { name: 'Отдел для проверки ID' });
    expect(body.id).toMatch(UUID);
  });

  it('массовый импорт не даёт совпадающих ID', async () => {
    const employees = Array.from({ length: 2000 }, (_, i) => ({
      fullName: `Импорт ${i}`,
      position: 'Тест',
      department: 'Тест',
      status: 'active',
      hireDate: '2026-01-01',
    }));
    const { status, body } = await api<{ ids: string[] }>('POST', '/api/employees/bulk', { employees });

    expect(status).toBe(200);
    expect(new Set(body.ids).size).toBe(employees.length);
    expect(body.ids.every((id) => UUID.test(id))).toBe(true);
  });
});
