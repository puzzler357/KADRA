import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { api, startApi, stopApi } from './helpers';

// Проверки, которые раньше были только в интерфейсе или отсутствовали вовсе
// (Д-06, Д-33): сервер принимал ставку 2 и отрицательный оклад, пустое
// подразделение, а пустая должность роняла его с ошибкой 500.

beforeAll(startApi);
afterAll(stopApi);

const employee = (over: Record<string, unknown> = {}) => ({
  fullName: 'Проверочный Сотрудник', position: 'Инженер', department: 'Проверочный отдел',
  status: 'active', hireDate: '2026-01-15', salary: 5000, rate: 1, ...over,
});

describe('карточка сотрудника', () => {
  it.each([
    ['ставка больше двух', { rate: 2.5 }, 'rate'],
    ['нулевая ставка', { rate: 0 }, 'rate'],
    ['отрицательный оклад', { salary: -1 }, 'salary'],
    ['пустое ФИО', { fullName: ' ' }, 'fullName'],
    ['неизвестный статус', { status: 'Работает' }, 'status'],
    ['дата приёма не дата', { hireDate: '46297' }, 'hireDate'],
    ['увольнение раньше приёма', { status: 'dismissed', dismissalDate: '2025-12-31' }, 'dismissalDate'],
  ])('отклоняется: %s', async (_name, over, field) => {
    const { status, body } = await api('POST', '/api/employees', employee(over));
    expect(status).toBe(400);
    expect(body.code).toBe('emp.validation');
    expect(body.fields[field as string]).toBeTruthy();
  });

  it('ставка 1,5 допустима', async () => {
    const { status, body } = await api('POST', '/api/employees', employee({ rate: 1.5 }));
    expect(status).toBe(200);
    await api('DELETE', `/api/employees/${body.id}`);
  });
});

describe('подразделения', () => {
  let rootId = '';
  let childId = '';

  it('пустое название отклоняется', async () => {
    const { status, body } = await api('POST', '/api/departments', { name: '   ' });
    expect(status).toBe(400);
    expect(body.code).toBe('org.nameRequired');
  });

  it('создаются деревом: корень и вложенное', async () => {
    rootId = (await api('POST', '/api/departments', { name: 'Проверочная дирекция', parentId: null })).body.id;
    childId = (await api('POST', '/api/departments', { name: 'Проверочный отдел', parentId: rootId })).body.id;
    const list = (await api('GET', '/api/departments')).body;
    expect(list.find((d: any) => d.id === childId).parentId).toBe(rootId);
  });

  it('повтор названия отклоняется без учёта регистра', async () => {
    const { status, body } = await api('POST', '/api/departments', { name: 'проверочный ОТДЕЛ' });
    expect(status).toBe(400);
    expect(body.code).toBe('org.nameDuplicate');
  });

  it('нельзя сделать подразделение вложенным в собственного потомка', async () => {
    const { status, body } = await api('PUT', `/api/departments/${rootId}`, { parentId: childId });
    expect(status).toBe(400);
    expect(body.code).toBe('org.parentCycle');
  });

  it('правка названия не трогает родителя, если его не передали', async () => {
    await api('PUT', `/api/departments/${childId}`, { name: 'Проверочный отдел' });
    const child = (await api('GET', '/api/departments')).body.find((d: any) => d.id === childId);
    expect(child.parentId).toBe(rootId);
  });

  it('переименование проходит по карточкам сотрудников', async () => {
    const emp = (await api('POST', '/api/employees', employee())).body.id;
    const { body } = await api('PUT', `/api/departments/${childId}`, { name: 'Проверочный отдел 2' });
    expect(body.renamedEmployees).toBe(1);
    const card = (await api('GET', '/api/employees')).body.find((e: any) => e.id === emp);
    expect(card.department).toBe('Проверочный отдел 2');
  });

  it('нельзя удалить подразделение с вложенными', async () => {
    const { status, body } = await api('DELETE', `/api/departments/${rootId}`);
    expect(status).toBe(409);
    expect(body.code).toBe('org.hasChildren');
  });

  it('нельзя удалить подразделение, где числятся работающие сотрудники', async () => {
    const { status, body } = await api('DELETE', `/api/departments/${childId}`);
    expect(status).toBe(409);
    expect(body.code).toBe('org.hasEmployees');
    expect(body.count).toBe(1);
  });
});

