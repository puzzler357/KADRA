import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../../src/lib/id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe('newId', () => {
  it('выдаёт UUID v4 и не повторяется на объёме импорта', () => {
    const ids = Array.from({ length: 10_000 }, newId);
    expect(ids.every((id) => UUID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('без randomUUID (страница открыта не по localhost) собирает UUID сам', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });

    const ids = Array.from({ length: 1000 }, newId);
    expect(ids.every((id) => UUID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
