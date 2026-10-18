import { describe, expect, it } from 'vitest';
import { codeForDay, employedInMonth, nextCode, timesheetTotals } from '../../src/lib/timesheet';
import { archiveRecordsForMonth, employmentOf } from '../../src/lib/archiveMonth';
import { turnoverByMonth } from '../../src/lib/turnover';
import { parseDate, parseNumber, parseRate, parseStatus, prepareRow, toCsv } from '../../src/lib/employeeExchange';
import { departmentNameError, employeeErrors, parentError, positionErrors, templateError } from '../../src/lib/validation';
import { documentParagraphs, parseTable, templateVariables } from '../../src/lib/templateBlocks';
import { positionStats, staffingSummary } from '../../src/lib/staffing';
import { compareSnapshots, makeSnapshot, snapshotTotals } from '../../src/lib/staffingRevisions';
import { formatDate, localDateISO } from '../../src/lib/dates';
import { movementError } from '../../src/data/movements';
import type { Department, Employee, Movement, Position, Template } from '../../src/data/types';

// Проверки к исправлениям по протоколу тестирования от 14.10.2026.

const t = (key: string) => key;

const employee = (over: Partial<Employee> = {}): Employee => ({
  id: 'e1', fullName: 'Тест Тестов', position: 'Инженер', department: 'IT',
  status: 'active', hireDate: '2024-01-01', salary: 6000, rate: 1, ...over,
});

describe('табель и период работы (Д-04)', () => {
  const hiredInJuly = employmentOf(employee({ hireDate: '2026-07-01' }));
  const dismissedMid = employmentOf(employee({ status: 'dismissed', dismissalDate: '2026-03-15' }));

  it('до приёма дней нет: в июне принятому 1 июля ничего не начисляется', () => {
    expect(employedInMonth(hiredInJuly, 2026, 5)).toBe(false);
    expect(codeForDay({}, 2026, 5, 10, hiredInJuly)).toBe('');
    expect(timesheetTotals({}, 2026, 5, hiredInJuly)).toMatchObject({ workDays: 0, hours: 0, employedDays: 0 });
  });

  it('после увольнения дней нет: в марте считается только по 15-е', () => {
    const totals = timesheetTotals({}, 2026, 2, dismissedMid);
    expect(totals.employedDays).toBe(15);
    expect(codeForDay({}, 2026, 2, 16, dismissedMid)).toBe('');
    expect(employedInMonth(dismissedMid, 2026, 3)).toBe(false);
  });

  it('первый щелчок по рабочему дню меняет «Я», а не оставляет её', () => {
    // 14.10.2026 — среда.
    expect(codeForDay({}, 2026, 9, 14)).toBe('Я');
    expect(nextCode({}, 2026, 9, 14)).toBe('В');
    expect(nextCode({ 14: 'В' }, 2026, 9, 14)).toBe('ОТ');
    // Круг замыкается на умолчании дня — в базе остаётся пустое значение.
    expect(nextCode({ 14: 'ПР' }, 2026, 9, 14)).toBe('');
  });
});

describe('закрытие месяца в архив', () => {
  it('переносит работавших в месяце, оклад по ставке, месяц 1–12', () => {
    const rows = archiveRecordsForMonth([
      employee({ id: 'a', fullName: 'Аманов', salary: 8000, rate: 0.5 }),
      employee({ id: 'b', fullName: 'Будущий', hireDate: '2026-11-01' }),
    ], [], 2026, 9);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ year: 2026, month: 10, employeeName: 'Аманов', salary: 4000, hoursWorked: 176 });
  });
});

describe('текучесть (Д-22)', () => {
  it('учитывает приём карточкой без приказа и увольнение', () => {
    const staff = [
      employee({ id: 'a', hireDate: '2025-01-10' }),
      employee({ id: 'b', hireDate: '2026-02-01' }),
      employee({ id: 'c', hireDate: '2025-05-01', status: 'dismissed', dismissalDate: '2026-02-20' }),
    ];
    const moves: Movement[] = [{ id: 'm', employeeId: 'c', type: 'dismissal', date: '2026-02-20' } as Movement];
    const { months } = turnoverByMonth(staff, moves, 2026);
    // На 1 февраля числятся трое (принятый 1-го — тоже), на 28-е — двое.
    expect(months[1]).toMatchObject({ hired: 1, dismissed: 1, start: 3, end: 2 });
  });
});

