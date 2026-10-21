import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { exportToExcel } from '../lib/excel';
import { ATTENDANCE_CODES, codeForDay, employedInMonth, isWeekend, nextCode, timesheetTotals } from '../lib/timesheet';
import { archiveRecordsForMonth, employmentOf, monthNotEnded } from '../lib/archiveMonth';
import { useTranslation } from 'react-i18next';
import { Clock, Calendar as CalendarIcon, Save, ChevronLeft, ChevronRight, Download, Archive as ArchiveIcon, AlertTriangle } from 'lucide-react';
import { useDatabaseStore } from '../store/useDatabaseStore';
import { useNotify } from '../components/Toasts';
import * as api from '../data';

type DaysByEmployee = Record<string, Record<number, string>>;

/**
 * Черновики несохранённых правок по месяцам. Живут, пока открыто окно:
 * ушли на другой экран и вернулись — правки на месте и видно, что они не
 * сохранены. Раньше они пропадали молча при переходе или смене месяца.
 */
const drafts = new Map<string, DaysByEmployee>();
const draftKey = (year: number, month: number) => `${year}-${month}`;

// Закрыть окно с несохранённым табелем — с предупреждением браузера/оболочки.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (drafts.size > 0) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

export default function Timesheet() {
  const { t } = useTranslation();
  const { employees, timesheets, addTimesheet, updateTimesheet, fetchTimesheets } = useDatabaseStore();
  const notify = useNotify();

  const [currentDate, setCurrentDate] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDepartment, setSelectedDepartment] = useState<string>('all');
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthNames = t('timesheet.months', { returnObjects: true }) as string[];
  const monthLabel = `${monthNames[month]} ${year}`;

  // В табеле месяца — только те, кто работал в нём хотя бы день: принятые
  // позже и уволенные раньше сюда не попадают.
  const monthEmployees = useMemo(
    () => employees
      .filter((e) => employedInMonth(employmentOf(e), year, month))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')),
    [employees, year, month],
  );
  const availableDepartments = useMemo(() => Array.from(new Set(monthEmployees.map(e => e.department))).sort((a, b) => a.localeCompare(b, 'ru')), [monthEmployees]);
  const filteredEmployees = useMemo(
    () => monthEmployees.filter(e => selectedDepartment === 'all' || e.department === selectedDepartment),
    [monthEmployees, selectedDepartment],
  );

  // Табель грузится помесячно: вся таблица на 10 000 сотрудников — это годы
  // записей, из которых на экране нужен ровно один месяц.
  useEffect(() => {
    fetchTimesheets(year, month);
  }, [fetchTimesheets, year, month]);

  const savedDays = useMemo(() => {
    const out: DaysByEmployee = {};
    for (const emp of employees) {
      const record = timesheets.find(r => r.year === year && r.month === month && r.employeeId === emp.id);
      out[emp.id] = record ? { ...record.days } : {};
    }
    return out;
  }, [employees, timesheets, year, month]);

  const [localDays, setLocalDays] = useState<DaysByEmployee>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const draft = drafts.get(draftKey(year, month));
    setLocalDays(draft ? { ...savedDays, ...draft } : savedDays);
    setDirty(Boolean(draft));
  }, [savedDays, year, month]);

  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const codeLabels: Record<string, string> = {
    'Я': t('timesheet.codes.attendance'),
    'В': t('timesheet.codes.weekend'),
    'ОТ': t('timesheet.codes.vacation'),
    'Б': t('timesheet.codes.sick'),
    'К': t('timesheet.codes.trip'),
    'ОГ': t('timesheet.codes.dayoff'),
    'ВМ': t('timesheet.codes.shift'),
    'МВ': t('timesheet.codes.shiftRest'),
    'НН': t('timesheet.codes.absenceUnknown'),
    'ПР': t('timesheet.codes.truancy'),
  };

  const toggleDayStatus = (empId: string, day: number) => {
    setLocalDays(prev => {
      const days = prev[empId] ?? {};
      const next = { ...prev, [empId]: { ...days, [day]: nextCode(days, year, month, day) } };
      drafts.set(draftKey(year, month), next);
      return next;
    });
    setDirty(true);
  };

  /** Сохранение месяца. Возвращает false, если что-то не записалось. */
  const saveMonth = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    try {
      // Записи — только тем, кто работал в этом месяце.
      await Promise.all(monthEmployees.map(emp => {
        const record = timesheets.find(r => r.year === year && r.month === month && r.employeeId === emp.id);
        const days = localDays[emp.id] || {};
        return record
          ? updateTimesheet(record.id, { days })
          : addTimesheet({ year, month, employeeId: emp.id, days });
      }));
      drafts.delete(draftKey(year, month));
      setDirty(false);
      notify.success(t('timesheet.saved'));
      return true;
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [monthEmployees, timesheets, year, month, localDays, updateTimesheet, addTimesheet, notify, t]);

  const discardChanges = async () => {
    if (!(await notify.confirm(t('timesheet.discardConfirm', { month: monthLabel }), { danger: true }))) return;
    drafts.delete(draftKey(year, month));
    setLocalDays(savedDays);
    setDirty(false);
  };

  // Смена месяца с несохранёнными правками: предлагаем сохранить. Отказ не
  // стирает правки — они остаются черновиком этого месяца.
  const goToMonth = async (offset: number) => {
    if (dirty && (await notify.confirm(t('timesheet.saveBeforeLeave', { month: monthLabel })))) {
      if (!(await saveMonth())) return;
    }
    setCurrentDate(new Date(year, month + offset, 1));
  };

  // Выгрузка: сотрудник и должность, затем дни месяца, затем итоги — тот же
  // расчёт, что и на экране. Порядок колонок задаётся явно: числовые ключи
  // JavaScript ставит вперёд, и раньше дни оказывались левее фамилии.
  const handleDownload = async () => {
    const colName = t('timeoff.colEmployee');
    const colPosition = t('employees.col.position');
    const dayCols = Array.from({ length: daysInMonth }, (_, i) => String(i + 1));
    const colWorked = t('timesheet.colWorked');
    const colAtt = t('timesheet.colAttendances');
    const colHours = t('timesheet.colHours');

    const rows = filteredEmployees.map(emp => {
      const days = localDays[emp.id] || {};
      const range = employmentOf(emp);
      const row: Record<string, string | number> = { [colName]: emp.fullName, [colPosition]: emp.position };
      for (let day = 1; day <= daysInMonth; day += 1) row[String(day)] = codeForDay(days, year, month, day, range) || '—';
      const totals = timesheetTotals(days, year, month, range);
      row[colWorked] = totals.workDays;
      row[colAtt] = totals.attendances;
      row[colHours] = totals.hours;
      return row;
    });

    await exportToExcel(rows, `${t('timesheet.fileName')}_${year}-${String(month + 1).padStart(2, '0')}`, {
      sheetName: `${t('timesheet.sheetName')} ${monthLabel}`,
      columns: [colName, colPosition, ...dayCols, colWorked, colAtt, colHours],
      freezeColumns: 2,
    });
  };

  // Закрытие месяца в архив. Табель должен быть сохранён: архив пишется из
  // базы, а не из экрана.
  const handleArchive = async () => {
    if (dirty) {
      notify.error(t('timesheet.archiveNeedsSave'));
      return;
    }
    const records = archiveRecordsForMonth(employees, timesheets, year, month);
    if (records.length === 0) {
      notify.error(t('timesheet.archiveEmpty'));
      return;
    }
    // Незаконченный месяц ушёл бы в архив с явками за будущие дни.
    if (monthNotEnded(year, month) && !(await notify.confirm(t('timesheet.archiveNotEnded', { month: monthLabel }), { danger: true }))) return;
    try {
      const existing = (await api.listArchives({ year })).filter(r => r.month === month + 1);
      const question = existing.length > 0
        ? t('timesheet.archiveReplace', { month: monthLabel, count: existing.length })
        : t('timesheet.archiveConfirm', { month: monthLabel, count: records.length });
      if (!(await notify.confirm(question))) return;
      await api.createArchivesBulk(records, { year, month: month + 1 });
      notify.success(t('timesheet.archived', { month: monthLabel, count: records.length }));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  // Самый тяжёлый экран приложения: 10 000 сотрудников на 31 колонку дней —
  // это больше 300 000 узлов DOM. Виртуализируем строки; закреплённые слева
  // и справа колонки при этом остаются на месте, потому что распорки —
  // обычные <tr>, а не обёртки вокруг таблицы.
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filteredEmployees.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 57,
    overscan: 10,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length > 0
    ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  // Итоговые колонки закреплены справа. Отступы считаются по фактической
  // ширине заголовков: раньше они были зашиты (60 и 120 px), и длинные
  // подписи — туркменские, крупный шрифт — наезжали друг на друга.
  const hoursTh = useRef<HTMLTableCellElement>(null);
  const attTh = useRef<HTMLTableCellElement>(null);
  const [stickyRight, setStickyRight] = useState({ att: 0, worked: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const hours = hoursTh.current?.offsetWidth ?? 0;
      const att = attTh.current?.offsetWidth ?? 0;
      setStickyRight(prev => (prev.att === hours && prev.worked === hours + att ? prev : { att: hours, worked: hours + att }));
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (hoursTh.current) observer?.observe(hoursTh.current);
    if (attTh.current) observer?.observe(attTh.current);
    return () => observer?.disconnect();
  }, [t]);

  const stickyShadow = 'shadow-[-4px_0_10px_-4px_rgba(0,0,0,0.35)]';

  return (
    <div className="space-y-4 h-[calc(100vh-8rem)] flex flex-col">
      <div className="flex flex-wrap justify-between items-center gap-3 flex-shrink-0">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-primary flex items-center gap-2">
            <Clock className="w-6 h-6 text-accent-500" />
            {t('timesheet.title')}
          </h2>
          <p className="text-muted mt-1">{t('timesheet.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleArchive}
            title={t('timesheet.archiveHint')}
            className="flex items-center gap-2 bg-surface-3 hover:bg-surface-hover text-secondary px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            <ArchiveIcon className="w-4 h-4" />
            {t('timesheet.archive')}
          </button>
          <button
            onClick={handleDownload}
            className="flex items-center gap-2 bg-surface-3 hover:bg-surface-hover text-secondary px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            <Download className="w-4 h-4" />
            {t('timesheet.download')}
          </button>
          <button
            onClick={() => void saveMonth()}
            disabled={busy}
            className="flex items-center gap-2 bg-accent-600 hover:bg-accent-700 disabled:opacity-60 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            <Save className="w-4 h-4" />
            {t('common.save')}
          </button>
        </div>
      </div>

      {dirty && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm flex-shrink-0">
          <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400" />
          <span className="text-amber-800 dark:text-amber-300 flex-1">{t('timesheet.unsaved', { month: monthLabel })}</span>
          <button onClick={() => void saveMonth()} className="font-medium text-accent-700 dark:text-accent-400 hover:underline">{t('common.save')}</button>
          <button onClick={discardChanges} className="font-medium text-secondary hover:underline">{t('timesheet.discard')}</button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 bg-surface border border-line p-4 rounded-2xl flex-shrink-0">
        <div className="flex items-center gap-4">
          <select
            value={selectedDepartment}
            onChange={(e) => setSelectedDepartment(e.target.value)}
            aria-label={t('employees.col.department')}
            className="bg-surface-3 border border-line text-primary rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
          >
            <option value="all">{t('timesheet.allDepartments')}</option>
            {availableDepartments.map(dept => (
              <option key={dept} value={dept}>{dept}</option>
            ))}
          </select>
          <button onClick={() => void goToMonth(-1)} aria-label={t('timesheet.prevMonth')} className="p-2 hover:bg-surface-hover rounded-lg transition-colors">
            <ChevronLeft className="w-5 h-5 text-muted" />
          </button>
          <div className="flex items-center gap-2 min-w-[140px] justify-center">
            <CalendarIcon className="w-5 h-5 text-accent-500" />
            <span className="font-semibold text-lg text-primary" data-testid="timesheet-month">{monthLabel}</span>
          </div>
          <button onClick={() => void goToMonth(1)} aria-label={t('timesheet.nextMonth')} className="p-2 hover:bg-surface-hover rounded-lg transition-colors">
            <ChevronRight className="w-5 h-5 text-muted" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs justify-end max-w-xl">
          {Object.entries(ATTENDANCE_CODES).map(([code, info]) => (
            <div key={code} className="flex items-center gap-1.5">
              <span className={`w-6 h-6 flex items-center justify-center rounded ${info.color} font-medium`}>
                {code}
              </span>
              <span className="text-secondary">{codeLabels[code]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-hidden bg-surface-2 border border-line rounded-2xl flex flex-col">
        <div ref={scrollRef} className="overflow-x-auto overflow-y-auto custom-scrollbar flex-1">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="text-xs text-muted uppercase bg-surface-3 sticky top-0 z-20">
              <tr>
                <th className="p-table text-table border-b border-line sticky left-0 bg-surface-3 z-30 min-w-[200px]">{t('timeoff.colEmployee')}</th>
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const weekend = isWeekend(year, month, i + 1);
                  return (
                    <th key={i} className={`px-1 py-3 text-center border-b border-line border-l border-subtle min-w-[36px] ${weekend ? 'text-rose-700 dark:text-rose-300 bg-rose-500/5' : ''}`}>
                      {i + 1}
                    </th>
                  );
                })}
                <th style={{ right: stickyRight.worked }} className={`px-3 py-3 border-b border-line border-l text-center sticky bg-surface-3 z-30 whitespace-nowrap ${stickyShadow}`}>
                  {t('timesheet.colWorked')}
                </th>
                <th ref={attTh} style={{ right: stickyRight.att }} className={`px-3 py-3 border-b border-line border-l text-center sticky bg-surface-3 z-30 whitespace-nowrap ${stickyShadow}`}>
                  {t('timesheet.colAttendances')}
                </th>
                <th ref={hoursTh} className={`px-3 py-3 border-b border-line border-l text-center sticky right-0 bg-surface-3 z-30 whitespace-nowrap ${stickyShadow}`}>
                  {t('timesheet.colHours')}
                </th>
              </tr>
            </thead>
            <tbody>
              {paddingTop > 0 && <tr style={{ height: paddingTop }} aria-hidden />}
              {virtualRows.map(virtualRow => {
                const emp = filteredEmployees[virtualRow.index];
                const days = localDays[emp.id] || {};
                const range = employmentOf(emp);
                const totals = timesheetTotals(days, year, month, range);

                return (
                  <tr key={emp.id} className="border-b border-subtle hover:bg-surface-hover group">
                    <td className="px-4 py-2 font-medium text-primary sticky left-0 bg-surface group-hover:bg-surface-hover transition-colors z-10 border-r border-subtle">
                      <div className="truncate max-w-[180px]" title={emp.fullName}>{emp.fullName}</div>
                      <div className="text-xs text-muted font-normal truncate max-w-[180px]">{emp.position}</div>
                    </td>
                    {Array.from({ length: daysInMonth }).map((_, i) => {
                      const day = i + 1;
                      const code = codeForDay(days, year, month, day, range);
                      // Вне периода работы ячейка пустая и не нажимается.
                      if (!code) {
                        return (
                          <td key={i} title={t('timesheet.notEmployed')} className="px-1 py-2 text-center border-l border-subtle text-muted bg-surface-3/40 select-none">
                            —
                          </td>
                        );
                      }
                      const info = ATTENDANCE_CODES[code] || { color: 'text-muted' };
                      const weekend = isWeekend(year, month, day);
                      return (
                        <td key={i} className={`p-0 text-center border-l border-subtle ${weekend && !days[day] ? 'bg-rose-500/5' : ''}`}>
                          <button
                            type="button"
                            onClick={() => toggleDayStatus(emp.id, day)}
                            aria-label={t('timesheet.cellAria', { name: emp.fullName, day, code: codeLabels[code] ?? code })}
                            className={`w-full h-full min-h-[40px] px-1 py-2 hover:bg-surface-hover transition-colors ${info.color}`}
                          >
                            {code}
                          </button>
                        </td>
                      );
                    })}
                    <td style={{ right: stickyRight.worked }} className={`px-3 py-2 text-center border-l border-line font-medium text-secondary sticky bg-surface group-hover:bg-surface-hover z-10 whitespace-nowrap ${stickyShadow}`}>
                      {totals.workDays} {t('timeoff.daysUnit')}
                    </td>
                    <td style={{ right: stickyRight.att }} className={`px-3 py-2 text-center border-l border-line font-medium text-accent-700 dark:text-accent-400 sticky bg-surface group-hover:bg-surface-hover z-10 ${stickyShadow}`}>
                      {totals.attendances}
                    </td>
                    <td className={`px-3 py-2 text-center border-l border-line font-bold text-accent-700 dark:text-accent-400 sticky right-0 bg-surface group-hover:bg-surface-hover z-10 ${stickyShadow}`}>
                      {totals.hours}
                    </td>
                  </tr>
                );
              })}
              {paddingBottom > 0 && <tr style={{ height: paddingBottom }} aria-hidden />}
            </tbody>
          </table>
          {filteredEmployees.length === 0 && (
            <p className="p-12 text-center text-muted">{t('timesheet.noEmployees', { month: monthLabel })}</p>
          )}
        </div>
      </div>
    </div>
  );
}
