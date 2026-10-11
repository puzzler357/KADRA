import { describe, expect, it } from 'vitest';
import { buildWorkbook, parseWorkbook } from '../../src/lib/excel';

/**
 * Круговой проход: собрали книгу — разобрали обратно. Обе стороны выгрузки
 * раньше не проверялись ничем, хотя через них проходят и отчёты, и табель,
 * и импорт сотрудников.
 */
async function roundTrip(rows: Record<string, unknown>[]): Promise<any[]> {
  const buffer = await buildWorkbook(rows);
  if (!buffer) return [];
  return parseWorkbook(new Uint8Array(buffer), 'array');
}

describe('выгрузка и разбор Excel', () => {
  it('возвращает те же строки после круга', async () => {
    const rows = [
      { ФИО: 'Иванов Иван', Должность: 'Инженер', Оклад: 100000 },
      { ФИО: 'Петров Пётр', Должность: 'Аналитик', Оклад: 90000 },
    ];

    expect(await roundTrip(rows)).toEqual(rows);
  });

  it('числа остаются числами, а не превращаются в текст', async () => {
    // Ради этого суммы в выгрузках и не форматируются: иначе в таблице
    // сломалась бы арифметика.
    const [row] = await roundTrip([{ Оклад: 123456.78, Часы: 160 }]);

    expect(typeof row['Оклад']).toBe('number');
    expect(row['Оклад']).toBeCloseTo(123456.78, 2);
    expect(row['Часы']).toBe(160);
  });

  it('собирает заголовки по всем строкам, а не по первой', async () => {
    // У разреженных данных первая строка может не содержать всех колонок —
    // раньше такие колонки терялись молча.
    const result = await roundTrip([
      { A: 1 },
      { A: 2, B: 'значение' },
    ]);

    expect(result[1].B).toBe('значение');
  });

  it('пустой набор не создаёт книгу', async () => {
    expect(await buildWorkbook([])).toBeNull();
    expect(await roundTrip([])).toEqual([]);
  });

  it('разбирает CSV тем же путём, что и книгу', async () => {
    const csv = 'ФИО,Должность\nИванов Иван,Инженер\n';
    expect(await parseWorkbook(csv)).toEqual([{ 'ФИО': 'Иванов Иван', 'Должность': 'Инженер' }]);
  });

  it('кириллица переживает круг без потерь', async () => {
    const [row] = await roundTrip([{ Подразделение: 'Аналитика', Статус: 'Испыт. срок' }]);

    expect(row['Подразделение']).toBe('Аналитика');
    expect(row['Статус']).toBe('Испыт. срок');
  });
});
