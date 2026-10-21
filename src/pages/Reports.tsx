import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, TrendingDown, ClipboardList, BarChart as BarChartIcon, Download, Save, Trash2 } from 'lucide-react';
import { exportToExcel, saveText } from '../lib/excel';
import { exportTablePdf } from '../lib/pdfTable';
import { useMoney } from '../lib/money';
import { useDates, fileStamp, localDateISO } from '../lib/dates';
import { positionStats } from '../lib/staffing';
import { ABSENCE_CODES, timesheetTotals } from '../lib/timesheet';
import { employmentOf } from '../lib/archiveMonth';
import { employeeCost } from '../lib/payroll';
import { turnoverByMonth } from '../lib/turnover';
import { useDatabaseStore, TABLES } from '../store/useDatabaseStore';
import type { ReportPreset } from '../store/useDatabaseStore';
import { useNotify } from '../components/Toasts';

/** Как показывать и выгружать колонку. Числа уходят в Excel числами. */
type ColumnKind = 'text' | 'number' | 'money' | 'percent';

interface ReportColumn {
  key: string;
  label: string;
  kind?: ColumnKind;
}

/**
 * Таблица отчёта. И экран, и выгрузка строятся из одного результата, поэтому
 * в файле оказывается ровно то, что человек видел на экране.
 */
type Cell = string | number | undefined;

interface ReportTable {
  columns: ReportColumn[];
  rows: Record<string, Cell>[];
  /** Строка «Итого» — отдельно, чтобы не участвовать в сортировке. */
  total?: Record<string, Cell>;
}

type SourceId = 'employees' | 'positions' | 'timesheets' | 'archives' | 'movements' | 'candidates';

/** Технические поля, которые в конструкторе не показываются. */
const HIDDEN_FIELDS = new Set(['id', 'days', 'snapshot', 'config']);

