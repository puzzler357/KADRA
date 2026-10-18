import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MovementForm from '../components/MovementForm';
import { exportToExcel } from '../lib/excel';
import { useMoney } from '../lib/money';
import { useDates, fileStamp } from '../lib/dates';
import { useDatabaseStore } from '../store/useDatabaseStore';
import type { Movement, MovementType } from '../store/useDatabaseStore';

export default function Movements() {
  const { t } = useTranslation();
  const { movements, employees } = useDatabaseStore();
  const money = useMoney();
  const dates = useDates();

  const [formType, setFormType] = useState<MovementType | null>(null);
  const [typeFilter, setTypeFilter] = useState<'all' | MovementType>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // ФИО берём из карточки, а если её удалили — из самого приказа.
  const employeeName = (m: Movement) => employees.find(e => e.id === m.employeeId)?.fullName
    ?? (m.employeeName ? `${m.employeeName} (${t('movements.cardDeleted')})` : '—');

  // «Было → стало» только когда стало другим; иначе — просто значение.
  const change = (from?: string | null, to?: string | null) =>
    !to || to === from ? (from || '—') : `${from || '—'} → ${to}`;
  const salaryChange = (m: Movement) =>
    !m.toSalary || m.toSalary === m.fromSalary ? money.format(m.fromSalary) : `${money.format(m.fromSalary)} → ${money.format(m.toSalary)}`;

  const typeLabel = (type: string) =>
    type === 'hire' ? t('movements.hire') : type === 'transfer' ? t('movements.transfer') : t('movements.dismissal');

  // Фильтры работают: раньше и селект типа, и оба поля дат были декорацией.
  const filtered = useMemo(() => movements.filter(m => {
    if (typeFilter !== 'all' && m.type !== typeFilter) return false;
    if (dateFrom && m.date < dateFrom) return false;
    if (dateTo && m.date > dateTo) return false;
    return true;
  }), [movements, typeFilter, dateFrom, dateTo]);

  const handleExport = async () => {
    await exportToExcel(filtered.map(m => ({
      [t('movements.date')]: dates.date(m.date),
      [t('movements.type')]: typeLabel(m.type),
      [t('movements.employee')]: employeeName(m),
      [t('movements.orderNo')]: m.orderNo ?? '',
      [t('employees.col.position')]: m.type === 'dismissal' ? (m.fromPosition ?? '') : change(m.fromPosition, m.toPosition),
      [t('employees.col.department')]: m.type === 'dismissal' ? (m.fromDepartment ?? '') : change(m.fromDepartment, m.toDepartment),
      // В выгрузке оклад остаётся числом: форматировать его в текст значило бы
      // сломать арифметику в самой таблице.
      [`${t('employees.col.salary')} (${t('movements.was')})`]: m.fromSalary,
      [`${t('employees.col.salary')} (${t('movements.became')})`]: m.toSalary,
      [t('movements.reason')]: m.reason ?? '',
    })), `${t('nav.movements')}_${fileStamp()}`, {
      sheetName: t('nav.movements'),
      numberFormats: {
        [`${t('employees.col.salary')} (${t('movements.was')})`]: '#,##0.00',
        [`${t('employees.col.salary')} (${t('movements.became')})`]: '#,##0.00',
      },
    });
  };

  // Цвета значков — с достаточным контрастом и в светлой теме.
  const badgeClass = (type: string) =>
    type === 'hire' ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
      : type === 'transfer' ? 'bg-accent-500/15 text-accent-800 dark:text-accent-300'
        : 'bg-rose-500/10 text-rose-800 dark:text-rose-300';

  const control = 'bg-white dark:bg-slate-950 border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500';

  return (
    <div className="space-y-6">
      {formType && <MovementForm type={formType} onClose={() => setFormType(null)} />}

      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">{t('nav.movements')}</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setFormType('hire')}
            className="bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            {t('movements.hire')}
          </button>
          <button
            onClick={() => setFormType('transfer')}
            className="bg-accent-500/15 text-accent-800 dark:text-accent-300 border border-accent-500/30 hover:bg-accent-500/25 px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            {t('movements.transfer')}
          </button>
          <button
            onClick={() => setFormType('dismissal')}
            className="bg-rose-500/10 text-rose-800 dark:text-rose-300 border border-rose-500/30 hover:bg-rose-500/25 px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            {t('movements.dismissal')}
          </button>
        </div>
      </div>

      <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm overflow-hidden flex flex-col">
        <div className="p-4 border-b border-[var(--border-color)] flex items-center justify-between gap-4 bg-surface-2 dark:bg-slate-900/50">
          <div className="flex items-center gap-4">
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)} className={control} aria-label={t('movements.type')}>
              <option value="all">{t('movements.allTypes')}</option>
              <option value="hire">{t('movements.hire')}</option>
              <option value="transfer">{t('movements.transfer')}</option>
              <option value="dismissal">{t('movements.dismissal')}</option>
            </select>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className={control}
              aria-label={t('movements.dateFrom')}
            />
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className={control}
              aria-label={t('movements.dateTo')}
            />
          </div>
          <button
            onClick={handleExport}
            className="bg-surface-3 dark:bg-slate-800 border border-[var(--border-color)] hover:bg-surface-hover dark:hover:bg-slate-700 text-secondary dark:text-slate-300 px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            {t('common.export')}
          </button>
        </div>

        <div className="overflow-x-auto min-h-[400px]">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted uppercase bg-surface-2 dark:bg-slate-900/50 border-b border-[var(--border-color)]">
              <tr>
                <th className="p-table text-table font-medium">{t('movements.date')}</th>
                <th className="p-table text-table font-medium">{t('movements.type')}</th>
                <th className="p-table text-table font-medium">{t('employees.col.fullName')}</th>
                <th className="p-table text-table font-medium">{t('employees.col.position')}</th>
                <th className="p-table text-table font-medium">{t('employees.col.department')}</th>
                <th className="p-table text-table font-medium">{t('employees.col.salary')}</th>
                <th className="p-table text-table font-medium">{t('movements.orderNo')}</th>
                <th className="p-table text-table font-medium">{t('movements.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(m => (
                <tr key={m.id} className="border-b border-[var(--border-color)] hover:bg-surface-hover transition-colors">
                  <td className="p-table text-table text-muted whitespace-nowrap tabular-nums">{dates.date(m.date)}</td>
                  <td className="p-table text-table">
                    <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${badgeClass(m.type)}`}>
                      {typeLabel(m.type)}
                    </span>
                  </td>
                  <td className="p-table text-table font-medium text-primary">{employeeName(m)}</td>
                  <td className="p-table text-table text-secondary">
                    {m.type === 'dismissal' ? (m.fromPosition || '—') : change(m.fromPosition, m.toPosition)}
                  </td>
                  <td className="p-table text-table text-secondary">
                    {m.type === 'dismissal' ? (m.fromDepartment || '—') : change(m.fromDepartment, m.toDepartment)}
                  </td>
                  <td className="p-table text-table text-secondary whitespace-nowrap tabular-nums">
                    {m.type === 'dismissal' ? money.format(m.fromSalary) : salaryChange(m)}
                  </td>
                  <td className="p-table text-table text-muted">{m.orderNo || '—'}</td>
                  <td className="p-table text-table text-muted">{m.reason || '—'}</td>
                </tr>
              ))}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-table text-table text-center text-muted py-12">
                    {t('movements.noRecords')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