describe('должности', () => {
  let departmentId = '';
  let positionId = '';

  beforeAll(async () => {
    departmentId = (await api('POST', '/api/departments', { name: 'Отдел для должностей' })).body.id;
  });

  it.each([
    ['пустое название', { title: '' }, 'pos.titleRequired'],
    ['ноль штатных единиц', { maxCount: 0 }, 'pos.unitsInvalid'],
    ['дробное число единиц', { maxCount: 1.5 }, 'pos.unitsInvalid'],
    ['отрицательный оклад', { salary: -100 }, 'pos.salaryInvalid'],
  ])('отклоняется с понятной ошибкой, а не 500: %s', async (_name, over, code) => {
    const { status, body } = await api('POST', '/api/positions', { departmentId, title: 'Техник', maxCount: 1, salary: 3000, ...over });
    expect(status).toBe(400);
    expect(body.code).toBe(code);
  });

  it('повтор названия в том же подразделении отклоняется', async () => {
    positionId = (await api('POST', '/api/positions', { departmentId, title: 'Техник', maxCount: 2, salary: 3000 })).body.id;
    const { status, body } = await api('POST', '/api/positions', { departmentId, title: 'техник', maxCount: 1, salary: 3000 });
    expect(status).toBe(400);
    expect(body.code).toBe('pos.titleDuplicate');
  });

  it('переименование должности проходит по карточкам её подразделения', async () => {
    const emp = (await api('POST', '/api/employees', employee({ position: 'Техник', department: 'Отдел для должностей' }))).body.id;
    const { body } = await api('PUT', `/api/positions/${positionId}`, { title: 'Старший техник' });
    expect(body.renamedEmployees).toBe(1);
    const card = (await api('GET', '/api/employees')).body.find((e: any) => e.id === emp);
    expect(card.position).toBe('Старший техник');
    await api('DELETE', `/api/employees/${emp}`);
  });

  it('удаление подразделения удаляет его должности', async () => {
    const { status, body } = await api('DELETE', `/api/departments/${departmentId}`);
    expect(status).toBe(200);
    expect(body.deletedPositions).toBe(1);
    expect((await api('GET', '/api/positions')).body.find((p: any) => p.id === positionId)).toBeUndefined();
  });
});

describe('шаблоны документов', () => {
  it('без названия не сохраняются', async () => {
    const { status, body } = await api('POST', '/api/templates', { name: ' ', blocks: [] });
    expect(status).toBe(400);
    expect(body.code).toBe('tpl.nameRequired');
  });

  it('блок неизвестного типа отклоняется', async () => {
    const { status, body } = await api('POST', '/api/templates', { name: 'Шаблон', blocks: [{ id: '1', type: 'image', content: '' }] });
    expect(status).toBe(400);
    expect(body.code).toBe('tpl.blocksInvalid');
  });

  it('частичная правка не стирает блоки', async () => {
    const blocks = [{ id: '1', type: 'text', content: 'Текст {{fullName}}' }, { id: '2', type: 'table', content: '{"columns":["А","Б"],"rows":[["1","2"]]}' }];
    const id = (await api('POST', '/api/templates', { name: 'Шаблон для правки', blocks })).body.id;
    expect((await api('PUT', `/api/templates/${id}`, { name: 'Новое имя' })).status).toBe(200);
    const saved = (await api('GET', '/api/templates')).body.find((t: any) => t.id === id);
    expect(saved).toMatchObject({ name: 'Новое имя', blocks });
    await api('DELETE', `/api/templates/${id}`);
  });
});

describe('кадровые операции', () => {
  let id = '';

  beforeAll(async () => {
    id = (await api('POST', '/api/employees', employee({ fullName: 'Уволняемый Сотрудник', department: 'Проверочный отдел 2' }))).body.id;
  });

  it('увольнение раньше приёма отклоняется', async () => {
    const { status } = await api('POST', '/api/movements/apply', { employeeId: id, type: 'dismissal', date: '2025-01-01', reason: 'тест' });
    expect(status).toBe(400);
  });

  it('увольнение ставит статус и дату увольнения, запись хранит ФИО', async () => {
    const { status, body } = await api('POST', '/api/movements/apply', { employeeId: id, type: 'dismissal', date: '2026-03-31', reason: 'по собственному желанию' });
    expect(status).toBe(200);
    expect(body.movement.employeeName).toBe('Уволняемый Сотрудник');
    const card = (await api('GET', '/api/employees')).body.find((e: any) => e.id === id);
    expect(card).toMatchObject({ status: 'dismissed', dismissalDate: '2026-03-31' });
  });

  it('повторно уволить нельзя', async () => {
    const { status, body } = await api('POST', '/api/movements/apply', { employeeId: id, type: 'dismissal', date: '2026-04-01' });
    expect(status).toBe(400);
    expect(body.code).toBe('mov.alreadyDismissed');
  });

  it('ФИО в журнале остаётся и после удаления карточки', async () => {
    await api('DELETE', `/api/employees/${id}`);
    const log = (await api('GET', '/api/movements')).body.filter((m: any) => m.employeeId === id);
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].employeeName).toBe('Уволняемый Сотрудник');
  });
});