export default function Reports() {
  const { t } = useTranslation();
  const money = useMoney();
  const dates = useDates();
  const notify = useNotify();

  const [activeTab, setActiveTab] = useState('catalog');
  const [selectedReport, setSelectedReport] = useState<number | null>(null);

  const {
    employees, positions, departments, timesheets, archives, movements, candidates,
    reportPresets, fetchTimesheets, fetchArchives, createIn, removeFrom,
  } = useDatabaseStore();

  const now = new Date();
  const [period, setPeriod] = useState({ year: now.getFullYear(), month: now.getMonth() });

  // Табель и архив грузятся срезом и в общий fetchAll не входят — экран
  // отчётов запрашивает их сам (и для каталога, и для конструктора).
  useEffect(() => {
    fetchTimesheets(period.year, period.month);
  }, [fetchTimesheets, period.year, period.month]);

  useEffect(() => {
    fetchArchives({ year: period.year });
  }, [fetchArchives, period.year]);

  const employeeName = (id: string, stored?: string) => employees.find(e => e.id === id)?.fullName ?? stored ?? '—';

  const statusLabel = (status: string) =>
    status === 'active' ? t('employees.status.active')
      : status === 'probation' ? t('employees.status.probation')
        : status === 'dismissed' ? t('employees.status.dismissed')
          : status === 'on_leave' ? t('employees.status.onLeave') : status;

  const reports = [
    { id: 1, icon: Users, title: t('reports.items.headcountTitle'), desc: t('reports.items.headcountDesc') },
    { id: 2, icon: TrendingDown, title: t('reports.items.turnoverTitle'), desc: t('reports.items.turnoverDesc') },
    { id: 3, icon: ClipboardList, title: t('reports.items.timesheetTitle'), desc: t('reports.items.timesheetDesc') },
    { id: 4, icon: BarChartIcon, title: t('reports.items.movementsTitle'), desc: t('reports.items.movementsDesc') },
    { id: 5, icon: Users, title: t('reports.items.staffingTitle'), desc: t('reports.items.staffingDesc') },
  ];

  const monthNames = t('timesheet.months', { returnObjects: true }) as string[];
  const movementType = (type: string) =>
    type === 'hire' ? t('movements.hire') : type === 'transfer' ? t('movements.transfer') : t('movements.dismissal');

  const reportTable = useMemo<ReportTable | null>(() => {
    if (!selectedReport) return null;

    // 1. Списочная численность — работающие сотрудники; уволенные в неё не
    // входят, хотя карточки остаются в картотеке.
    if (selectedReport === 1) {
      const staff = employees
        .filter(e => e.status !== 'dismissed')
        .sort((a, b) => a.department.localeCompare(b.department, 'ru') || a.fullName.localeCompare(b.fullName, 'ru'));
      return {
        columns: [
          { key: 'fullName', label: t('employees.col.fullName') },
          { key: 'tabNumber', label: t('employees.col.tabNumber') },
          { key: 'position', label: t('employees.col.position') },
          { key: 'department', label: t('employees.col.department') },
          { key: 'hireDate', label: t('employees.form.hireDate') },
          { key: 'status', label: t('employees.col.status') },
          { key: 'rate', label: t('employees.col.rate'), kind: 'number' },
          { key: 'salary', label: t('reports.salaryByRate'), kind: 'money' },
        ],
        rows: staff.map(e => ({
          fullName: e.fullName,
          tabNumber: e.tabNumber ?? '',
          position: e.position,
          department: e.department,
          hireDate: dates.date(e.hireDate),
          status: statusLabel(e.status),
          rate: e.rate ?? 1,
          salary: employeeCost(e),
        })),
        total: {
          fullName: t('reports.totalCount', { count: staff.length }),
          rate: staff.reduce((s, e) => s + (e.rate ?? 1), 0),
          salary: staff.reduce((s, e) => s + employeeCost(e), 0),
        },
      };
    }

    // 2. Текучесть за год: по кадровым операциям и по датам в карточках —
    // сотрудники, заведённые карточкой, а не приказом, тоже учитываются.
    if (selectedReport === 2) {
      const stats = turnoverByMonth(employees, movements, period.year);
      return {
        columns: [
          { key: 'month', label: t('reports.month') },
          { key: 'start', label: t('reports.headcountStart'), kind: 'number' },
          { key: 'hired', label: t('reports.hired'), kind: 'number' },
          { key: 'dismissed', label: t('reports.dismissed'), kind: 'number' },
          { key: 'average', label: t('reports.averageHeadcount'), kind: 'number' },
          { key: 'turnover', label: t('reports.turnoverRate'), kind: 'percent' },
        ],
        rows: stats.months.map((m, i) => ({
          month: monthNames[i],
          start: m.start,
          hired: m.hired,
          dismissed: m.dismissed,
          average: m.average,
          turnover: m.turnover,
        })),
        total: {
          month: t('reports.total'),
          start: stats.year.start,
          hired: stats.year.hired,
          dismissed: stats.year.dismissed,
          average: stats.year.average,
          turnover: stats.year.turnover,
        },
      };
    }

    // 3. Табель за месяц: отработано, явки, часы и неявки по видам. Раньше
    // колонка «Итого» считалась как «дни месяца минус отработанные», и
    // выходные попадали в отсутствия.
    if (selectedReport === 3) {
      const rows = employees
        .map(emp => {
          const record = timesheets.find(ts => ts.employeeId === emp.id && ts.year === period.year && ts.month === period.month);
          const totals = timesheetTotals(record?.days ?? {}, period.year, period.month, employmentOf(emp));
          return { emp, totals };
        })
        .filter(({ totals }) => totals.employedDays > 0)
        .sort((a, b) => a.emp.fullName.localeCompare(b.emp.fullName, 'ru'))
        .map(({ emp, totals }) => {
          const row: Record<string, string | number> = {
            fullName: emp.fullName,
            position: emp.position,
            worked: totals.workDays,
            attendances: totals.attendances,
            hours: totals.hours,
          };
          for (const code of ABSENCE_CODES) row[code] = totals.codes[code] ?? 0;
          return row;
        });
      const sum = (key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
      const total: Record<string, string | number> = { fullName: t('reports.total'), worked: sum('worked'), attendances: sum('attendances'), hours: sum('hours') };
      for (const code of ABSENCE_CODES) total[code] = sum(code);
      return {
        columns: [
          { key: 'fullName', label: t('timeoff.colEmployee') },
          { key: 'position', label: t('employees.col.position') },
          { key: 'worked', label: t('timesheet.colWorked'), kind: 'number' },
          { key: 'attendances', label: t('timesheet.colAttendances'), kind: 'number' },
          { key: 'hours', label: t('timesheet.colHours'), kind: 'number' },
          ...ABSENCE_CODES.map(code => ({ key: code, label: code, kind: 'number' as const })),
        ],
        rows,
        total,
      };
    }

    // 4. Кадровые движения — из таблицы movements.
    if (selectedReport === 4) {
      const change = (from?: string | null, to?: string | null) => (!to || to === from ? (from || '—') : `${from || '—'} → ${to}`);
      return {
        columns: [
          { key: 'date', label: t('movements.date') },
          { key: 'type', label: t('movements.type') },
          { key: 'employee', label: t('movements.employee') },
          { key: 'position', label: t('employees.col.position') },
          { key: 'department', label: t('employees.col.department') },
          { key: 'orderNo', label: t('movements.orderNo') },
        ],
        rows: [...movements]
          .filter(m => m.date.startsWith(String(period.year)))
          .sort((a, b) => b.date.localeCompare(a.date))
          .map(m => ({
            date: dates.date(m.date),
            type: movementType(m.type),
            employee: employeeName(m.employeeId, m.employeeName),
            position: m.type === 'dismissal' ? (m.fromPosition ?? '—') : change(m.fromPosition, m.toPosition),
            department: m.type === 'dismissal' ? (m.fromDepartment ?? '—') : change(m.fromDepartment, m.toDepartment),
            orderNo: m.orderNo ?? '—',
          })),
      };
    }

    // 5. Штатное расписание (Т-3) со сводкой: единицы, занятость,
    // перекомплект и месячный фонд по окладам.
    const stats = positionStats(positions, employees, departments)
      .sort((a, b) => a.department.localeCompare(b.department, 'ru') || a.title.localeCompare(b.title, 'ru'));
    return {
      columns: [
        { key: 'department', label: t('employees.col.department') },
        { key: 'position', label: t('employees.col.position') },
        { key: 'total', label: t('orgchart.staffUnits'), kind: 'number' },
        { key: 'occupied', label: t('orgchart.occupied'), kind: 'number' },
        { key: 'vacant', label: t('orgchart.vacant'), kind: 'number' },
        { key: 'over', label: t('orgchart.over'), kind: 'number' },
        { key: 'salary', label: t('orgchart.salary'), kind: 'money' },
        { key: 'fund', label: t('reports.fund'), kind: 'money' },
      ],
      rows: stats.map(stat => ({
        department: stat.department,
        position: stat.title,
        total: stat.total,
        occupied: stat.occupied,
        vacant: stat.vacant,
        over: stat.over,
        salary: stat.salary,
        fund: stat.total * stat.salary,
      })),
      total: {
        department: t('reports.total'),
        total: stats.reduce((s, x) => s + x.total, 0),
        occupied: stats.reduce((s, x) => s + x.occupied, 0),
        vacant: stats.reduce((s, x) => s + x.vacant, 0),
        over: stats.reduce((s, x) => s + x.over, 0),
        fund: stats.reduce((s, x) => s + x.total * x.salary, 0),
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedReport, employees, positions, departments, timesheets, movements, period, monthNames, money, dates, t]);

  const display = (col: ReportColumn, value: Cell) => {
    if (value === undefined || value === '') return '';
    if (col.kind === 'money') return money.format(Number(value));
    if (col.kind === 'percent') return `${Number(value).toFixed(1)}%`;
    if (col.kind === 'number' && typeof value === 'number' && !Number.isInteger(value)) return value.toFixed(2);
    return String(value);
  };

  // В Excel числа уходят числами (с форматом), а не текстом «6 000 TMT»:
  // иначе их нельзя сложить в самой таблице.
  const excelValue = (col: ReportColumn, value: Cell) => {
    if (value === undefined || value === '') return '';
    if (col.kind === 'percent') return Number(value) / 100;
    return value;
  };

  const handleExportReport = async () => {
    if (!reportTable) return;
    const all = reportTable.total ? [...reportTable.rows, reportTable.total] : reportTable.rows;
    const rows = all.map(row => Object.fromEntries(reportTable.columns.map(col => [col.label, excelValue(col, row[col.key])])));
    const numberFormats: Record<string, string> = {};
    for (const col of reportTable.columns) {
      if (col.kind === 'money') numberFormats[col.label] = '#,##0.00';
      if (col.kind === 'percent') numberFormats[col.label] = '0.0%';
    }
    const title = reports.find(r => r.id === selectedReport)?.title ?? 'Report';
    await exportToExcel(rows, `${title}_${fileStamp()}`, {
      sheetName: title,
      numberFormats,
      columns: reportTable.columns.map(c => c.label),
    });
  };

  const handleExportReportPdf = async () => {
    if (!reportTable) return;
    const title = reports.find(r => r.id === selectedReport)?.title ?? 'Report';
    const periodText = selectedReport === 3 ? `${monthNames[period.month]} ${period.year}`
      : selectedReport === 2 || selectedReport === 4 ? String(period.year) : dates.date(localDateISO());
    try {
      await exportTablePdf({
        title,
        subtitle: periodText,
        columns: reportTable.columns.map(c => ({ label: c.label, align: c.kind && c.kind !== 'text' ? 'right' as const : 'left' as const })),
        rows: reportTable.rows.map(row => reportTable.columns.map(col => display(col, row[col.key]))),
        footer: reportTable.total ? reportTable.columns.map(col => display(col, reportTable.total![col.key])) : undefined,
        fileName: `${title}_${fileStamp()}`,
      });
    } catch (e) {
      console.error('PDF export failed', e);
      notify.error(t('archive.pdfFailed'));
    }
  };

  // ---- Конструктор ----

  const departmentName = (id: unknown) => departments.find(d => d.id === id)?.name ?? String(id ?? '');

  // Строки источников уже «очеловечены»: вместо идентификаторов — имена,
  // вместо кодов статусов — подписи, даты — в формате из настроек. Табель
  // разворачивается в итоги, а не в JSON дней.
  const sources = useMemo<{ id: SourceId; label: string; rows: Record<string, unknown>[] }[]>(() => [
    {
      id: 'employees', label: t('reports.srcEmployees'),
      rows: employees.map(e => ({
        fullName: e.fullName, tabNumber: e.tabNumber ?? '', position: e.position, department: e.department,
        status: statusLabel(e.status), hireDate: dates.date(e.hireDate), dismissalDate: e.dismissalDate ? dates.date(e.dismissalDate) : '',
        birthDate: e.birthDate ? dates.date(e.birthDate) : '', paymentType: t(`employees.form.pay.${e.paymentType ?? 'salary'}`),
        salary: e.salary ?? 0, rate: e.rate ?? 1,
      })),
    },
    {
      id: 'positions', label: t('reports.srcPositions'),
      rows: positions.map(p => ({ department: departmentName(p.departmentId), title: p.title, maxCount: p.maxCount, salary: p.salary })),
    },
    {
      id: 'timesheets', label: `${t('reports.srcTimesheets')} (${monthNames[period.month]} ${period.year})`,
      rows: employees
        .map(emp => ({ emp, totals: timesheetTotals(timesheets.find(ts => ts.employeeId === emp.id && ts.year === period.year && ts.month === period.month)?.days ?? {}, period.year, period.month, employmentOf(emp)) }))
        .filter(({ totals }) => totals.employedDays > 0)
        .map(({ emp, totals }) => ({
          fullName: emp.fullName, department: emp.department, position: emp.position,
          workDays: totals.workDays, attendances: totals.attendances, hours: totals.hours,
        })),
    },
    {
      id: 'archives', label: `${t('reports.srcArchives')} (${period.year})`,
      rows: archives.map(a => ({ year: a.year, month: monthNames[a.month - 1] ?? a.month, fullName: a.employeeName, department: a.department, position: a.position, salary: a.salary, hoursWorked: a.hoursWorked })),
    },
    {
      id: 'movements', label: t('reports.srcMovements'),
      rows: movements.map(m => ({
        date: dates.date(m.date), type: movementType(m.type), fullName: employeeName(m.employeeId, m.employeeName),
        fromPosition: m.fromPosition ?? '', toPosition: m.toPosition ?? '', fromDepartment: m.fromDepartment ?? '', toDepartment: m.toDepartment ?? '',
        fromSalary: m.fromSalary, toSalary: m.toSalary, orderNo: m.orderNo ?? '', reason: m.reason ?? '',
      })),
    },
    {
      id: 'candidates', label: t('reports.srcCandidates'),
      // Этап — подписью воронки, а не кодом «screening».
      rows: candidates.map(c => ({
        fullName: c.fullName, position: c.position, experience: c.experience ?? '',
        status: t(`recruiting.col.${c.status}`, { defaultValue: c.status }),
        createdAt: c.createdAt ? dates.date(c.createdAt) : '', note: c.note ?? '',
      })),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [employees, positions, departments, timesheets, archives, movements, candidates, period, dates, t]);

  const fieldLabel = (field: string) => t(`reports.fieldNames.${field}`, { defaultValue: field });

  const [source, setSource] = useState<SourceId>('employees');
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [filterField, setFilterField] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [groupBy, setGroupBy] = useState('');
  const [presetName, setPresetName] = useState('');

  const sourceRows = useMemo(() => sources.find(s => s.id === source)?.rows ?? [], [sources, source]);

  const availableFields = useMemo(() => {
    const keys = new Set<string>();
    for (const row of sourceRows.slice(0, 50)) {
      Object.keys(row).filter(k => !HIDDEN_FIELDS.has(k)).forEach(k => keys.add(k));
    }
    return Array.from(keys);
  }, [sourceRows]);

  // Выбор полей выводится, а не сбрасывается эффектом: при смене источника
  // колонок из прежнего набора в нём просто не остаётся, а пустой выбор
  // заполняется первыми пятью полями нового источника.
  const activeFields = useMemo(() => {
    const kept = selectedFields.filter(field => availableFields.includes(field));
    return kept.length > 0 ? kept : availableFields.slice(0, 5);
  }, [selectedFields, availableFields]);

  const activeFilterField = availableFields.includes(filterField) ? filterField : '';
  const activeGroupBy = activeFields.includes(groupBy) ? groupBy : '';

  const builderRows = useMemo(() => {
    let rows = sourceRows;

    if (filterValue) {
      const needle = filterValue.toLowerCase();
      rows = rows.filter(row => {
        const fields = activeFilterField ? [activeFilterField] : Object.keys(row);
        return fields.some(f => String(row[f] ?? '').toLowerCase().includes(needle));
      });
    }

    const projected = rows.map(row => {
      const out: Record<string, string | number> = {};
      for (const field of activeFields) {
        const value = row[field];
        out[field] = typeof value === 'object' && value !== null ? JSON.stringify(value) : (value as any) ?? '';
      }
      return out;
    });

    if (!activeGroupBy) return projected;
    // Группировка — сортировка по ключу: строки одной группы идут подряд,
    // а сам ключ остаётся колонкой, поэтому выгрузка не теряет структуру.
    return projected.slice().sort((a, b) => String(a[activeGroupBy]).localeCompare(String(b[activeGroupBy]), 'ru'));
  }, [sourceRows, activeFilterField, filterValue, activeFields, activeGroupBy]);

  const toggleField = (field: string) => {
    setSelectedFields(prev => (prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field]));
  };

  const handleSavePreset = async () => {
    if (!presetName.trim()) return;
    await createIn<ReportPreset>(TABLES.reportPresets, {
      name: presetName.trim(),
      config: JSON.stringify({ source, selectedFields: activeFields, filterField: activeFilterField, filterValue, groupBy: activeGroupBy }),
    });
    setPresetName('');
    notify.success(t('reports.presetSaved'));
  };

  const applyPreset = (preset: ReportPreset) => {
    try {
      const config = JSON.parse(preset.config);
      setSource(config.source ?? 'employees');
      setSelectedFields(config.selectedFields ?? []);
      setFilterField(config.filterField ?? '');
      setFilterValue(config.filterValue ?? '');
      setGroupBy(config.groupBy ?? '');
    } catch {
      // Набор с испорченным JSON просто не применяем.
    }
  };

  const deletePreset = async (preset: ReportPreset) => {
    if (!(await notify.confirm(t('reports.presetDeleteConfirm', { name: preset.name }), { danger: true }))) return;
    await removeFrom(TABLES.reportPresets, preset.id);
  };

  const labelledRows = () => builderRows.map(row => Object.fromEntries(activeFields.map(f => [fieldLabel(f), row[f]])));

  const handleBuilderExcel = async () => {
    if (builderRows.length === 0) return;
    const label = sources.find(s => s.id === source)?.label ?? source;
    await exportToExcel(labelledRows(), `${label}_${fileStamp()}`, { sheetName: label });
  };

  const handleBuilderJson = async () => {
    if (builderRows.length === 0) return;
    await saveText(JSON.stringify(builderRows, null, 2), `report-${source}_${fileStamp()}.json`, 'application/json');
  };

  const control = 'w-full bg-app border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-primary';
  const needsMonth = selectedReport === 3 || (activeTab === 'constructor' && source === 'timesheets');
  const needsYear = selectedReport === 2 || selectedReport === 3 || selectedReport === 4
    || (activeTab === 'constructor' && (source === 'timesheets' || source === 'archives'));

  const periodControls = (
    <>
      {needsMonth && (
        <select
          aria-label={t('reports.month')}
          value={period.month}
          onChange={(e) => setPeriod({ ...period, month: Number(e.target.value) })}
          className="bg-app border border-line rounded-xl px-3 py-2 text-sm text-primary"
        >
          {monthNames.map((name, i) => <option key={name} value={i}>{name}</option>)}
        </select>
      )}
      {needsYear && (
        <input
          type="number"
          aria-label={t('reports.year')}
          value={period.year}
          min={2000}
          max={2100}
          onChange={(e) => setPeriod({ ...period, year: Number(e.target.value) || now.getFullYear() })}
          className="w-24 bg-app border border-line rounded-xl px-3 py-2 text-sm text-primary"
        />
      )}
    </>
  );

  const renderReportContent = () => {
    if (!selectedReport || !reportTable) {
      return (
        <div className="flex-1 rounded-2xl border border-dashed border-line bg-surface-2 flex items-center justify-center">
          <p className="text-muted text-sm">{t('reports.selectReport')}</p>
        </div>
      );
    }

    const report = reports.find(r => r.id === selectedReport);

    return (
      <div className="flex-1 rounded-2xl border border-line bg-surface flex flex-col overflow-hidden">
        <div className="p-6 border-b border-line flex flex-wrap justify-between items-center gap-4 bg-surface-2">
          <div>
            <h3 className="font-semibold text-lg text-primary">{report?.title}</h3>
            <p className="text-sm text-muted">{report?.desc}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {periodControls}
            <button
              onClick={handleExportReport}
              className="flex items-center gap-2 bg-surface-3 hover:bg-surface-hover border border-strong px-4 py-2 rounded-xl text-sm font-medium transition-colors"
            >
              <Download className="w-4 h-4" /> {t('reports.downloadExcel')}
            </button>
            <button
              onClick={handleExportReportPdf}
              className="flex items-center gap-2 bg-surface-3 hover:bg-surface-hover border border-strong px-4 py-2 rounded-xl text-sm font-medium transition-colors"
            >
              <Download className="w-4 h-4" /> PDF
            </button>
          </div>
        </div>

        {selectedReport === 3 && (
          <p className="px-6 pt-4 text-xs text-muted">{t('reports.timesheetLegend')}</p>
        )}

        <div className="p-6 overflow-auto custom-scrollbar flex-1">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted uppercase bg-surface-3">
              <tr>
                {reportTable.columns.map((col, i) => (
                  <th
                    key={col.key}
                    className={`p-table text-table ${col.kind && col.kind !== 'text' ? 'text-right' : ''} ${i === 0 ? 'rounded-tl-xl' : ''} ${i === reportTable.columns.length - 1 ? 'rounded-tr-xl' : ''}`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reportTable.rows.map((row, i) => (
                <tr key={i} className="border-b border-line hover:bg-surface-hover">
                  {reportTable.columns.map((col, j) => (
                    <td key={col.key} className={`p-table text-table ${j === 0 ? 'font-medium text-primary' : 'text-secondary'} ${col.kind && col.kind !== 'text' ? 'text-right tabular-nums' : ''}`}>
                      {display(col, row[col.key])}
                    </td>
                  ))}
                </tr>
              ))}
              {reportTable.rows.length === 0 && (
                <tr>
                  <td colSpan={reportTable.columns.length} className="p-table text-table text-center text-muted py-8">
                    {t('reports.noData')}
                  </td>
                </tr>
              )}
            </tbody>
            {reportTable.total && reportTable.rows.length > 0 && (
              <tfoot>
                <tr className="bg-surface-3 font-semibold text-primary" data-testid="report-total">
                  {reportTable.columns.map(col => (
                    <td key={col.key} className={`p-table text-table ${col.kind && col.kind !== 'text' ? 'text-right tabular-nums' : ''}`}>
                      {display(col, reportTable.total![col.key])}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    );
  };

  const renderBuilder = () => (
    <div className="flex-1 rounded-2xl border border-line bg-surface flex flex-col overflow-hidden">
      <div className="p-6 border-b border-line bg-surface-2 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label htmlFor="rb-source" className="block text-xs font-medium text-muted mb-2">{t('reports.source')}</label>
            <div className="flex gap-2">
              <select id="rb-source" value={source} onChange={(e) => setSource(e.target.value as SourceId)} className={control}>
                {sources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            {(source === 'timesheets' || source === 'archives') && (
              <div className="flex gap-2 mt-2">{periodControls}</div>
            )}
          </div>
          <div>
            <label htmlFor="rb-filter-field" className="block text-xs font-medium text-muted mb-2">{t('reports.filterField')}</label>
            <select id="rb-filter-field" value={activeFilterField} onChange={(e) => setFilterField(e.target.value)} className={control}>
              <option value="">{t('reports.anyField')}</option>
              {availableFields.map(f => <option key={f} value={f}>{fieldLabel(f)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="rb-filter-value" className="block text-xs font-medium text-muted mb-2">{t('reports.filterValue')}</label>
            <input id="rb-filter-value" value={filterValue} onChange={(e) => setFilterValue(e.target.value)} className={control} />
          </div>
        </div>

        <div>
          <span className="block text-xs font-medium text-muted mb-2">{t('reports.fields')}</span>
          <div className="flex flex-wrap gap-2">
            {availableFields.map(field => (
              <button
                key={field}
                aria-pressed={activeFields.includes(field)}
                onClick={() => toggleField(field)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${activeFields.includes(field) ? 'bg-accent-500/20 text-accent-800 dark:text-accent-300 border-accent-500/40' : 'bg-surface-3 text-secondary border-line hover:bg-surface-hover'}`}
              >
                {fieldLabel(field)}
              </button>
            ))}
            {availableFields.length === 0 && <span className="text-xs text-muted">{t('reports.noData')}</span>}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label htmlFor="rb-group" className="block text-xs font-medium text-muted mb-2">{t('reports.groupBy')}</label>
            <select id="rb-group" value={activeGroupBy} onChange={(e) => setGroupBy(e.target.value)} className={control}>
              <option value="">{t('reports.noGrouping')}</option>
              {activeFields.map(f => <option key={f} value={f}>{fieldLabel(f)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="rb-preset" className="block text-xs font-medium text-muted mb-2">{t('reports.presetName')}</label>
            <input id="rb-preset" value={presetName} onChange={(e) => setPresetName(e.target.value)} className={control} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSavePreset}
              disabled={!presetName.trim()}
              className="flex items-center gap-2 bg-surface-3 hover:bg-surface-hover border border-line disabled:opacity-50 px-3 py-2 rounded-xl text-sm font-medium transition-colors"
            >
              <Save className="w-4 h-4" /> {t('reports.savePreset')}
            </button>
            <button
              onClick={handleBuilderExcel}
              disabled={builderRows.length === 0}
              className="flex items-center gap-2 bg-accent-600 hover:bg-accent-700 disabled:opacity-50 text-white px-3 py-2 rounded-xl text-sm font-medium transition-colors"
            >
              <Download className="w-4 h-4" /> Excel
            </button>
            <button
              onClick={handleBuilderJson}
              disabled={builderRows.length === 0}
              className="bg-surface-3 hover:bg-surface-hover border border-line disabled:opacity-50 px-3 py-2 rounded-xl text-sm font-medium transition-colors"
            >
              {t('reports.exportJson')}
            </button>
          </div>
        </div>

        {reportPresets.length > 0 && (
          <div>
            <span className="block text-xs font-medium text-muted mb-2">{t('reports.presets')}</span>
            <div className="flex flex-wrap gap-2">
              {reportPresets.map(preset => (
                <span key={preset.id} className="inline-flex items-center rounded-lg bg-surface-3 border border-line">
                  <button
                    onClick={() => applyPreset(preset)}
                    className="px-3 py-1.5 text-xs font-medium text-secondary hover:text-primary transition-colors"
                  >
                    {preset.name}
                  </button>
                  <button
                    onClick={() => deletePreset(preset)}
                    aria-label={t('reports.presetDelete', { name: preset.name })}
                    className="px-2 py-1.5 text-muted hover:text-rose-600 border-l border-line"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="p-6 overflow-auto custom-scrollbar flex-1">
        <p className="text-xs text-muted mb-3">{t('reports.rowsFound', { n: builderRows.length })}</p>

        {activeFields.length === 0 ? (
          <p className="text-sm text-muted text-center py-8">{t('reports.selectFields')}</p>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted uppercase bg-surface-3">
              <tr>
                {activeFields.map(field => (
                  <th key={field} className="p-table text-table">{fieldLabel(field)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {builderRows.slice(0, 200).map((row, i) => (
                <tr key={i} className="border-b border-line hover:bg-surface-hover">
                  {activeFields.map(field => (
                    <td key={field} className="p-table text-table text-secondary">{row[field]}</td>
                  ))}
                </tr>
              ))}
              {builderRows.length === 0 && (
                <tr>
                  <td colSpan={activeFields.length} className="p-table text-table text-center text-muted py-8">
                    {t('reports.noData')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6 h-[calc(100vh-8rem)] flex flex-col">
      <h2 className="text-2xl font-semibold tracking-tight">{t('nav.reports')}</h2>

      <div className="flex gap-1" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'catalog'}
          onClick={() => { setActiveTab('catalog'); setSelectedReport(null); }}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${activeTab === 'catalog' ? 'bg-surface-3 text-primary' : 'text-secondary hover:bg-surface-hover'}`}
        >
          {t('reports.catalog')}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'constructor'}
          onClick={() => setActiveTab('constructor')}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${activeTab === 'constructor' ? 'bg-surface-3 text-primary' : 'text-secondary hover:bg-surface-hover'}`}
        >
          {t('reports.constructorTitle')}
        </button>
      </div>

      <div className="flex flex-1 gap-6 min-h-0 overflow-hidden">
        {activeTab === 'catalog' && (
          <div className="w-72 flex-shrink-0 flex flex-col gap-3 overflow-y-auto pr-2 custom-scrollbar">
            <h3 className="font-semibold text-lg mb-2">{t('reports.catalog')}</h3>
            {reports.map(report => (
              <button
                key={report.id}
                onClick={() => setSelectedReport(report.id)}
                aria-pressed={selectedReport === report.id}
                className={`flex items-center gap-4 p-4 rounded-2xl border transition-colors text-left group ${selectedReport === report.id ? 'bg-surface-3 border-accent-500' : 'bg-surface-3 border-line hover:bg-surface-hover'}`}
              >
                <div className="w-12 h-12 rounded-xl bg-surface-4 flex items-center justify-center flex-shrink-0 group-hover:bg-accent-600/20 transition-colors">
                  <report.icon className="w-6 h-6 text-muted group-hover:text-accent-500" />
                </div>
                <div>
                  <h4 className="font-medium text-primary">{report.title}</h4>
                  <p className="text-sm text-muted mt-1">{report.desc}</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {activeTab === 'catalog' ? renderReportContent() : renderBuilder()}
      </div>
    </div>
  );
}
