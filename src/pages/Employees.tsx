import React, { useMemo, useState, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  getFilteredRowModel,
  SortingState,
  ColumnFiltersState,
  FilterFn,
} from '@tanstack/react-table';
import { ChevronDown, ChevronUp, Upload, Download } from 'lucide-react';
import EmployeeForm from '../components/EmployeeForm';
import EmployeeActions from '../components/EmployeeActions';
import Modal, { secondaryButton } from '../components/Modal';
import { exportToExcel, saveText } from '../lib/excel';
import {
  EXCHANGE_ACCEPT, displayLine, humanRows, prepareRow, readExchangeFile, toCsv, toJson, toXml,
} from '../lib/employeeExchange';
import type { ImportRow } from '../lib/employeeExchange';
import { TableSkeleton } from '../components/States';
import { useMoney } from '../lib/money';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { useDatabaseStore } from '../store/useDatabaseStore';
import type { Employee } from '../store/useDatabaseStore';
import { useAppStore } from '../store/useAppStore';
import { fileStamp } from '../lib/dates';
import { useNotify } from '../components/Toasts';

const columnHelper = createColumnHelper<Employee>();

type RateFilter = 'all' | 'full' | 'partial' | 'extended';

// Ставка сравнивается по диапазону, а не по равенству: строгое совпадение
// с 0.5 или 0.25 отсекало бы всё остальное неполное.
const rateFilterFn: FilterFn<Employee> = (row, columnId, value) => {
  if (value === 'all') return true;
  const rate = (row.getValue(columnId) as number | undefined) ?? 1;
  if (value === 'full') return rate === 1;
  if (value === 'partial') return rate < 1;
  if (value === 'extended') return rate > 1;
  return true;
};

