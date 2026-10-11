// ExcelJS и SheetJS вместе весят больше мегабайта и нужны только в момент
// выгрузки или импорта. Статический импорт тащил их в стартовый файл, и
// каждый запуск приложения платил за их разбор. Теперь они грузятся при
// первом обращении и дальше берутся из кэша модулей.
const loadExcelJS = () => import('exceljs').then((m) => m.default);
const loadSheetJS = () => import('xlsx');

/**
 * Собирает книгу Excel из массива объектов.
 *
 * Отделено от скачивания намеренно: сборка — чистая функция, её можно
 * проверить тестом без браузера, а скачивание требует DOM и проверяется
 * только руками.
 */
export const buildWorkbook = async (data: Record<string, unknown>[]): Promise<ArrayBuffer | null> => {
  if (data.length === 0) return null;

  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Data');

  // Заголовки собираем по всем строкам: у разреженных данных первая строка
  // может не содержать всех колонок, и они потерялись бы молча.
  const headers = Array.from(new Set(data.flatMap(item => Object.keys(item))));
  worksheet.addRow(headers);

  data.forEach(item => {
    worksheet.addRow(headers.map(h => item[h] ?? null));
  });

  worksheet.getRow(1).font = { bold: true };
  worksheet.columns.forEach(column => {
    column.width = 20;
  });

  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
};

export const exportToExcel = async (data: any[], filename: string) => {
  const buffer = await buildWorkbook(data);
  if (!buffer) return;

  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = window.URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.xlsx`;
  link.click();

  window.URL.revokeObjectURL(url);
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
export const exportSheet = async (data: Record<string, unknown>[], sheetName: string, filename: string): Promise<void> => {
  const XLSX = await loadSheetJS();
  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  await saveBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
};
