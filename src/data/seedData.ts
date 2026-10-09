/**
 * Первичные данные для таблиц из entities.ts.
 *
 * Раньше эти записи были захардкожены прямо в компонентах экранов — они
 * существовали только в памяти, не редактировались по-настоящему и исчезали
 * при перезагрузке. Теперь это обычный посев базы: строки живут в SQLite,
 * правятся как любые другие и удаляются сбросом системы.
 *
 * Ссылки на сотрудников используют идентификаторы из посева employees.
 */
import { ENTITIES } from './entities';

const today = '2026-09-13';

export const SEED_ROWS: Record<string, Record<string, unknown>[]> = {
  candidates: [
    { id: 'c1', fullName: 'Алексей Смирнов', position: 'Фронтенд разработчик', experience: '3 года', status: 'new', createdAt: today, note: null },
    { id: 'c2', fullName: 'Елена Попова', position: 'UX/UI Дизайнер', experience: '5 лет', status: 'screening', createdAt: today, note: null },
    { id: 'c3', fullName: 'Дмитрий Волков', position: 'Бэкенд разработчик', experience: '4 года', status: 'interview', createdAt: today, note: null },
    { id: 'c4', fullName: 'Ольга Новикова', position: 'Менеджер проектов', experience: '6 лет', status: 'offer', createdAt: today, note: null },
  ],

  time_off_requests: [
    { id: 'to1', employeeId: '1', type: 'vacation', dateFrom: '2026-08-15', dateTo: '2026-08-28', days: 14, status: 'approved', comment: null },
    { id: 'to2', employeeId: '2', type: 'sick', dateFrom: '2026-07-01', dateTo: '2026-07-05', days: 5, status: 'pending', comment: null },
    { id: 'to3', employeeId: '3', type: 'dayoff', dateFrom: '2026-06-10', dateTo: '2026-06-10', days: 1, status: 'rejected', comment: null },
  ],

  checklist_tasks: [
    { id: 'ck1', employeeId: '5', kind: 'onboarding', title: 'Оформить трудовой договор', assignee: 'HR', done: true, comment: null, orderIndex: 1 },
    { id: 'ck2', employeeId: '5', kind: 'onboarding', title: 'Выдать оборудование', assignee: 'IT', done: true, comment: null, orderIndex: 2 },
    { id: 'ck3', employeeId: '5', kind: 'onboarding', title: 'Провести вводный инструктаж', assignee: 'Руководитель', done: false, comment: null, orderIndex: 3 },
    { id: 'ck4', employeeId: '5', kind: 'onboarding', title: 'Назначить наставника', assignee: 'Руководитель', done: false, comment: null, orderIndex: 4 },
    { id: 'ck5', employeeId: '4', kind: 'offboarding', title: 'Вернуть оборудование', assignee: 'IT', done: false, comment: null, orderIndex: 1 },
    { id: 'ck6', employeeId: '4', kind: 'offboarding', title: 'Закрыть доступы', assignee: 'IT', done: false, comment: null, orderIndex: 2 },
  ],

  goals: [
    { id: 'g1', employeeId: '1', title: 'Перевести отчётность на новый конструктор', progress: 60, status: 'on-track', period: '2026-Q3' },
    { id: 'g2', employeeId: '2', title: 'Выполнить план продаж на квартал', progress: 100, status: 'completed', period: '2026-Q2' },
    { id: 'g3', employeeId: '4', title: 'Автоматизировать сбор кадровой аналитики', progress: 25, status: 'on-track', period: '2026-Q3' },
  ],

  reviews: [
    { id: 'r1', employeeId: '1', reviewer: 'Иванов Иван', period: '2026-Q2', score: 4.5, comment: 'Стабильный результат, берёт на себя сложные задачи.' },
    { id: 'r2', employeeId: '2', reviewer: 'Иванов Иван', period: '2026-Q2', score: 4, comment: 'План выполнен, есть куда расти в работе с возражениями.' },
  ],

  // По одной записи о приёме на каждого посеянного сотрудника. Это не выдумка:
  // операции соответствуют hire_date из посева employees, поэтому лента истории
  // сразу согласуется с карточками.
  movements: [
    { id: 'm1', employeeId: '1', type: 'hire', date: '2021-03-15', fromPosition: null, toPosition: 'Старший разработчик', fromDepartment: null, toDepartment: 'IT', fromSalary: 0, toSalary: 0, orderNo: 'П-1', reason: null },
    { id: 'm2', employeeId: '2', type: 'hire', date: '2022-11-01', fromPosition: null, toPosition: 'Менеджер по продажам', fromDepartment: null, toDepartment: 'Продажи', fromSalary: 0, toSalary: 0, orderNo: 'П-2', reason: null },
    { id: 'm3', employeeId: '3', type: 'hire', date: '2020-05-20', fromPosition: null, toPosition: 'HR Специалист', fromDepartment: null, toDepartment: 'HR', fromSalary: 0, toSalary: 0, orderNo: 'П-3', reason: null },
    { id: 'm4', employeeId: '4', type: 'hire', date: '2023-01-10', fromPosition: null, toPosition: 'Аналитик данных', fromDepartment: null, toDepartment: 'Аналитика', fromSalary: 0, toSalary: 0, orderNo: 'П-4', reason: null },
    { id: 'm5', employeeId: '5', type: 'hire', date: '2024-02-15', fromPosition: null, toPosition: 'Junior Дизайнер', fromDepartment: null, toDepartment: 'Дизайн', fromSalary: 0, toSalary: 0, orderNo: 'П-5', reason: null },
  ],

  kb_categories: [
    { id: 'kc1', name: 'Кадровые процедуры', orderIndex: 1 },
    { id: 'kc2', name: 'Документы и справки', orderIndex: 2 },
    { id: 'kc3', name: 'Onboarding', orderIndex: 3 },
  ],

  kb_articles: [
    { id: 'ka1', categoryId: 'kc1', title: 'Как оформить отпуск', contentHtml: '<p>Заявление подаётся не позднее чем за две недели до начала отпуска.</p>', reads: 0, createdAt: today, updatedAt: today },
    { id: 'ka2', categoryId: 'kc2', title: 'Справка с места работы', contentHtml: '<p>Справка готовится в разделе «Генерация документов» по шаблону.</p>', reads: 0, createdAt: today, updatedAt: today },
    { id: 'ka3', categoryId: 'kc3', title: 'Первый день нового сотрудника', contentHtml: '<p>Чек-лист адаптации заполняется в разделе «Онбординг».</p>', reads: 0, createdAt: today, updatedAt: today },
  ],
};

