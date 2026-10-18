// ExcelJS и SheetJS вместе весят больше мегабайта и нужны только в момент
// выгрузки или импорта. Статический импорт тащил их в стартовый файл, и
// каждый запуск приложения платил за их разбор. Теперь они грузятся при
// первом обращении и дальше берутся из кэша модулей.
const loadExcelJS = () => import('exceljs').then((m) => m.default);
const loadSheetJS = () => import('xlsx');

export interface WorkbookOptions {
  /** Имя листа. Раньше любой лист назывался «Data». */
  sheetName?: string;
  /** Формат чисел по заголовку колонки, например '#,##0.00'. */
  numberFormats?: Record<string, string>;
  /** Закрепить первую строку и первые N колонок. */
  freezeColumns?: number;
}

/** Ширина колонки по содержимому: от 8 до 60 символов. */
function fitWidth(header: string, values: unknown[]): number {
  const longest = values.reduce<number>((max, v) => Math.max(max, String(v ?? '').length), header.length);
  return Math.min(60, Math.max(8, longest + 2));
}

/** Имя листа Excel: до 31 символа, без []:*?/\\. */
const safeSheetName = (name: string) => name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Data';

/**
 * Собирает книгу Excel из массива объектов.
 *
 * Отделено от скачивания намеренно: сборка — чистая функция, её можно
 * проверить тестом без браузера, а скачивание требует DOM и проверяется
 * только руками.
 *
 * Порядок колонок — порядок ключей первой строки (числовые ключи вроде дней
 * месяца JavaScript ставит вперёд, поэтому их нужно передавать строками с
 * нецифровым началом или задавать порядок явно через columns).
 */
export const buildWorkbook = async (
  data: Record<string, unknown>[],
  options: WorkbookOptions & { columns?: string[] } = {},
): Promise<ArrayBuffer | null> => {
  if (data.length === 0) return null;

  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(safeSheetName(options.sheetName ?? 'Data'), {
    views: [{ state: 'frozen', ySplit: 1, xSplit: options.freezeColumns ?? 0 }],
  });

  // Заголовки собираем по всем строкам: у разреженных данных первая строка
  // может не содержать всех колонок, и они потерялись бы молча.
  const headers = options.columns ?? Array.from(new Set(data.flatMap(item => Object.keys(item))));
  worksheet.addRow(headers);

  data.forEach(item => {
    worksheet.addRow(headers.map(h => item[h] ?? null));
  });

  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F7' } };
  headers.forEach((header, i) => {
    const column = worksheet.getColumn(i + 1);
    column.width = fitWidth(header, data.map(item => item[header]));
    const fmt = options.numberFormats?.[header];
    if (fmt) column.numFmt = fmt;
  });

  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
};

export const exportToExcel = async (
  data: any[],
  filename: string,
  options: WorkbookOptions & { columns?: string[] } = {},
) => {
  const buffer = await buildWorkbook(data, options);
  if (!buffer) return;
  await saveBlob(
    new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`,
  );
};

/** Сохраняет текстовый файл (CSV, JSON, XML) в UTF-8. */
export const saveText = async (text: string, filename: string, mime: string): Promise<void> => {
  await saveBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
};

/**
 * Разбирает содержимое книги в массив строк. Вынесено из parseExcel по той же
 * причине: чтение файла требует браузера, разбор — нет.
 */
export const parseWorkbook = async (data: ArrayBuffer | Uint8Array | string, type: 'binary' | 'array' = 'binary'): Promise<any[]> => {
  const XLSX = await loadSheetJS();
  const workbook = XLSX.read(data, { type });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName]);
};

export const parseExcel = async (file: File): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      parseWorkbook(e.target?.result as string).then(resolve, reject);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsBinaryString(file);
  });
};

/** Сохраняет готовый файл. Через file-saver, который тоже грузится по требованию. */
export const saveBlob = async (blob: Blob, filename: string): Promise<void> => {
  const { saveAs } = await import('file-saver');
  saveAs(blob, filename);
};

/**
 * Выгрузка через SheetJS с именем листа — для архива, где книга собирается
 * из уже готовых строк и нужен свой лист.
 */
export const exportSheet = async (data: Record<string, unknown>[], sheetName: string, filename: string, options: WorkbookOptions = {}): Promise<void> => {
  // Тем же сборщиком, что и остальные выгрузки: шапка, ширина колонок,
  // форматы чисел. Раньше лист собирался SheetJS «как есть».
  await exportToExcel(data, filename, { ...options, sheetName });
};
