import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { X, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDatabaseStore } from '../store/useDatabaseStore';
import type { MovementType } from '../store/useDatabaseStore';
import { clickable } from '../lib/a11y';
import { localDateISO, useDates } from '../lib/dates';
import { useMoney } from '../lib/money';
import { movementError } from '../data/movements';
import { useNotify } from './Toasts';

interface MovementFormProps {
  type: MovementType;
  onClose: () => void;
}

const field = 'w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-500 aria-[invalid=true]:border-rose-500';

/**
 * Дровер проведения кадровой операции.
 *
 * Прежние значения (должность, подразделение, оклад) форма не спрашивает —
 * их фиксирует слой данных по состоянию карточки на момент проведения.
 * Новые должность и подразделение выбираются из штатного расписания, а не
 * вводятся вручную: опечатка в свободном поле выводила человека из штата.
 */
export default function MovementForm({ type, onClose }: MovementFormProps) {
  const { t } = useTranslation();
  const notify = useNotify();
  const dates = useDates();
  const money = useMoney();
  const { employees, departments, positions, applyMovement } = useDatabaseStore();

  const isDismissal = type === 'dismissal';
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState(localDateISO());
  const [orderNo, setOrderNo] = useState('');
  const [toDepartment, setToDepartment] = useState('');
  const [toPosition, setToPosition] = useState('');
  const [toSalary, setToSalary] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Перевести или уволить можно только работающего; принять — любого
  // (повторный приём уволенного тоже приём).
  const candidates = useMemo(
    () => employees
      .filter((e) => (type === 'hire' ? true : e.status !== 'dismissed'))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')),
    [employees, type],
  );
  const employee = employees.find((e) => e.id === employeeId);

  const departmentOptions = useMemo(() => {
    const out: { name: string; depth: number }[] = [];
    const known = new Set(departments.map((d) => d.id));
    const walk = (parentId: string | null, depth: number) => {
      departments
        .filter((d) => (parentId === null ? !d.parentId || !known.has(d.parentId) : d.parentId === parentId))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
        .forEach((d) => { out.push({ name: d.name, depth }); walk(d.id, depth + 1); });
    };
    walk(null, 0);
    return out;
  }, [departments]);

  // Должности — того подразделения, куда переводят (или текущего).
  const targetDepartment = toDepartment || employee?.department || '';
  const targetDepartmentId = departments.find((d) => d.name === targetDepartment)?.id;
  const positionOptions = useMemo(
    () => positions.filter((p) => p.departmentId === targetDepartmentId).map((p) => p.title),
    [positions, targetDepartmentId],
  );

  const title = type === 'hire' ? t('movements.hire') : type === 'transfer' ? t('movements.transfer') : t('movements.dismissal');

  const onPositionChange = (value: string) => {
    setToPosition(value);
    const pos = positions.find((p) => p.departmentId === targetDepartmentId && p.title === value);
    if (pos && pos.salary > 0 && !toSalary) setToSalary(String(pos.salary));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!employee) next.employeeId = t('movements.chooseEmployee');
    if (!date) next.date = t('errors.mov.dateInvalid');
    const salary = toSalary ? Number(toSalary) : 0;
    if (toSalary && (!Number.isFinite(salary) || salary < 0)) next.toSalary = t('errors.emp.salaryInvalid');
    const movement = {
      employeeId,
      type,
      date,
      // При увольнении целевые поля не заполняются: меняется только статус.
      toPosition: isDismissal ? undefined : toPosition || undefined,
      toDepartment: isDismissal ? undefined : toDepartment || undefined,
      toSalary: isDismissal ? 0 : salary,
      orderNo: orderNo.trim() || undefined,
      reason: reason.trim() || undefined,
    };
    if (employee && Object.keys(next).length === 0) {
      const code = movementError(movement, employee);
      if (code) next.form = t(`errors.${code}`);
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      await applyMovement(movement);
      notify.success(t('movements.applied', { type: title, name: employee!.fullName }));
      onClose();
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const errorLine = (key: string) => errors[key]
    ? <p role="alert" className="text-rose-600 dark:text-rose-400 text-xs mt-1">{errors[key]}</p>
    : null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" {...clickable(onClose, t('common.close'))} />

      <div role="dialog" aria-modal="true" aria-labelledby="movement-form-title" className="relative w-full max-w-md bg-[var(--sidebar-bg)] border-l border-[var(--border-color)] h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-300">
        <div className="flex items-center justify-between p-6 border-b border-[var(--border-color)]">
          <h2 id="movement-form-title" className="text-xl font-semibold tracking-tight">{title}</h2>
          <button onClick={onClose} aria-label={t('common.close')} className="p-2 rounded-xl hover:bg-surface-hover text-muted transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={submit} className="flex-1 overflow-y-auto p-6 space-y-5" noValidate>
          <div>
            <label htmlFor="mov-employee" className="block text-sm font-medium mb-2">{t('movements.employee')} *</label>
            <select id="mov-employee" name="employeeId" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-invalid={Boolean(errors.employeeId)} className={field}>
              <option value="">{t('employees.form.choose')}</option>
              {candidates.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.fullName}{emp.status === 'dismissed' ? ` — ${t('employees.status.dismissed').toLowerCase()}` : ''}
                </option>
              ))}
            </select>
            {errorLine('employeeId')}
            {employee && (
              <p className="text-xs text-muted mt-2" data-testid="movement-current">
                {t('movements.current', {
                  position: employee.position,
                  department: employee.department,
                  salary: money.format(employee.salary ?? 0),
                  hireDate: dates.date(employee.hireDate),
                })}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="mov-date" className="block text-sm font-medium mb-2">{t('movements.date')} *</label>
            <input id="mov-date" name="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={Boolean(errors.date)} className={field} />
            {errorLine('date')}
          </div>

          <div>
            <label htmlFor="mov-order" className="block text-sm font-medium mb-2">{t('movements.orderNo')}</label>
            <input id="mov-order" name="orderNo" value={orderNo} onChange={(e) => setOrderNo(e.target.value)} className={field} />
          </div>

          {!isDismissal && (
            <>
              <div>
                <label htmlFor="mov-department" className="block text-sm font-medium mb-2">{t('movements.newDepartment')}</label>
                {departments.length > 0 ? (
                  <select id="mov-department" name="toDepartment" value={toDepartment} onChange={(e) => { setToDepartment(e.target.value); setToPosition(''); }} className={field}>
                    <option value="">{employee ? t('movements.keepCurrent', { value: employee.department }) : t('movements.keepCurrentShort')}</option>
                    {departmentOptions.map((d) => (
                      <option key={d.name} value={d.name}>{`${'  '.repeat(d.depth)}${d.name}`}</option>
                    ))}
                  </select>
                ) : (
                  <input id="mov-department" name="toDepartment" value={toDepartment} onChange={(e) => setToDepartment(e.target.value)} className={field} />
                )}
              </div>

              <div>
                <label htmlFor="mov-position" className="block text-sm font-medium mb-2">{t('movements.newPosition')}</label>
                {positionOptions.length > 0 ? (
                  <select id="mov-position" name="toPosition" value={toPosition} onChange={(e) => onPositionChange(e.target.value)} className={field}>
                    <option value="">{employee && !toDepartment ? t('movements.keepCurrent', { value: employee.position }) : t('employees.form.choose')}</option>
                    {positionOptions.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                ) : (
                  <input id="mov-position" name="toPosition" value={toPosition} onChange={(e) => setToPosition(e.target.value)} className={field} />
                )}
              </div>

              <div>
                <label htmlFor="mov-salary" className="block text-sm font-medium mb-2">{t('movements.newSalary')}</label>
                <input id="mov-salary" name="toSalary" type="number" min="0" step="0.01" value={toSalary} onChange={(e) => setToSalary(e.target.value)} aria-invalid={Boolean(errors.toSalary)} className={field} />
                {errorLine('toSalary')}
                {!errors.toSalary && <p className="text-xs text-muted mt-1">{t('movements.salaryHint')}</p>}
              </div>
            </>
          )}

          <div>
            <label htmlFor="mov-reason" className="block text-sm font-medium mb-2">{t('movements.reason')}</label>
            <textarea id="mov-reason" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} className={`${field} h-24 resize-none`} />
          </div>

          {errors.form && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{errors.form}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-accent-600 hover:bg-accent-700 disabled:opacity-60 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            <Save className="w-4 h-4" />
            {t('movements.apply')}
          </button>
        </form>
      </div>
    </div>
  );
}