export default function Employees() {
  const { t } = useTranslation();
  const { employees: data, departments, addEmployee, importEmployees, loading } = useDatabaseStore();
  const dateFormat = useAppStore((s) => s.dateFormat);
  const money = useMoney();
  const notify = useNotify();
  const [exportOpen, setExportOpen] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: ImportRow[] } | null>(null);

  const [sorting, setSorting] = useState<SortingState>([]);
  // В поле пишем сразу, а таблицу пересчитываем с задержкой: фильтрация идёт
  // по массиву в памяти и на больших объёмах тормозила бы ввод.
  const [searchInput, setSearchInput] = useState('');
  const globalFilter = useDebouncedValue(searchInput, 250);
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [rateFilter, setRateFilter] = useState<RateFilter>('all');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Опции берём из справочника подразделений, а не из строк сотрудников:
  // иначе пустое подразделение в списке не появится.
  const departmentOptions = useMemo(() => {
    const fromCatalog = departments.map((d) => d.name);
    const fromEmployees = data.map((e) => e.department);
    return Array.from(new Set([...fromCatalog, ...fromEmployees])).filter(Boolean).sort();
  }, [departments, data]);

  const columnFilters = useMemo<ColumnFiltersState>(() => {
    const filters: ColumnFiltersState = [];
    if (departmentFilter !== 'all') filters.push({ id: 'department', value: departmentFilter });
    if (statusFilter !== 'all') filters.push({ id: 'status', value: statusFilter });
    if (rateFilter !== 'all') filters.push({ id: 'rate', value: rateFilter });
    return filters;
  }, [departmentFilter, statusFilter, rateFilter]);

  const resetFilters = () => {
    setSearchInput('');
    setDepartmentFilter('all');
    setStatusFilter('all');
    setRateFilter('all');
  };

  const filtersActive =
    searchInput !== '' || departmentFilter !== 'all' || statusFilter !== 'all' || rateFilter !== 'all';

  // Ошибка сохранения пробрасывается в форму: она покажет её и не закроется.
  const handleAddEmployee = async (newEmployee: Omit<Employee, 'id'>) => {
    await addEmployee(newEmployee);
    setIsFormOpen(false);
    notify.success(t('employees.saved'));
  };

  // Выгружается то, что видно: с учётом фильтров и сортировки.
  const exportRows = () => table.getSortedRowModel().rows.map((row) => row.original);

  const handleExport = async (format: 'xlsx' | 'csv' | 'json' | 'xml') => {
    setExportOpen(false);
    const rows = exportRows();
    if (rows.length === 0) {
      notify.error(t('employees.exportEmpty'));
      return;
    }
    const base = `${t('employees.fileName')}_${fileStamp()}`;
    if (format === 'xlsx') {
      await exportToExcel(humanRows(rows, t, dateFormat), base, {
        sheetName: t('employees.title'),
        numberFormats: { [t('exchange.fields.salary')]: '#,##0.00', [t('exchange.fields.rate')]: '0.00' },
      });
    } else if (format === 'csv') {
      await saveText(toCsv(humanRows(rows, t, dateFormat)), `${base}.csv`, 'text/csv');
    } else if (format === 'json') {
      await saveText(toJson(rows), `${base}.json`, 'application/json');
    } else {
      await saveText(toXml(rows), `${base}.xml`, 'application/xml');
    }
  };

  // Быстрый импорт: колонки узнаются по заголовкам, строки проверяются теми
  // же правилами, что и карточка. Пишутся только корректные строки, о
  // пропущенных — отчёт с номерами строк и причинами.
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;

    let prepared: ImportRow[];
    try {
      const raw = await readExchangeFile(file);
      if (raw.length === 0) {
        notify.error(t('settings.io.noRows'));
        return;
      }
      prepared = raw.map((row, i) => prepareRow(row, displayLine(file, i), t));
    } catch (err) {
      console.error('Failed to read import file:', err);
      notify.error(t('employees.readError'));
      return;
    }

    const valid = prepared.filter((r) => r.problems.length === 0);
    const skipped = prepared.filter((r) => r.problems.length > 0);
    try {
      // Пишем в БД, а не только в стор: иначе импортированные строки
      // исчезали при первом же обновлении списка.
      const created = valid.length > 0 ? await importEmployees(valid.map((r) => r.employee)) : 0;
      setImportResult({ imported: created, skipped });
    } catch (err) {
      console.error('Failed to import employees:', err);
      notify.error(err instanceof Error ? err.message : t('employees.importFailed'));
    }
  };

  const columns = useMemo(() => [
    columnHelper.accessor('fullName', {
      header: t('employees.col.fullName'),
      cell: info => <span className="font-medium text-primary dark:text-slate-100">{info.getValue()}</span>,
    }),
    columnHelper.accessor('tabNumber', {
      header: t('employees.col.tabNumber'),
      cell: info => <span className="text-muted tabular-nums">{info.getValue() || '—'}</span>,
    }),

    columnHelper.accessor('salary', {
      header: t('employees.col.salary'),
      cell: info => {
        const val = info.getValue();
        if (val == null) return <span className="text-muted">—</span>;
        return <span className="tabular-nums">{money.format(val)}</span>;
      },
    }),
    columnHelper.accessor('rate', {
      header: t('employees.col.rate'),
      filterFn: rateFilterFn,
      cell: info => {
        const val = info.getValue() || 1;
        return <span className="tabular-nums">{Math.round(val * 100)}%</span>;
      },
    }),
    columnHelper.accessor('department', {
      header: t('employees.col.department'),
      cell: info => info.getValue(),
    }),
    columnHelper.accessor('position', {
      header: t('employees.col.position'),
      cell: info => info.getValue(),
    }),

    columnHelper.accessor('status', {
      header: t('employees.col.status'),
      cell: info => {
        const val = info.getValue();
        if (val === 'active') return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">{t('employees.status.active')}</span>;
        if (val === 'on_leave') return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">{t('employees.status.onLeave')}</span>;
        if (val === 'probation') return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-accent-100 text-accent-800 dark:bg-accent-900/30 dark:text-accent-400">{t('employees.status.probation')}</span>;
        // Раньше уволенный показывался внутренним кодом «dismissed».
        if (val === 'dismissed') return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">{t('employees.status.dismissed')}</span>;
        return val;
      },
    }),
    columnHelper.display({
      id: 'actions',
      cell: (info) => (
        <EmployeeActions employee={info.row.original} />
      ),
    })
  ], [t, money]);

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      globalFilter,
      columnFilters,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const shownCount = table.getFilteredRowModel().rows.length;

  // Виртуализация строк: при 10 000 сотрудников в DOM держится десяток
  // видимых строк вместо всей таблицы. Высота строк постоянная, поэтому
  // хватает оценки без измерения каждой.
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 57,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length > 0
    ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">
          {t('employees.title')}{' '}
          <span className="text-muted text-lg font-normal">
            ({filtersActive ? `${shownCount} / ${data.length}` : data.length})
          </span>
        </h2>
        <div className="flex items-center gap-3">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImport}
            accept={EXCHANGE_ACCEPT}
            className="hidden"
            data-testid="employees-import-input"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            title={t('employees.importHint')}
            className="flex items-center gap-2 bg-surface-3 border border-line hover:bg-surface-hover text-secondary px-4 py-2 rounded-xl font-medium transition-colors shadow-sm text-sm"
          >
            <Upload className="w-4 h-4" />
            {t('common.import')}
          </button>
          <div className="relative">
            <button
              onClick={() => setExportOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              className="flex items-center gap-2 bg-surface-3 border border-line hover:bg-surface-hover text-secondary px-4 py-2 rounded-xl font-medium transition-colors shadow-sm text-sm"
            >
              <Download className="w-4 h-4" />
              {t('common.export')}
              <ChevronDown className="w-4 h-4" />
            </button>
            {exportOpen && (
              <>
                {/* Щелчок мимо меню закрывает его. */}
                <div role="presentation" className="fixed inset-0 z-10" onMouseDown={() => setExportOpen(false)} />
                <div role="menu" className="absolute right-0 mt-2 w-56 bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-xl shadow-lg z-20 py-1">
                  {(['xlsx', 'csv', 'json', 'xml'] as const).map((format) => (
                    <button
                      key={format}
                      role="menuitem"
                      onClick={() => void handleExport(format)}
                      className="w-full text-left px-4 py-2 text-sm text-secondary hover:bg-surface-hover"
                    >
                      {t(`employees.exportAs.${format}`)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => setIsFormOpen(true)}
            className="bg-accent-500 hover:bg-accent-600 text-white px-4 py-2 rounded-xl font-medium transition-colors shadow-sm text-sm"
          >
            {t('employees.add')}
          </button>
        </div>
      </div>

      <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm overflow-hidden flex flex-col">
        <div className="p-4 border-b border-[var(--border-color)] flex items-center gap-4 bg-surface-2 dark:bg-slate-900/50">
          <div className="flex flex-1 flex-wrap items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <input
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder={t('common.search')}
                aria-label={t('common.search')}
                className="w-full px-4 py-2 bg-surface border border-line rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 transition-shadow"
              />
            </div>
            <select
              aria-label={t('employees.col.department')}
              value={departmentFilter}
              onChange={e => setDepartmentFilter(e.target.value)}
              className="bg-surface border border-line rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-secondary w-40"
            >
              <option value="all">{t('employees.allDepartments')}</option>
              {departmentOptions.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <select
              aria-label={t('employees.col.status')}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="bg-surface border border-line rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-secondary w-40"
            >
              <option value="all">{t('employees.allStatuses')}</option>
              <option value="active">{t('employees.status.active')}</option>
              <option value="on_leave">{t('employees.status.onLeave')}</option>
              <option value="probation">{t('employees.status.probation')}</option>
              <option value="dismissed">{t('employees.status.dismissed')}</option>
            </select>
            <select
              aria-label={t('employees.col.rate')}
              value={rateFilter}
              onChange={e => setRateFilter(e.target.value as RateFilter)}
              className="bg-surface border border-line rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-secondary w-40"
            >
              <option value="all">{t('employees.anyRate')}</option>
              <option value="full">{t('employees.rateFull')}</option>
              <option value="partial">{t('employees.ratePartial')}</option>
              <option value="extended">{t('employees.rateExtended')}</option>
            </select>
            <button
              onClick={resetFilters}
              disabled={!filtersActive}
              className="bg-surface-4 hover:bg-surface-hover text-secondary px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('common.reset')}
            </button>
          </div>
        </div>

        <div ref={scrollRef} className="overflow-auto custom-scrollbar max-h-[calc(100vh-20rem)]">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted uppercase bg-surface-2 dark:bg-slate-900/50 border-b border-[var(--border-color)] sticky top-0 z-10">
              {table.getHeaderGroups().map(headerGroup => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map(header => (
                    <th key={header.id} className="p-table text-table font-medium cursor-pointer hover:bg-surface-hover dark:hover:bg-slate-800 transition-colors" onClick={header.column.getToggleSortingHandler()}>
                      <div className="flex items-center gap-2">
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                        {{
                          asc: <ChevronUp className="w-4 h-4" />,
                          desc: <ChevronDown className="w-4 h-4" />,
                        }[header.column.getIsSorted() as string] ?? null}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {paddingTop > 0 && <tr style={{ height: paddingTop }} aria-hidden />}
              {virtualRows.map(virtualRow => {
                const row = tableRows[virtualRow.index];
                return (
                  <tr key={row.id} className="bg-white dark:bg-slate-950 border-b border-[var(--border-color)] hover:bg-surface-hover dark:hover:bg-slate-900 transition-colors">
                    {row.getVisibleCells().map(cell => (
                      <td key={cell.id} className="p-table text-table">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {paddingBottom > 0 && <tr style={{ height: paddingBottom }} aria-hidden />}
            </tbody>
          </table>
          {loading && data.length === 0 && <TableSkeleton rows={8} columns={6} />}

          {!loading && tableRows.length === 0 && (
            <div className="p-12 text-center text-muted">
              {data.length === 0 ? t('employees.emptyBase') : t('employees.empty')}
            </div>
          )}
        </div>
      </div>

      {isFormOpen && (
        <EmployeeForm
          onClose={() => setIsFormOpen(false)}
          onSubmit={handleAddEmployee}
        />
      )}

      {importResult && (
        <Modal
          title={t('employees.importResultTitle')}
          onClose={() => setImportResult(null)}
          size="lg"
          footer={<button onClick={() => setImportResult(null)} className={secondaryButton}>{t('common.close')}</button>}
        >
          <div className="space-y-4 text-sm">
            <p className="text-emerald-700 dark:text-emerald-400 font-medium" data-testid="import-imported">
              {t('employees.importDone', { n: importResult.imported })}
            </p>
            {importResult.skipped.length > 0 && (
              <>
                <p className="text-rose-700 dark:text-rose-400 font-medium" data-testid="import-skipped">
                  {t('employees.importSkipped', { n: importResult.skipped.length })}
                </p>
                <table className="w-full text-left">
                  <thead className="text-muted border-b border-[var(--border-color)]">
                    <tr>
                      <th className="py-2 pr-3 font-medium">{t('settings.io.rowNo')}</th>
                      <th className="py-2 pr-3 font-medium">{t('employees.col.fullName')}</th>
                      <th className="py-2 font-medium">{t('settings.io.problems')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-color)]">
                    {importResult.skipped.slice(0, 50).map((row) => (
                      <tr key={row.line}>
                        <td className="py-2 pr-3 tabular-nums text-muted">{row.line}</td>
                        <td className="py-2 pr-3">{row.employee.fullName || '—'}</td>
                        <td className="py-2 text-rose-700 dark:text-rose-400">{row.problems.join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-muted">{t('employees.importSkippedHint')}</p>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
