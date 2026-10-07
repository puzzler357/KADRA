import { beforeEach, describe, expect, it, vi } from 'vitest';

// Слой данных подменён: проверяется только, дойдёт ли правка до него.
vi.mock('../../src/data', () => ({
  isTauri: false,
  updateEntity: vi.fn(async () => undefined),
  createEntity: vi.fn(async () => ({ id: 'new' })),
  deleteEmployee: vi.fn(async () => undefined),
  applyMovement: vi.fn(async () => ({ movement: {}, employeePatch: {} })),
}));

import * as api from '../../src/data';
import { useDatabaseStore, TABLES } from '../../src/store/useDatabaseStore';
import { useLicenseStore } from '../../src/store/useLicenseStore';
import type { LicenseStatus } from '../../src/store/useLicenseStore';
import { ReadOnlyError, isReadOnlyError } from '../../src/data/shellDb';

const readOnly = { ...(useLicenseStore.getState().status as LicenseStatus), state: 'EXPIRED', mode: 'READ_ONLY' } as LicenseStatus;

describe('режим «только чтение» в интерфейсе', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLicenseStore.setState({ status: readOnly });
  });

  it('правка не уходит в базу и не меняет стор', async () => {
    useDatabaseStore.setState({ candidates: [{ id: 'c1', fullName: 'Было' } as never] });
    await useDatabaseStore.getState().updateIn(TABLES.candidates, 'c1', { fullName: 'Стало' });
    expect(api.updateEntity).not.toHaveBeenCalled();
    expect((useDatabaseStore.getState().candidates[0] as { fullName: string }).fullName).toBe('Было');
  });

  it('создание и кадровая операция отклоняются понятной ошибкой', async () => {
    await expect(useDatabaseStore.getState().createIn(TABLES.candidates, { fullName: 'x' } as never)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(useDatabaseStore.getState().applyMovement({} as never)).rejects.toBeInstanceOf(ReadOnlyError);
    expect(api.createEntity).not.toHaveBeenCalled();
  });

  it('запись журнала об оформлении молча пропускается', async () => {
    await expect(useDatabaseStore.getState().createIn(TABLES.auditLog, { ts: 'x' } as never)).resolves.toBe('');
    expect(api.createEntity).not.toHaveBeenCalled();
  });

  it('при действующей лицензии правка проходит', async () => {
    useLicenseStore.setState({ status: { ...readOnly, state: 'ACTIVE', mode: 'FULL' } });
    await useDatabaseStore.getState().deleteEmployee('e1');
    expect(api.deleteEmployee).toHaveBeenCalledWith('e1');
  });

  it('отказ оболочки READ_ONLY распознаётся', () => {
    expect(isReadOnlyError('READ_ONLY: the database is read-only in the current licence mode')).toBe(true);
    expect(isReadOnlyError(new ReadOnlyError())).toBe(true);
    expect(isReadOnlyError(new Error('no such table'))).toBe(false);
  });
});