/**
 * Посев базовых таблиц. Раньше эти строки были записаны дважды — отдельно
 * для веб-режима и отдельно для нативного, — и расходились при любой правке.
 * Теперь обе ветки проходят по одному списку.
 *
 * Учётной записи владельца здесь намеренно нет, и приложение её не требует:
 * оно открывается сразу. Завести её можно в профиле, если понадобилась
 * (см. /api/auth/owner).
 */
export const CORE_SEED: { sql: string; rows: unknown[][] }[] = [
  {
    sql: 'INSERT INTO employees (id, full_name, position, department, status, hire_date, tab_number) VALUES (?, ?, ?, ?, ?, ?, ?)',
    rows: [
      ['1', 'Иванов Иван Иванович', 'Старший разработчик', 'IT', 'active', '2021-03-15', '0001'],
      ['2', 'Петров Петр Петрович', 'Менеджер по продажам', 'Продажи', 'active', '2022-11-01', '0002'],
      ['3', 'Смирнова Анна Игоревна', 'HR Специалист', 'HR', 'on_leave', '2020-05-20', '0003'],
      ['4', 'Аманмурадов Мердан', 'Аналитик данных', 'Аналитика', 'active', '2023-01-10', '0004'],
      ['5', 'Бердыева Айгуль', 'Junior Дизайнер', 'Дизайн', 'probation', '2024-02-15', '0005'],
    ],
  },
  {
    sql: 'INSERT INTO departments (id, name, parent_id) VALUES (?, ?, ?)',
    rows: [
      ['d1', 'ООО "Глобал Тек"', null],
      ['d2', 'IT', 'd1'],
      ['d3', 'Продажи', 'd1'],
      ['d4', 'HR', 'd1'],
      ['d5', 'Аналитика', 'd1'],
      ['d6', 'Дизайн', 'd1'],
    ],
  },
  {
    sql: 'INSERT INTO positions (id, department_id, title, max_count, salary) VALUES (?, ?, ?, ?, ?)',
    rows: [
      ['p1', 'd1', 'Генеральный директор', 1, 250000],
      ['p2', 'd1', 'Финансовый директор', 1, 180000],
      ['p3', 'd1', 'Главный бухгалтер', 1, 150000],
      ['p4', 'd2', 'Старший разработчик', 3, 500000],
      ['p5', 'd2', 'Разработчик', 5, 300000],
      ['p6', 'd3', 'Менеджер по продажам', 10, 250000],
      ['p7', 'd4', 'HR Специалист', 2, 180000],
      ['p8', 'd5', 'Аналитик данных', 3, 250000],
      ['p9', 'd6', 'Junior Дизайнер', 2, 120000],
    ],
  },
  {
    sql: 'INSERT INTO templates (id, name, blocks) VALUES (?, ?, ?)',
    rows: [
      ['1', 'Справка с места работы', JSON.stringify([{
        id: '1',
        type: 'text',
        content: 'Справка дана {{fullName}} в том, что он(а) действительно работает в {{orgName}} в должности {{position}}.',
      }])],
    ],
  },
  {
    sql: 'INSERT INTO archives (id, year, month, employee_id, employee_name, department, position, salary, hours_worked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    rows: [
      ['a1', 2023, 12, '1', 'Иванов Иван Иванович', 'IT', 'Старший разработчик', 500000, 160],
      ['a2', 2023, 12, '2', 'Петров Петр Петрович', 'Продажи', 'Менеджер по продажам', 300000, 150],
      ['a3', 2023, 11, '1', 'Иванов Иван Иванович', 'IT', 'Старший разработчик', 500000, 168],
      ['a4', 2023, 11, '2', 'Петров Петр Петрович', 'Продажи', 'Менеджер по продажам', 280000, 160],
      ['a5', 2022, 12, '1', 'Иванов Иван Иванович', 'IT', 'Разработчик', 400000, 160],
    ],
  },
];

/** Строки посева в порядке колонок таблицы — годится для INSERT в обеих ветках. */
export function seedValues(table: string): { sql: string; rows: unknown[][] } | null {
  const entity = ENTITIES.find((e) => e.table === table);
  const rows = SEED_ROWS[table];
  if (!entity || !rows?.length) return null;

  const cols = ['id', ...entity.columns.map((c) => c.column)];
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    rows: rows.map((row) => [
      row.id,
      ...entity.columns.map((c) => {
        const value = row[c.field];
        if (c.kind === 'bool') return value ? 1 : 0;
        if (c.kind === 'number') return value ?? 0;
        return value ?? null;
      }),
    ]),
  };
}
