/**
 * Удаление демонстрационных данных.
 *
 * При первом запуске база засевается вымышленной организацией, чтобы
 * программу можно было потрогать. Раньше убрать её можно было только по
 * одной записи — а часть записей (приказы, заявки, чек-листы, архив) из
 * интерфейса не удалялась вовсе — или полным сбросом, стирающим и своё.
 *
 * Здесь собираются запросы, которые удаляют ровно посеянные строки: по их
 * идентификаторам из seedData.ts, плюс всё, что в процессе работы успели
 * привязать к демо-сотрудникам (табели, заявки, чек-листы, оценки, приказы,
 * архив). Пользовательские записи получают UUID и с демо-идентификаторами
 * не совпадают. Один список запросов на обе ветки доступа к данным.
 */
import { CORE_SEED, SEED_ROWS } from './seedData';

/** Таблица → идентификаторы строк, созданных посевом. */
export function demoIds(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (table: string, ids: string[]) => {
    out[table] = [...(out[table] ?? []), ...ids];
  };

  for (const batch of CORE_SEED) {
    const table = /INSERT INTO (\w+)/i.exec(batch.sql)?.[1];
    if (table) add(table, batch.rows.map((row) => String(row[0])));
  }
  for (const [table, rows] of Object.entries(SEED_ROWS)) {
    add(table, rows.map((row) => String(row.id)));
  }
  return out;
}

/**
 * Категории базы знаний — не данные вымышленной организации, а общая
 * рубрикация; другого способа их завести в интерфейсе нет, поэтому остаются.
 */
const KEEP_TABLES = new Set(['kb_categories']);

/** Таблицы, строки которых ссылаются на сотрудника через employee_id. */
const EMPLOYEE_LINKED = ['timesheets', 'archives', 'time_off_requests', 'checklist_tasks', 'goals', 'reviews', 'movements'];

export interface DemoStatement {
  sql: string;
  params: unknown[];
}

/** Запросы удаления демо-данных — выполнять одной транзакцией. */
export function demoCleanupStatements(): DemoStatement[] {
  const ids = demoIds();
  const statements: DemoStatement[] = [];
  const placeholders = (list: unknown[]) => list.map(() => '?').join(', ');

  const employeeIds = ids.employees ?? [];
  if (employeeIds.length > 0) {
    for (const table of EMPLOYEE_LINKED) {
      statements.push({
        sql: `DELETE FROM ${table} WHERE employee_id IN (${placeholders(employeeIds)})`,
        params: employeeIds,
      });
    }
  }

  // Должности демо-подразделений, даже созданные позже, без своих
  // подразделений смысла не имеют.
  const departmentIds = ids.departments ?? [];
  if (departmentIds.length > 0) {
    statements.push({
      sql: `DELETE FROM positions WHERE department_id IN (${placeholders(departmentIds)})`,
      params: departmentIds,
    });
    // Свои подразделения, заведённые внутри демо-структуры, становятся
    // корневыми, а не ссылаются на удалённого родителя.
    statements.push({
      sql: `UPDATE departments SET parent_id = NULL WHERE parent_id IN (${placeholders(departmentIds)}) AND id NOT IN (${placeholders(departmentIds)})`,
      params: [...departmentIds, ...departmentIds],
    });
  }

  for (const [table, list] of Object.entries(ids)) {
    if (list.length === 0 || KEEP_TABLES.has(table)) continue;
    statements.push({ sql: `DELETE FROM ${table} WHERE id IN (${placeholders(list)})`, params: list });
  }
  return statements;
}

/** Есть ли в базе хоть одна демо-запись — по уже загруженным спискам. */
export function hasDemoRows(loaded: Record<string, { id: string }[]>): boolean {
  const ids = demoIds();
  return Object.entries(loaded).some(([table, rows]) => {
    if (KEEP_TABLES.has(table)) return false;
    const demo = new Set(ids[table] ?? []);
    return rows.some((row) => demo.has(row.id));
  });
}