describe('разбор файлов импорта (Д-08)', () => {
  it('число-дата Excel превращается в дату, а не в «46297.0»', () => {
    expect(parseDate(46297)).toBe('2026-10-02');
    expect(parseDate('46297')).toBe('2026-10-02');
    expect(parseDate('02.10.2026')).toBe('2026-10-02');
    expect(parseDate('31.02.2026')).toBeNull();
  });

  it('статус по подписи: «Работает» — работающий, мусор — ошибка', () => {
    expect(parseStatus('Работает')).toBe('active');
    expect(parseStatus('Уволен')).toBe('dismissed');
    expect(parseStatus('кто знает')).toBeNull();
  });

  it('числа и ставки из человеческой записи', () => {
    expect(parseNumber('6 000 TMT')).toBe(6000);
    expect(parseNumber('6 000,50')).toBe(6000.5);
    expect(parseRate('50%')).toBe(0.5);
    expect(parseRate('1,5')).toBe(1.5);
  });

  it('строка без ФИО не становится сотрудником «Unknown»', () => {
    const row = prepareRow({ 'ФИО': '', 'Должность': 'Инженер', 'Подразделение': 'IT', 'Дата приёма': '01.02.2026' }, 2, t);
    expect(row.problems.length).toBeGreaterThan(0);
    expect(row.employee.fullName).toBe('');
  });

  it('оклад из колонки не теряется', () => {
    const row = prepareRow({ 'ФИО': 'Оразов Байрам', 'Должность': 'Инженер', 'Подразделение': 'IT', 'Дата приёма': 46297, 'Оклад': '9 500' }, 2, t);
    expect(row.problems).toEqual([]);
    expect(row.employee).toMatchObject({ hireDate: '2026-10-02', salary: 9500, status: 'active' });
  });

  it('CSV открывается в Excel: BOM и точка с запятой', () => {
    const csv = toCsv([{ 'ФИО': 'Иванов; Иван', 'Оклад': 100 }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('"Иванов; Иван";100');
  });
});

describe('проверки данных (Д-06, Д-33)', () => {
  const departments: Department[] = [
    { id: 'r', name: 'Дирекция', parentId: null },
    { id: 'c', name: 'Отдел', parentId: 'r' },
    { id: 'g', name: 'Группа', parentId: 'c' },
  ];

  it('подразделение: пустое и повторное название', () => {
    expect(departmentNameError('  ', departments)).toBe('org.nameRequired');
    expect(departmentNameError('отдел', departments)).toBe('org.nameDuplicate');
    expect(departmentNameError('Отдел', departments, 'c')).toBeNull();
  });

  it('подразделение: родитель не может быть потомком', () => {
    expect(parentError(departments, 'r', 'g')).toBe('org.parentCycle');
    expect(parentError(departments, 'g', 'r')).toBeNull();
  });

  it('должность: целое число единиц и неотрицательный оклад', () => {
    expect(positionErrors({ title: 'Техник', maxCount: 0, salary: 1 }, [])).toHaveProperty('maxCount');
    expect(positionErrors({ title: 'Техник', maxCount: 2, salary: -5 }, [])).toHaveProperty('salary');
    expect(positionErrors({ title: '', maxCount: 1, salary: 1 }, [])).toHaveProperty('title');
  });

  it('сотрудник: ставка до 2, оклад неотрицательный', () => {
    expect(employeeErrors(employee({ rate: 2 }))).toEqual({});
    expect(employeeErrors(employee({ rate: 2.5 }))).toHaveProperty('rate');
    expect(employeeErrors(employee({ salary: -1 }))).toHaveProperty('salary');
  });

  it('шаблон: нужно название и известные блоки', () => {
    expect(templateError({ name: '', blocks: [] })).toBe('tpl.nameRequired');
    expect(templateError({ name: 'Справка', blocks: [{ id: '1', type: 'video' }] })).toBe('tpl.blocksInvalid');
    expect(templateError({ name: 'Справка', blocks: [{ id: '1', type: 'text', content: '' }] })).toBeNull();
  });

  it('кадровая операция: повторное увольнение и операция до приёма', () => {
    const dismissed = employee({ status: 'dismissed', dismissalDate: '2026-01-31' });
    expect(movementError({ type: 'dismissal', date: '2026-02-01', toSalary: 0 }, dismissed)).toBe('mov.alreadyDismissed');
    expect(movementError({ type: 'transfer', date: '2023-12-31', toPosition: 'Техник', toSalary: 0 }, employee())).toBeTruthy();
  });
});

describe('шаблоны документов (07.6)', () => {
  it('таблица из старых шаблонов показывается как раньше — строкой оклада', () => {
    const table = parseTable('', t);
    expect(table.rows).toEqual([['docgen.baseSalary', '{{salary}}']]);
  });

  it('настраиваемая таблица попадает в .docx строками «показатель: значение»', () => {
    const template: Template = {
      id: 't', name: 'Справка',
      blocks: [
        { id: '1', type: 'text', content: 'Справка дана {{ФИО}}.' },
        { id: '2', type: 'table', content: JSON.stringify({ columns: ['Показатель', 'Значение'], rows: [['Должность', '{{position}}'], ['', '']] }) },
        { id: '3', type: 'signature', content: '' },
      ],
    };
    expect(templateVariables(template, t).sort()).toEqual(['fullName', 'position']);
    expect(documentParagraphs(template, { fullName: 'Оразов Б.', position: 'Главный инженер' }, t)).toEqual([
      { text: 'Справка дана Оразов Б..' },
      { text: 'Должность: Главный инженер' },
    ]);
  });
});

describe('штатное расписание (Д-30)', () => {
  const departments: Department[] = [{ id: 'd', name: 'Бухгалтерия', parentId: null }];
  const positions: Position[] = [{ id: 'p', departmentId: 'd', title: 'Бухгалтер', maxCount: 2, salary: 5000 }];
  const people = [1, 2, 3].map((n) => employee({ id: `b${n}`, position: 'Бухгалтер', department: 'Бухгалтерия' }));

  it('перекомплект виден: занято 3 из 2 — вакансий 0, сверх штата 1', () => {
    const stats = positionStats(positions, people, departments);
    expect(stats[0]).toMatchObject({ total: 2, occupied: 3, vacant: 0, over: 1 });
    expect(staffingSummary(stats)).toMatchObject({ total: 2, occupied: 3, vacant: 0, over: 1 });
  });

  it('уволенный штатную единицу не занимает', () => {
    const stats = positionStats(positions, [people[0], { ...people[1], status: 'dismissed' }], departments);
    expect(stats[0]).toMatchObject({ occupied: 1, vacant: 1, over: 0 });
  });

  it('редакции сравниваются по должностям', () => {
    const before = makeSnapshot(departments, positions);
    const after = makeSnapshot(departments, [{ ...positions[0], maxCount: 3 }]);
    expect(snapshotTotals(after).units).toBe(3);
    expect(compareSnapshots(before, after).find((d) => d.status === 'changed')).toBeTruthy();
  });
});

describe('даты в местном времени (Д-12, Д-29)', () => {
  it('формат даты из настроек применяется', () => {
    expect(formatDate('2026-10-14', 'dd.MM.yyyy')).toBe('14.10.2026');
    expect(formatDate('2026-10-14', 'yyyy-MM-dd')).toBe('2026-10-14');
    expect(formatDate('2026-10-14', 'MM/dd/yyyy')).toBe('10/14/2026');
  });

  it('сегодняшняя дата берётся по местному времени, а не по UTC', () => {
    // 00:30 по местному времени — в UTC это может быть ещё вчера.
    const lateNight = new Date(2026, 9, 14, 0, 30);
    expect(localDateISO(lateNight)).toBe('2026-10-14');
  });
});
