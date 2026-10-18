/**
 * Выгрузка таблицы в PDF.
 *
 * Раньше PDF снимался прямо с экрана через html2canvas, а он не понимает
 * цвета oklch(), которыми Tailwind 4 красит интерфейс: выгрузка падала, файл
 * не создавался, а пользователь ничего не узнавал. Теперь для PDF строится
 * отдельная простая таблица с явными цветами, а таблицы стилей интерфейса из
 * копии документа, которую снимает html2canvas, убираются. Заодно в PDF
 * попадают все строки, а не только видимые на экране.
 */

export interface PdfColumn {
  label: string;
  align?: 'left' | 'right';
}

export interface PdfTableOptions {
  title: string;
  /** Строка под заголовком: фильтры, дата выгрузки. */
  subtitle?: string;
  columns: PdfColumn[];
  rows: (string | number)[][];
  /** Итоговая строка — выделяется жирным. */
  footer?: (string | number)[];
  fileName: string;
  orientation?: 'portrait' | 'landscape';
}

const css = (styles: Record<string, string>) => Object.entries(styles).map(([k, v]) => `${k}:${v}`).join(';');

const CELL = { padding: '6px 8px', 'border-bottom': '1px solid #d9dee7', 'font-size': '11px', color: '#1f2937' };

function buildElement(o: PdfTableOptions): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('style', css({
    background: '#ffffff', color: '#111827', padding: '16px', width: o.orientation === 'portrait' ? '720px' : '1040px',
    'font-family': 'Arial, "Helvetica Neue", Helvetica, sans-serif',
  }));

  const title = document.createElement('h1');
  title.textContent = o.title;
  title.setAttribute('style', css({ 'font-size': '18px', margin: '0 0 4px 0', color: '#111827' }));
  root.appendChild(title);

  if (o.subtitle) {
    const sub = document.createElement('p');
    sub.textContent = o.subtitle;
    sub.setAttribute('style', css({ 'font-size': '11px', margin: '0 0 12px 0', color: '#4b5563' }));
    root.appendChild(sub);
  }

  const table = document.createElement('table');
  table.setAttribute('style', css({ width: '100%', 'border-collapse': 'collapse' }));
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of o.columns) {
    const th = document.createElement('th');
    th.textContent = col.label;
    th.setAttribute('style', css({ ...CELL, background: '#eef1f6', 'font-weight': '700', 'text-align': col.align ?? 'left' }));
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const addRow = (cells: (string | number)[], bold = false) => {
    const tr = document.createElement('tr');
    // Строка не разрывается между страницами.
    tr.setAttribute('style', css({ 'page-break-inside': 'avoid' }));
    cells.forEach((value, i) => {
      const td = document.createElement('td');
      td.textContent = String(value ?? '');
      td.setAttribute('style', css({
        ...CELL,
        'text-align': o.columns[i]?.align ?? 'left',
        ...(bold ? { 'font-weight': '700', background: '#f5f7fa' } : {}),
      }));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  };
  o.rows.forEach((r) => addRow(r));
  if (o.footer) addRow(o.footer, true);
  table.appendChild(tbody);
  root.appendChild(table);
  return root;
}

export async function exportTablePdf(options: PdfTableOptions): Promise<void> {
  // html2pdf тянет html2canvas и jsPDF — грузим только при выгрузке.
  const { default: html2pdf } = await import('html2pdf.js');
  const element = buildElement(options);
  await html2pdf()
    .set({
      margin: 8,
      filename: options.fileName.endsWith('.pdf') ? options.fileName : `${options.fileName}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: {
        scale: 2,
        backgroundColor: '#ffffff',
        // В копии документа — никаких таблиц стилей интерфейса: в них цвета
        // oklch(), на которых html2canvas спотыкается. Свои стили у таблицы
        // заданы прямо в элементах.
        onclone: (doc: Document) => {
          doc.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => node.remove());
        },
      },
      jsPDF: { unit: 'mm', format: 'a4', orientation: options.orientation ?? 'landscape' },
      pagebreak: { mode: ['css', 'legacy'] },
    } as any)
    .from(element)
    .save();
}
