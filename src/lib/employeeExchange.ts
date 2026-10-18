/**
 * Обмен карточками сотрудников через файлы: Excel, CSV, JSON, XML.
 *
 * Раньше выгрузка отдавала внутренние ключи (id, fullName, status = active)
 * и UUID первой колонкой, а импорт с экрана «Сотрудники» записывал строки как
 * есть: статус «Работает», дата из ячейки Excel числом 46297, сотрудник без
 * ФИО под именем «Unknown». Здесь собраны правила, общие для кнопки
 * «Импорт» и мастера в настройках: распознать колонку, привести значение к
 * виду карточки и проверить строку теми же правилами, что и слой данных.
 *
 * Excel и CSV — для людей: заголовки и значения на языке интерфейса, даты в
 * выбранном формате. JSON и XML — для программ: ключи полей, коды статусов и
 * даты ГГГГ-ММ-ДД. Импорт понимает и то и другое.
 */
import { ru } from '../locales/ru';
import { en } from '../locales/en';
import { tk } from '../locales/tk';
import type { Employee } from '../data/types';
import { employeeErrors, isIsoDate } from './validation';
import { formatDate } from './dates';
import type { DateFormat } from '../store/useAppStore';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Поля обмена в порядке колонок файла. */
export const EXCHANGE_FIELDS = [
  'fullName', 'tabNumber', 'position', 'department', 'status', 'hireDate',
  'dismissalDate', 'birthDate', 'paymentType', 'salary', 'rate',
] as const;

export type ExchangeField = (typeof EXCHANGE_FIELDS)[number];

export const REQUIRED_FIELDS: ExchangeField[] = ['fullName', 'position', 'department', 'hireDate'];

const STATUS_KEYS: Record<Employee['status'], string> = {
  active: 'active', on_leave: 'onLeave', probation: 'probation', dismissed: 'dismissed',
};
const PAYMENT_TYPES: NonNullable<Employee['paymentType']>[] = ['salary', 'hourly', 'piecework'];

const LOCALES = [ru, en, tk].map((l) => l.translation as unknown as Record<string, any>);
const norm = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase('ru').replace(/\s+/g, ' ');

/** Подписи поля на всех языках + ключ — по ним узнаётся колонка файла. */
const FIELD_ALIASES: Record<ExchangeField, string[]> = (() => {
  const extra: Record<ExchangeField, string[]> = {
    fullName: ['фио', 'ф.и.о.', 'сотрудник', 'имя', 'name', 'full name', 'employee'],
    tabNumber: ['табельный номер', 'таб. №', 'таб №', 'tab number', 'personnel number'],
    position: ['должность', 'job', 'title'],
    department: ['подразделение', 'отдел', 'department'],
    status: ['статус', 'состояние'],
    hireDate: ['дата приема', 'дата приёма', 'принят', 'hire date', 'hired'],
    dismissalDate: ['дата увольнения', 'уволен', 'dismissal date', 'dismissed'],
    birthDate: ['дата рождения', 'birth date', 'birthday'],
    paymentType: ['форма оплаты', 'вид оплаты', 'payment type'],
    salary: ['оклад', 'зарплата', 'заработная плата', 'salary'],
    rate: ['ставка', 'rate'],
  };
  const out = {} as Record<ExchangeField, string[]>;
  for (const field of EXCHANGE_FIELDS) {
    const labels = LOCALES.map((l) => l.exchange?.fields?.[field]).filter(Boolean);
    out[field] = Array.from(new Set([field.toLowerCase(), ...labels, ...extra[field]].map(norm)));
  }
  return out;
})();

/** Поле карточки по заголовку колонки. Пустая строка — не распознано. */
export function guessField(header: string): ExchangeField | '' {
  const h = norm(header);
  // Сначала точное совпадение, затем вхождение: «Дата приёма на работу».
  for (const field of EXCHANGE_FIELDS) if (FIELD_ALIASES[field].includes(h)) return field;
  for (const field of EXCHANGE_FIELDS) {
    if (FIELD_ALIASES[field].some((alias) => alias.length > 3 && h.includes(alias))) return field;
  }
  return '';
}

/** Статус по коду или подписи на любом языке. */
export function parseStatus(value: unknown): Employee['status'] | null {
  const v = norm(value);
  if (!v) return 'active';
  for (const [code, key] of Object.entries(STATUS_KEYS) as [Employee['status'], string][]) {
    if (v === code || LOCALES.some((l) => norm(l.employees?.status?.[key]) === v)) return code;
  }
  // Частые синонимы из кадровых выгрузок.
  if (['работает', 'работающий', 'действует', 'working', 'employed'].includes(v)) return 'active';
  if (['отпуск', 'в отпуске', 'on leave', 'vacation'].includes(v)) return 'on_leave';
  if (['испытательный срок', 'испытание', 'probation period'].includes(v)) return 'probation';
  if (['уволен', 'уволена', 'уволенный', 'terminated', 'fired'].includes(v)) return 'dismissed';
  return null;
}

