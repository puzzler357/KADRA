import { useState, useMemo, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { useDatabaseStore } from '../store/useDatabaseStore';
import { useMoney } from '../lib/money';
import { Download, Printer, FileText, Plus } from 'lucide-react';
import { exportSheet } from '../lib/excel';
import { exportTablePdf } from '../lib/pdfTable';
import { archiveRecordsForMonth } from '../lib/archiveMonth';
import { fileStamp, useDates } from '../lib/dates';
import { useNotify } from '../components/Toasts';
import Modal, { Field, inputClass, primaryButton, secondaryButton } from '../components/Modal';
import * as api from '../data';

export default function Archive() {
  const { t } = useTranslation();
  const notify = useNotify();
  const dates = useDates();
  const { archives, archiveFacets, employees, fetchArchives, fetchArchiveFacets } = useDatabaseStore();
  const money = useMoney();
  const monthNames = t('timesheet.months', { returnObjects: true }) as string[];

  // По умолчанию — все годы: раньше экран открывался на текущем годе и
  // показывал «Нет данных», хотя архив не пуст.
  const [selectedYear, setSelectedYear] = useState<string>('all');
  const [selectedDepartment, setSelectedDepartment] = useState<string>('all');
  const [selectedEmployee, setSelectedEmployee] = useState<string>('all');

  // Значения фильтров считаются по всей таблице отдельным запросом: если
  // брать их из загруженного среза, список лет схлопнулся бы до текущего.
  useEffect(() => {
    fetchArchiveFacets();
  }, [fetchArchiveFacets]);

  // С сервера приходит уже отфильтрованный срез, а не вся таблица.
  const filters = useMemo(() => ({
    year: selectedYear === 'all' ? undefined : Number(selectedYear),
    department: selectedDepartment === 'all' ? undefined : selectedDepartment,
    employeeId: selectedEmployee === 'all' ? undefined : selectedEmployee,
  }), [selectedYear, selectedDepartment, selectedEmployee]);
  useEffect(() => {
    fetchArchives(filters);
  }, [fetchArchives, filters]);

  // Годы, подразделения и сотрудники — из самого архива: в нём лежат и
  // уволенные, и удалённые из картотеки, а нынешний штат здесь ни при чём.
  const availableYears = useMemo(() => [...archiveFacets.years].sort((a, b) => b - a), [archiveFacets.years]);
  const availableDepartments = archiveFacets.departments;
  const availableEmployees = archiveFacets.employees;

  const records = archives;
  const monthLabel = (m: number) => monthNames[m - 1] ?? String(m);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 45,
    overscan: 15,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  // Печать снимает таблицу с экрана — на время печати она рисуется целиком.
  const [renderAll, setRenderAll] = useState(false);
  const paddingTop = renderAll || virtualRows.length === 0 ? 0 : virtualRows[0].start;
  const paddingBottom = renderAll || virtualRows.length === 0
    ? 0
    : rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end;
  const renderedRecords = renderAll ? records : virtualRows.map((v) => records[v.index]);

  const totalSalary = records.reduce((s, r) => s + r.salary, 0);
  const totalHours = records.reduce((s, r) => s + r.hoursWorked, 0);

  const filterSummary = [
    `${t('archive.year')}: ${selectedYear === 'all' ? t('archive.allYears') : selectedYear}`,
    `${t('orgchart.subdivision')}: ${selectedDepartment === 'all' ? t('timesheet.allDepartments') : selectedDepartment}`,
    `${t('timeoff.colEmployee')}: ${selectedEmployee === 'all' ? t('archive.allEmployees') : availableEmployees.find(e => e.id === selectedEmployee)?.name ?? ''}`,
  ].join(' · ');

  const fileBase = `${t('archive.sheetName')}_${selectedYear === 'all' ? t('archive.allYearsFile') : selectedYear}_${fileStamp()}`;

  const handleExportExcel = () => {
    const data = records.map(a => ({
      [t('archive.year')]: a.year,
      [t('archive.month')]: monthLabel(a.month),
      [t('timeoff.colEmployee')]: a.employeeName,
      [t('employees.col.department')]: a.department,
      [t('employees.col.position')]: a.position,
      [t('archive.salary')]: a.salary,
      [t('archive.workedHours')]: a.hoursWorked,
    }));
    void exportSheet(data, t('archive.sheetName'), `${fileBase}.xlsx`, {
      numberFormats: { [t('archive.salary')]: '#,##0.00' },
    });
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  const handleExportPDF = async () => {
    if (records.length === 0) {
      notify.error(t('archive.noData'));
      return;
    }
    setPdfBusy(true);
    try {
      await exportTablePdf({
        title: t('archive.title'),
        subtitle: `${filterSummary} · ${t('archive.exportedAt', { date: dates.dateTime(new Date().toISOString()) })}`,
        columns: [
          { label: t('archive.year') }, { label: t('archive.month') }, { label: t('timeoff.colEmployee') },
          { label: t('employees.col.department') }, { label: t('employees.col.position') },
          { label: t('archive.salary'), align: 'right' }, { label: t('archive.colHours'), align: 'right' },
        ],
        rows: records.map(r => [r.year, monthLabel(r.month), r.employeeName, r.department, r.position, money.format(r.salary), r.hoursWorked]),
        footer: [t('reports.total'), '', t('reports.totalCount', { count: records.length }), '', '', money.format(totalSalary), totalHours],
        fileName: fileBase,
      });
      notify.success(t('archive.pdfSaved'));
    } catch (e) {
      // Раньше сбой выгрузки молча уходил в консоль.
      console.error('PDF export failed', e);
      notify.error(t('archive.pdfFailed'));
    } finally {
      setPdfBusy(false);
    }
  };

  const handlePrint = async () => {
    setRenderAll(true);
    // Два кадра: один на пересчёт состояния, второй на фактическую отрисовку.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    try {
      window.print();
    } finally {
      setRenderAll(false);
    }
  };

  // ---- Закрытие месяца из табеля ----
  const now = new Date();
  const [closeDialog, setCloseDialog] = useState<{ year: number; month: number } | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);

  const closeMonth = async () => {
    if (!closeDialog) return;
    setCloseBusy(true);
    try {
      const { year, month } = closeDialog;
      const timesheets = await api.listTimesheets(year, month);
      const rows = archiveRecordsForMonth(employees, timesheets, year, month);
      if (rows.length === 0) {
        notify.error(t('timesheet.archiveEmpty'));
        return;
      }
      const label = `${monthNames[month]} ${year}`;
      const existing = (await api.listArchives({ year })).filter(r => r.month === month + 1);
      const question = existing.length > 0
        ? t('timesheet.archiveReplace', { month: label, count: existing.length })
        : t('timesheet.archiveConfirm', { month: label, count: rows.length });
      if (!(await notify.confirm(question))) return;
      await api.createArchivesBulk(rows, { year, month: month + 1 });
      await fetchArchiveFacets();
      await fetchArchives(filters);
      notify.success(t('timesheet.archived', { month: label, count: rows.length }));
      setCloseDialog(null);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCloseBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-primary">{t('archive.title')}</h2>
          <p className="text-muted mt-1 no-print">{t('archive.subtitle')}</p>
          <p className="hidden print:block text-sm mt-1">{filterSummary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 no-print">
          <button
            onClick={() => setCloseDialog({ year: now.getFullYear(), month: now.getMonth() === 0 ? 11 : now.getMonth() - 1 })}
            className="flex items-center gap-2 px-4 py-2 bg-surface-3 text-primary rounded-lg hover:bg-surface-hover transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t('archive.addMonth')}
          </button>
          <button
            onClick={handleExportPDF}
            disabled={pdfBusy}
            className="flex items-center gap-2 px-4 py-2 bg-surface-3 text-primary rounded-lg hover:bg-surface-hover disabled:opacity-60 transition-colors"
          >
            <FileText className="w-4 h-4" />
            {pdfBusy ? t('common.loading') : 'PDF'}
          </button>
          <button
            onClick={handleExportExcel}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/25 transition-colors"
          >
            <Download className="w-4 h-4" />
            Excel
          </button>
          <button
            onClick={handlePrint}
            className="flex items-center gap-2 px-4 py-2 bg-accent-600 text-white rounded-lg hover:bg-accent-700 transition-colors"
          >
            <Printer className="w-4 h-4" />
            {t('employees.doc.print')}
          </button>
        </div>
      </div>

      <div className="bg-surface border border-subtle rounded-xl p-4 no-print">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label htmlFor="arc-year" className="block text-sm font-medium text-secondary mb-2">{t('archive.year')}</label>
            <select
              id="arc-year"
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
              className="w-full bg-surface-3 border border-line text-primary rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
            >
              <option value="all">{t('archive.allYears')}</option>
              {availableYears.map(year => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="arc-dep" className="block text-sm font-medium text-secondary mb-2">{t('orgchart.subdivision')}</label>
            <select
              id="arc-dep"
              value={selectedDepartment}
              onChange={(e) => setSelectedDepartment(e.target.value)}
              className="w-full bg-surface-3 border border-line text-primary rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
            >
              <option value="all">{t('timesheet.allDepartments')}</option>
              {availableDepartments.map(dept => (
                <option key={dept} value={dept}>{dept}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="arc-emp" className="block text-sm font-medium text-secondary mb-2">{t('timeoff.colEmployee')}</label>
            <select
              id="arc-emp"
              value={selectedEmployee}
              onChange={(e) => setSelectedEmployee(e.target.value)}
              className="w-full bg-surface-3 border border-line text-primary rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500"
            >
              <option value="all">{t('archive.allEmployees')}</option>
              {availableEmployees.map(emp => (
                <option key={emp.id} value={emp.id}>{emp.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-xl overflow-hidden print-container" id="archive-table-container">
        <div
          ref={scrollRef}
          className={`overflow-x-auto custom-scrollbar ${renderAll ? '' : 'overflow-y-auto max-h-[calc(100vh-24rem)]'}`}
        >
          <table className="w-full text-left">
            <thead className="bg-surface-3 text-secondary">
              <tr>
                <th className="p-table text-table font-medium">{t('archive.year')}</th>
                <th className="p-table text-table font-medium">{t('archive.month')}</th>
                <th className="p-table text-table font-medium">{t('timeoff.colEmployee')}</th>
                <th className="p-table text-table font-medium">{t('employees.col.department')}</th>
                <th className="p-table text-table font-medium">{t('employees.col.position')}</th>
                <th className="p-table text-table font-medium text-right">{t('archive.salary')}</th>
                <th className="p-table text-table font-medium text-right">{t('archive.colHours')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)] text-secondary">
              {records.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-table text-table text-center text-muted py-8">
                    {archiveFacets.years.length === 0 ? t('archive.emptyHint') : t('archive.noData')}
                  </td>
                </tr>
              ) : (
                <>
                  {paddingTop > 0 && <tr style={{ height: paddingTop }} aria-hidden />}
                  {renderedRecords.map((record) => (
                    <tr key={record.id} className="hover:bg-surface-hover transition-colors">
                      <td className="p-table text-table font-medium text-primary tabular-nums">{record.year}</td>
                      <td className="p-table text-table">{monthLabel(record.month)}</td>
                      <td className="p-table text-table text-accent-700 dark:text-accent-400">{record.employeeName}</td>
                      <td className="p-table text-table">{record.department}</td>
                      <td className="p-table text-table">{record.position}</td>
                      <td className="p-table text-table text-right font-medium tabular-nums">{money.format(record.salary)}</td>
                      <td className="p-table text-table text-right tabular-nums">{record.hoursWorked} {t('archive.hoursShort')}</td>
                    </tr>
                  ))}
                  {paddingBottom > 0 && <tr style={{ height: paddingBottom }} aria-hidden />}
                </>
              )}
            </tbody>
            {records.length > 0 && (
              <tfoot>
                <tr className="bg-surface-3 font-semibold text-primary">
                  <td className="p-table text-table" colSpan={5}>{t('reports.total')}: {t('reports.totalCount', { count: records.length })}</td>
                  <td className="p-table text-table text-right tabular-nums">{money.format(totalSalary)}</td>
                  <td className="p-table text-table text-right tabular-nums">{totalHours} {t('archive.hoursShort')}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {closeDialog && (
        <Modal
          title={t('archive.addMonth')}
          onClose={() => setCloseDialog(null)}
          footer={(
            <>
              <button onClick={() => setCloseDialog(null)} className={secondaryButton}>{t('common.cancel')}</button>
              <button onClick={closeMonth} disabled={closeBusy} className={primaryButton}>{t('archive.addMonthDo')}</button>
            </>
          )}
        >
          <div className="space-y-4">
            <p className="text-sm text-muted">{t('archive.addMonthHint')}</p>
            <div className="grid grid-cols-2 gap-4">
              <Field id="close-month" label={t('archive.month')}>
                <select id="close-month" value={closeDialog.month} onChange={(e) => setCloseDialog({ ...closeDialog, month: Number(e.target.value) })} className={inputClass}>
                  {monthNames.map((name, i) => <option key={name} value={i}>{name}</option>)}
                </select>
              </Field>
              <Field id="close-year" label={t('archive.year')}>
                <input id="close-year" type="number" min={2000} max={2100} value={closeDialog.year} onChange={(e) => setCloseDialog({ ...closeDialog, year: Number(e.target.value) || now.getFullYear() })} className={inputClass} />
              </Field>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
