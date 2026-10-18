import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { X, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { clickable } from '../lib/a11y';
import { useDatabaseStore } from '../store/useDatabaseStore';
import type { Employee } from '../store/useDatabaseStore';
import { positionStats } from '../lib/staffing';
import { RATE_OPTIONS } from '../lib/validation';
import { localDateISO } from '../lib/dates';

const STATUSES = ['active', 'on_leave', 'probation', 'dismissed'] as const;
const PAY_TYPES = ['salary', 'hourly', 'piecework'] as const;

export interface EmployeeFormValues {
  fullName: string;
  position: string;
  department: string;
  status: Employee['status'];
  hireDate: string;
  dismissalDate?: string;
  tabNumber?: string;
  birthDate?: string;
  paymentType: NonNullable<Employee['paymentType']>;
  salary: number;
  rate: number;
}

interface EmployeeFormProps {
  initialData?: Partial<Employee>;
  onClose: () => void;
  /** Сохранение. Ошибка из слоя данных показывается в форме, окно не закрывается. */
  onSubmit: (data: Omit<Employee, 'id'>) => Promise<void> | void;
}

const field = 'w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-500 aria-[invalid=true]:border-rose-500';

/**
 * Карточка сотрудника.
 *
 * Подразделение и должность выбираются из штатного расписания: раньше это
 * были поля свободного ввода, и одна опечатка («Бугалтерия») выводила
 * человека из всех счётчиков занятости. Если штатное расписание ещё пустое
 * или у карточки старое значение, которого в нём нет, поле остаётся
 * свободным — данные не теряются.
 */
export default function EmployeeForm({ initialData, onClose, onSubmit }: EmployeeFormProps) {
  const { t } = useTranslation();
  const { departments, positions, employees } = useDatabaseStore();
  const [formError, setFormError] = useState('');

  const schema = useMemo(() => z.object({
    fullName: z.string().trim().min(2, t('employees.form.validation.nameMin')),
    position: z.string().trim().min(1, t('employees.form.validation.positionReq')),
    department: z.string().trim().min(1, t('employees.form.validation.departmentReq')),
    status: z.enum(STATUSES),
    hireDate: z.string().min(1, t('employees.form.validation.hireDateReq')),
    dismissalDate: z.string().optional(),
    tabNumber: z.string().optional(),
    birthDate: z.string().optional(),
    paymentType: z.enum(PAY_TYPES).default('salary'),
    salary: z.coerce.number({ message: t('errors.emp.salaryInvalid') }).min(0, t('errors.emp.salaryInvalid')),
    rate: z.coerce.number().min(0.25, t('errors.emp.rateInvalid')).max(2, t('errors.emp.rateInvalid')),
  }).superRefine((v, ctx) => {
    if (v.status === 'dismissed' && !v.dismissalDate) {
      ctx.addIssue({ code: 'custom', path: ['dismissalDate'], message: t('errors.emp.dismissalRequired') });
    }
    if (v.status === 'dismissed' && v.dismissalDate && v.hireDate && v.dismissalDate < v.hireDate) {
      ctx.addIssue({ code: 'custom', path: ['dismissalDate'], message: t('errors.emp.dismissalBeforeHire') });
    }
  }), [t]);

  const { register, handleSubmit, watch, setValue, getValues, formState: { errors, isSubmitting } } = useForm<EmployeeFormValues>({
    resolver: zodResolver(schema) as any,
    defaultValues: {
      fullName: initialData?.fullName ?? '',
      position: initialData?.position ?? '',
      department: initialData?.department ?? '',
      status: initialData?.status ?? 'active',
      hireDate: initialData?.hireDate ?? '',
      dismissalDate: initialData?.dismissalDate ?? '',
      tabNumber: initialData?.tabNumber ?? '',
      birthDate: initialData?.birthDate ?? '',
      paymentType: initialData?.paymentType ?? 'salary',
      salary: initialData?.salary ?? 0,
      rate: initialData?.rate ?? 1,
    },
  });

  // Подразделение и должность в режиме выбора управляются вручную (setValue):
  // регистрируем их явно, чтобы проверка формы их видела.
  useEffect(() => {
    register('department');
    register('position');
  }, [register]);

  const status = watch('status');
  const departmentName = watch('department');
  const positionTitle = watch('position');

  // Подразделения в порядке дерева, с отступом по вложенности.
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

  const selectedDepartment = departments.find((d) => d.name === departmentName);
  const departmentPositions = useMemo(
    () => (selectedDepartment ? positions.filter((p) => p.departmentId === selectedDepartment.id) : []),
    [positions, selectedDepartment],
  );

  // Свободные ставки по должностям подразделения — подсказка при выборе.
  // Сам сотрудник в счёт не идёт, иначе при правке своя ставка казалась бы занятой.
  const freeByTitle = useMemo(() => {
    if (!selectedDepartment) return new Map<string, { free: number; total: number }>();
    const others = employees.filter((e) => e.id !== initialData?.id);
    return new Map(positionStats(departmentPositions, others, departments).map((s) => [s.title, { free: s.total - s.occupied, total: s.total }]));
  }, [selectedDepartment, departmentPositions, employees, departments, initialData?.id]);

  const legacyDepartment = departmentName && !departments.some((d) => d.name === departmentName);
  const legacyPosition = positionTitle && !departmentPositions.some((p) => p.title === positionTitle);
  const freeText = departments.length === 0;

  const onDepartmentChange = (name: string) => {
    setValue('department', name, { shouldValidate: true });
    // Должность другого подразделения сюда не подходит.
    const dep = departments.find((d) => d.name === name);
    if (dep && !positions.some((p) => p.departmentId === dep.id && p.title === getValues('position'))) {
      setValue('position', '');
    }
  };

  const onPositionChange = (title: string) => {
    setValue('position', title, { shouldValidate: true });
    // Оклад по штатному расписанию подставляется, пока свой не введён.
    const pos = departmentPositions.find((p) => p.title === title);
    if (pos && pos.salary > 0 && !Number(getValues('salary'))) setValue('salary', pos.salary);
  };

  const submit = async (values: EmployeeFormValues) => {
    setFormError('');
    try {
      await onSubmit({
        fullName: values.fullName.trim().replace(/\s+/g, ' '),
        position: values.position.trim(),
        department: values.department.trim(),
        status: values.status,
        hireDate: values.hireDate,
        // Дата увольнения имеет смысл только у уволенного.
        dismissalDate: values.status === 'dismissed' ? values.dismissalDate || null : null,
        tabNumber: values.tabNumber?.trim() || undefined,
        birthDate: values.birthDate || undefined,
        paymentType: values.paymentType,
        salary: Number(values.salary) || 0,
        rate: Number(values.rate) || 1,
      });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  };

  const error = (name: keyof EmployeeFormValues) => errors[name]?.message as string | undefined;
  const errorLine = (name: keyof EmployeeFormValues) => error(name)
    ? <p id={`emp-${name}-error`} role="alert" className="text-rose-600 dark:text-rose-400 text-xs mt-1">{error(name)}</p>
    : null;
  const rateLabel = (r: number) => `${Math.round(r * 100)}%`;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" {...clickable(onClose, t('common.close'))} />

      <div role="dialog" aria-modal="true" aria-labelledby="employee-form-title" className="relative w-full max-w-md bg-[var(--sidebar-bg)] border-l border-[var(--border-color)] h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-300">
        <div className="flex items-center justify-between p-6 border-b border-[var(--border-color)]">
          <h2 id="employee-form-title" className="text-xl font-semibold tracking-tight">{initialData ? t('employees.form.editTitle') : t('employees.form.newTitle')}</h2>
          <button onClick={onClose} aria-label={t('common.close')} className="p-2 rounded-xl hover:bg-surface-hover text-muted transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form id="employee-form" onSubmit={handleSubmit(submit)} className="flex-1 overflow-y-auto p-6 space-y-5" noValidate>
          <div>
            <label htmlFor="emp-fullName" className="block text-sm font-medium mb-2">{t('employees.col.fullName')} *</label>
            <input id="emp-fullName" {...register('fullName')} aria-invalid={Boolean(error('fullName'))} className={field} placeholder={t('employees.form.ph.fullName')} />
            {errorLine('fullName')}
          </div>

          <div>
            <label htmlFor="emp-department" className="block text-sm font-medium mb-2">{t('employees.form.department')} *</label>
            {freeText ? (
              <input id="emp-department" {...register('department')} aria-invalid={Boolean(error('department'))} className={field} placeholder={t('employees.form.ph.department')} />
            ) : (
              <select
                id="emp-department"
                name="department"
                value={departmentName}
                onChange={(e) => onDepartmentChange(e.target.value)}
                aria-invalid={Boolean(error('department'))}
                className={field}
              >
                <option value="">{t('employees.form.choose')}</option>
                {legacyDepartment && <option value={departmentName}>{departmentName} — {t('employees.form.notInStaffing')}</option>}
                {departmentOptions.map((d) => (
                  <option key={d.name} value={d.name}>{`${'  '.repeat(d.depth)}${d.name}`}</option>
                ))}
              </select>
            )}
            {errorLine('department')}
            {freeText && <p className="text-xs text-muted mt-1">{t('employees.form.noStaffingHint')}</p>}
          </div>

          <div>
            <label htmlFor="emp-position" className="block text-sm font-medium mb-2">{t('employees.col.position')} *</label>
            {freeText || (selectedDepartment && departmentPositions.length === 0) ? (
              <input id="emp-position" {...register('position')} aria-invalid={Boolean(error('position'))} className={field} placeholder={t('employees.form.ph.position')} />
            ) : (
              <select
                id="emp-position"
                name="position"
                value={positionTitle}
                onChange={(e) => onPositionChange(e.target.value)}
                disabled={!departmentName}
                aria-invalid={Boolean(error('position'))}
                className={`${field} disabled:opacity-60`}
              >
                <option value="">{departmentName ? t('employees.form.choose') : t('employees.form.chooseDepartmentFirst')}</option>
                {legacyPosition && <option value={positionTitle}>{positionTitle} — {t('employees.form.notInStaffing')}</option>}
                {departmentPositions.map((p) => {
                  const info = freeByTitle.get(p.title);
                  return (
                    <option key={p.id} value={p.title}>
                      {p.title}{info ? ` — ${t('employees.form.freeUnits', { free: Math.max(0, info.free), total: info.total })}` : ''}
                    </option>
                  );
                })}
              </select>
            )}
            {errorLine('position')}
            {selectedDepartment && departmentPositions.length === 0 && !freeText && (
              <p className="text-xs text-muted mt-1">{t('employees.form.noPositionsHint')}</p>
            )}
            {(() => {
              const info = freeByTitle.get(positionTitle);
              return info && info.free <= 0 && !legacyPosition
                ? <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">{t('employees.form.noFreeUnits')}</p>
                : null;
            })()}
          </div>

          <div>
            <label htmlFor="emp-tabNumber" className="block text-sm font-medium mb-2">{t('employees.col.tabNumber')}</label>
            <input id="emp-tabNumber" {...register('tabNumber')} className={field} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="emp-status" className="block text-sm font-medium mb-2">{t('employees.col.status')}</label>
              <select id="emp-status" {...register('status')} className={field}>
                <option value="active">{t('employees.status.active')}</option>
                <option value="probation">{t('employees.status.probation')}</option>
                <option value="on_leave">{t('employees.status.onLeave')}</option>
                <option value="dismissed">{t('employees.status.dismissed')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="emp-hireDate" className="block text-sm font-medium mb-2">{t('employees.form.hireDate')} *</label>
              <input id="emp-hireDate" type="date" {...register('hireDate')} aria-invalid={Boolean(error('hireDate'))} className={field} />
              {errorLine('hireDate')}
            </div>
          </div>

          {status === 'dismissed' && (
            <div>
              <label htmlFor="emp-dismissalDate" className="block text-sm font-medium mb-2">{t('employees.form.dismissalDate')} *</label>
              <input id="emp-dismissalDate" type="date" max={localDateISO(new Date(Date.now() + 366 * 86400000))} {...register('dismissalDate')} aria-invalid={Boolean(error('dismissalDate'))} className={field} />
              {errorLine('dismissalDate')}
              {!error('dismissalDate') && <p className="text-xs text-muted mt-1">{t('employees.form.dismissalHint')}</p>}
            </div>
          )}

          <div>
            <label htmlFor="emp-birthDate" className="block text-sm font-medium mb-2">{t('employees.form.birthDate')}</label>
            <input id="emp-birthDate" type="date" {...register('birthDate')} className={field} />
          </div>

          <div className="space-y-4 pt-2">
            <h3 className="text-sm font-semibold text-primary border-b border-[var(--border-color)] pb-2">{t('employees.form.payTitle')}</h3>
            <div>
              <label htmlFor="emp-paymentType" className="block text-sm font-medium mb-2">{t('employees.form.payType')}</label>
              <select id="emp-paymentType" {...register('paymentType')} className={field}>
                <option value="salary">{t('employees.form.pay.salary')}</option>
                <option value="hourly">{t('employees.form.pay.hourly')}</option>
                <option value="piecework">{t('employees.form.pay.piecework')}</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="emp-salary" className="block text-sm font-medium mb-2">{t('employees.form.salary')}</label>
                <input id="emp-salary" type="number" min="0" step="0.01" {...register('salary')} aria-invalid={Boolean(error('salary'))} className={field} />
                {errorLine('salary')}
              </div>
              <div>
                <label htmlFor="emp-rate" className="block text-sm font-medium mb-2">{t('employees.col.rate')}</label>
                <select id="emp-rate" {...register('rate')} className={field}>
                  {/* Значение не из списка (из старых данных или импорта) не теряем. */}
                  {initialData?.rate !== undefined && !RATE_OPTIONS.includes(initialData.rate as never) && (
                    <option value={initialData.rate}>{rateLabel(initialData.rate)}</option>
                  )}
                  {RATE_OPTIONS.map((r) => <option key={r} value={r}>{rateLabel(r)}</option>)}
                </select>
              </div>
            </div>
          </div>

          {formError && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{formError}</p>}
        </form>

        <div className="p-6 border-t border-[var(--border-color)] flex gap-3 bg-surface-2">
          <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-[var(--border-color)] rounded-xl font-medium hover:bg-surface-hover transition-colors">
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            form="employee-form"
            disabled={isSubmitting}
            className="flex-1 flex items-center justify-center gap-2 bg-accent-600 hover:bg-accent-700 disabled:opacity-60 text-white px-4 py-2 rounded-xl font-medium transition-colors"
          >
            <Save className="w-4 h-4" />
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