export function parsePaymentType(value: unknown): Employee['paymentType'] | null {
  const v = norm(value);
  if (!v) return 'salary';
  for (const code of PAYMENT_TYPES) {
    if (v === code || LOCALES.some((l) => norm(l.employees?.form?.pay?.[code]) === v)) return code;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Дата в ГГГГ-ММ-ДД из того, что бывает в файлах: ISO, ДД.ММ.ГГГГ,
 * ДД/ММ/ГГГГ, число-дата Excel, объект Date. null — не дата.
 */
export function parseDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  // Строка из пяти цифр — тоже номер дня Excel (так его отдают CSV-выгрузки):
  // 10000–99999 — это 1927–2173 годы, с годом или табельным номером не спутать.
  if (typeof value === 'number' || /^\d{5}(\.\d+)?$/.test(String(value).trim())) {
    // Порядковый номер дня Excel: 1 — 1 января 1900, с учётом ложного
    // 29 февраля 1900 года. Разумный диапазон — 1900–2200.
    const serial = Number(value);
    if (serial < 1 || serial > 120000) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) {
    const iso = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    return isIsoDate(iso) ? iso : null;
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (m) {
    // ДД.ММ.ГГГГ — формат по умолчанию в программе и в местных документах.
    const iso = `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
    return isIsoDate(iso) ? iso : null;
  }
  return null;
}

/** Число из «6 000», «6000,50», «6 000 TMT». null — не число. */
export function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[\s\u00a0]/g, '').replace(/[^\d,.-]/g, '').replace(',', '.');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Ставка из «0,5», «50%», «1.5». */
export function parseRate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return 1;
  const percent = String(value).includes('%');
  const n = parseNumber(value);
  if (n === null) return null;
  return percent || n > 2 ? n / 100 : n;
}

export interface ImportRow {
  /**
   * Номер строки, как его увидит человек: в Excel и CSV — номер строки листа
   * (первая — заголовок), в JSON и XML — номер записи.
   */
  line: number;
  employee: Omit<Employee, 'id'>;
  problems: string[];
}

/**
 * Приводит строку файла к карточке и проверяет её. mapping — заголовок →
 * поле; без него колонки узнаются по заголовкам.
 */
export function prepareRow(
  raw: Record<string, unknown>,
  line: number,
  t: Translate,
  mapping?: Record<string, ExchangeField | ''>,
): ImportRow {
  const values: Partial<Record<ExchangeField, unknown>> = {};
  for (const [header, value] of Object.entries(raw)) {
    const field = mapping ? mapping[header] : guessField(header);
    if (field && values[field] === undefined) values[field] = value;
  }

  const problems: string[] = [];
  const label = (field: ExchangeField) => t(`exchange.fields.${field}`);
  const text = (field: ExchangeField) => String(values[field] ?? '').trim();

  const status = parseStatus(values.status);
  if (status === null) problems.push(`${label('status')}: ${t('exchange.badStatus', { value: text('status') })}`);
  const paymentType = parsePaymentType(values.paymentType);
  if (paymentType === null) problems.push(`${label('paymentType')}: ${t('exchange.badPayment', { value: text('paymentType') })}`);

  const dates: Partial<Record<'hireDate' | 'dismissalDate' | 'birthDate', string>> = {};
  for (const field of ['hireDate', 'dismissalDate', 'birthDate'] as const) {
    const parsed = parseDate(values[field]);
    if (parsed === null) problems.push(`${label(field)}: ${t('exchange.badDate', { value: text(field) })}`);
    else if (parsed) dates[field] = parsed;
  }

  const salary = values.salary === undefined || values.salary === '' ? 0 : parseNumber(values.salary);
  if (salary === null) problems.push(`${label('salary')}: ${t('exchange.badNumber', { value: text('salary') })}`);
  const rate = parseRate(values.rate);
  if (rate === null) problems.push(`${label('rate')}: ${t('exchange.badNumber', { value: text('rate') })}`);

  const employee: Omit<Employee, 'id'> = {
    fullName: text('fullName').replace(/\s+/g, ' '),
    tabNumber: text('tabNumber') || undefined,
    position: text('position'),
    department: text('department'),
    status: status ?? 'active',
    hireDate: dates.hireDate ?? '',
    dismissalDate: dates.dismissalDate ?? null,
    birthDate: dates.birthDate,
    paymentType: paymentType ?? 'salary',
    salary: salary ?? 0,
    rate: rate ?? 1,
  };

  // Увольнение без даты и дата без увольнения — частая путаница в выгрузках:
  // статус следует за датой.
  if (employee.dismissalDate && employee.status !== 'dismissed') employee.status = 'dismissed';

  // Остальное — теми же правилами, что и слой данных. Ошибки разбора уже
  // названы выше, повторять их не нужно.
  const fieldErrors = employeeErrors(employee);
  for (const [field, code] of Object.entries(fieldErrors)) {
    if (problems.some((p) => p.startsWith(`${label(field as ExchangeField)}:`))) continue;
    problems.push(`${label(field as ExchangeField)}: ${t(`errors.${code}`)}`);
  }

  return { line, employee, problems };
}

/** Строки для Excel и CSV: заголовки и значения на языке интерфейса. */
export function humanRows(employees: Employee[], t: Translate, dateFormat: DateFormat): Record<string, string | number>[] {
  return employees.map((e) => ({
    [t('exchange.fields.fullName')]: e.fullName,
    [t('exchange.fields.tabNumber')]: e.tabNumber ?? '',
    [t('exchange.fields.position')]: e.position,
    [t('exchange.fields.department')]: e.department,
    [t('exchange.fields.status')]: t(`employees.status.${STATUS_KEYS[e.status] ?? 'active'}`),
    [t('exchange.fields.hireDate')]: e.hireDate ? formatDate(e.hireDate, dateFormat) : '',
    [t('exchange.fields.dismissalDate')]: e.dismissalDate ? formatDate(e.dismissalDate, dateFormat) : '',
    [t('exchange.fields.birthDate')]: e.birthDate ? formatDate(e.birthDate, dateFormat) : '',
    [t('exchange.fields.paymentType')]: t(`employees.form.pay.${e.paymentType ?? 'salary'}`),
    [t('exchange.fields.salary')]: Number(e.salary ?? 0),
    [t('exchange.fields.rate')]: Number(e.rate ?? 1),
  }));
}

/** Записи для JSON и XML: ключи полей, коды, даты ГГГГ-ММ-ДД. */
export function machineRows(employees: Employee[]): Record<ExchangeField, string | number | null>[] {
  return employees.map((e) => ({
    fullName: e.fullName,
    tabNumber: e.tabNumber ?? null,
    position: e.position,
    department: e.department,
    status: e.status,
    hireDate: e.hireDate,
    dismissalDate: e.dismissalDate ?? null,
    birthDate: e.birthDate ?? null,
    paymentType: e.paymentType ?? 'salary',
    salary: Number(e.salary ?? 0),
    rate: Number(e.rate ?? 1),
  }));
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toXml(employees: Employee[]): string {
  const items = machineRows(employees).map((row) => {
    const fields = EXCHANGE_FIELDS
      .filter((f) => row[f] !== null && row[f] !== '')
      .map((f) => `    <${f}>${xmlEscape(String(row[f]))}</${f}>`)
      .join('\n');
    return `  <employee>\n${fields}\n  </employee>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<employees>\n${items.join('\n')}\n</employees>\n`;
}

export function toJson(employees: Employee[]): string {
  return JSON.stringify({ format: 'kadra-employees', version: 1, employees: machineRows(employees) }, null, 2);
}

/** CSV для Excel: разделитель «;», UTF-8 с меткой порядка байтов. */
export function toCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return '\ufeff';
  const headers = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    // Excel с русскими настройками ждёт в CSV с «;» дробную часть через
    // запятую: «0.5» он прочитал бы как дату или текст.
    const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v ?? '');
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `\ufeff${[headers.map(cell).join(';'), ...rows.map((r) => headers.map((h) => cell(r[h])).join(';'))].join('\r\n')}\r\n`;
}

/** Разбор XML выгрузки KADRA (или похожей: <employee> с полями-элементами). */
export function parseXml(text: string): Record<string, unknown>[] {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('xml');
  return Array.from(doc.getElementsByTagName('employee')).map((node) => {
    const row: Record<string, unknown> = {};
    for (const child of Array.from(node.children)) row[child.tagName] = child.textContent ?? '';
    // Поля могут прийти и атрибутами: <employee fullName="..." />.
    for (const attr of Array.from(node.attributes)) if (row[attr.name] === undefined) row[attr.name] = attr.value;
    return row;
  });
}

export function parseJson(text: string): Record<string, unknown>[] {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : Array.isArray(data?.employees) ? data.employees : null;
  if (!list) throw new Error('json');
  return list.filter((r: unknown) => r && typeof r === 'object');
}

/** Читает файл обмена любого поддерживаемого формата в массив строк. */
export async function readExchangeFile(file: File): Promise<Record<string, unknown>[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) return parseJson(await file.text());
  if (name.endsWith('.xml')) return parseXml(await file.text());
  // Excel и CSV — через SheetJS; CSV с «;» он распознаёт сам.
  const XLSX = await import('xlsx');
  const buffer = await file.arrayBuffer();
  const workbook = name.endsWith('.csv')
    ? XLSX.read(new TextDecoder('utf-8').decode(buffer).replace(/^\ufeff/, ''), { type: 'string', raw: true })
    // Даты Excel читаем номерами дней: перевод в Date у SheetJS зависит от
    // часового пояса компьютера, а номер дня — нет.
    : XLSX.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return sheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true }) : [];
}

export const EXCHANGE_ACCEPT = '.xlsx,.xls,.csv,.json,.xml';

/** Номер строки файла для отчёта: у таблиц первая строка — заголовок. */
export function displayLine(file: File, index: number): number {
  return /\.(xlsx|xls|csv)$/i.test(file.name) ? index + 2 : index + 1;
}
