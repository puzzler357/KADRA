/**
 * Блоки шаблонов документов: текст, таблица, подписи.
 *
 * Шаблон хранится в базе как список блоков { id, type, content }. У текста в
 * content — сам текст с {{переменными}}, у таблицы — JSON со столбцами и
 * строками. Раньше таблица была заглушкой «Таблица данных»: её нельзя было
 * настроить, а в документ всегда попадала одна строка «Базовая ставка».
 *
 * Здесь же — подстановка значений для всех трёх мест, где шаблон
 * превращается в документ: «Генерация документов», «Документ» в карточке
 * сотрудника и выгрузка .docx.
 */
import type { Template } from '../data/types';
import { extractVariables, renderTemplate } from './templateVars';
import type { TemplateValues } from './templateVars';

export type TemplateBlock = Template['blocks'][number];
export type BlockType = 'text' | 'table' | 'signature';

export interface TableBlockData {
  columns: string[];
  rows: string[][];
}

export const MAX_TABLE_COLUMNS = 4;
export const MAX_TABLE_ROWS = 30;

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Новая таблица: «Показатель — Значение» с двумя строками из карточки. */
export function defaultTable(t: Translate): TableBlockData {
  return {
    columns: [t('docgen.tableIndicator'), t('docgen.tableValue')],
    rows: [
      [t('docgen.vars.position'), '{{position}}'],
      [t('docgen.vars.salary'), '{{salary}}'],
    ],
  };
}

/**
 * Таблица из content. Пустой content — таблица из шаблонов прежних версий:
 * у них была одна строка «Базовая ставка» с окладом, её и показываем, чтобы
 * старые документы не изменились.
 */
export function parseTable(content: string | undefined, t: Translate): TableBlockData {
  if (content) {
    try {
      const data = JSON.parse(content) as Partial<TableBlockData>;
      if (Array.isArray(data.columns) && data.columns.length > 0 && Array.isArray(data.rows)) {
        const width = Math.min(data.columns.length, MAX_TABLE_COLUMNS);
        return {
          columns: data.columns.slice(0, width).map(String),
          rows: data.rows.map(row => Array.from({ length: width }, (_, i) => String((Array.isArray(row) ? row[i] : '') ?? ''))),
        };
      }
    } catch {
      /* не JSON — ниже вернётся таблица по умолчанию */
    }
  }
  return {
    columns: [t('docgen.tableIndicator'), t('docgen.tableValue')],
    rows: [[t('docgen.baseSalary'), '{{salary}}']],
  };
}

export const serializeTable = (data: TableBlockData): string => JSON.stringify(data);

/** Все переменные шаблона — из текста и из ячеек таблиц. */
export function templateVariables(template: Template, t: Translate): string[] {
  const found = new Set<string>();
  for (const block of template.blocks) {
    if (block.type === 'text') {
      extractVariables(block.content || '').forEach(v => found.add(v));
    } else if (block.type === 'table') {
      const table = parseTable(block.content, t);
      [...table.columns, ...table.rows.flat()].forEach(cell => extractVariables(cell).forEach(v => found.add(v)));
    }
  }
  return Array.from(found);
}

/** Таблица с подставленными значениями. */
export function renderTable(block: TemplateBlock, values: TemplateValues, t: Translate): TableBlockData {
  const table = parseTable(block.content, t);
  return {
    columns: table.columns.map(c => renderTemplate(c, values)),
    rows: table.rows.map(row => row.map(cell => renderTemplate(cell, values))),
  };
}

/**
 * Абзацы для .docx. В бланке .docx есть только цикл абзацев, поэтому строка
 * таблицы становится абзацем «Показатель: значение» (при нескольких столбцах —
 * «столбец: значение; …»). Подписи в бланке уже есть — их не дублируем.
 */
export function documentParagraphs(template: Template, values: TemplateValues, t: Translate): { text: string }[] {
  const out: { text: string }[] = [];
  for (const block of template.blocks) {
    if (block.type === 'text') {
      const text = renderTemplate(block.content || '', values);
      if (text.trim() !== '') out.push({ text });
    } else if (block.type === 'table') {
      const table = renderTable(block, values, t);
      for (const row of table.rows) {
        if (row.every(cell => cell.trim() === '')) continue;
        const text = row.length === 2
          ? `${row[0]}: ${row[1]}`
          : row.map((cell, i) => `${table.columns[i]}: ${cell}`).join('; ');
        out.push({ text });
      }
    }
  }
  return out;
}

/** Имя файла без символов, недопустимых в Windows. */
export const safeFileName = (name: string): string =>
  name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'document';
