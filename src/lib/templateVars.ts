/**
 * Подстановка переменных в шаблоны документов.
 *
 * Логика была размазана по DocumentGenerator и EmployeeActions, причём в
 * разных вариантах: один экран подставлял оклад, другой — нет, один понимал
 * русские имена переменных, другой понимал их частично.
 */

/** Значения, подставляемые вместо {{переменных}}. */
export type TemplateValues = Record<string, string>;

/**
 * Синонимы имён переменных: шаблоны пишут люди, и «{{ФИО}}» встречается
 * не реже «{{fullName}}».
 */
const ALIASES: Record<string, string> = {
  'ФИО': 'fullName',
  'Должность': 'position',
  'Отдел': 'department',
  'Подразделение': 'department',
  'Оклад': 'salary',
  'Дата приема': 'hireDate',
  'Дата приёма': 'hireDate',
  'Организация': 'orgName',
  'Директор': 'director',
  'ИНН': 'inn',
  'Сегодня': 'today',
  'Дата документа': 'today',
};

/**
 * Переменные, которые заполняются сами: из карточки сотрудника, из «Настройки →
 * Общие» и текущая дата. Конструктор показывает их списком для вставки.
 */
export const BUILTIN_VARIABLES = ['fullName', 'position', 'department', 'hireDate', 'salary', 'orgName', 'director', 'inn', 'today'] as const;

export const VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Канонические имена переменных, встречающихся в тексте. */
export function extractVariables(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    found.add(canonicalName(match[1]));
  }
  return Array.from(found);
}

export function canonicalName(name: string): string {
  const trimmed = name.trim();
  return ALIASES[trimmed] ?? trimmed;
}

/**
 * Подставляет значения в текст.
 *
 * Переменная без значения остаётся как есть: пустое место в документе хуже,
 * чем видимый маркер — его хотя бы заметят перед печатью.
 */
export function renderTemplate(text: string, values: TemplateValues): string {
  return text.replace(VARIABLE_PATTERN, (whole, rawName: string) => {
    const name = canonicalName(rawName);
    const value = values[name];
    return value !== undefined && value !== '' ? value : whole;
  });
}
