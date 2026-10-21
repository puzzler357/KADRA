import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar as CalendarIcon, Clock, CheckCircle2, XCircle, Clock3, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useDatabaseStore, TABLES } from '../store/useDatabaseStore';
import type { TimeOffRequest } from '../store/useDatabaseStore';
import { localDateISO, useDates } from '../lib/dates';
import { daysBetween, vacationBalance, vacationExcess, yearsOf } from '../lib/vacation';
import { useNotify } from '../components/Toasts';
import Modal, { Field, inputClass, primaryButton, secondaryButton } from '../components/Modal';

/** Пересекаются ли два интервала дат (ГГГГ-ММ-ДД), включая границы. */
const overlaps = (a: { dateFrom: string; dateTo: string }, b: { dateFrom: string; dateTo: string }) =>
  a.dateFrom <= b.dateTo && b.dateFrom <= a.dateTo;

export default function TimeOff() {
  const { t } = useTranslation();
  const notify = useNotify();
  const dates = useDates();
  const { user, annualVacationDays } = useAppStore();
  const { timeOffRequests, employees, createIn, updateIn, removeFrom } = useDatabaseStore();

  const staff = useMemo(
    () => employees.filter(e => e.status !== 'dismissed').sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')),
    [employees],
  );
  const employeeName = (id: string) => employees.find(e => e.id === id)?.fullName ?? '—';

  // «Мои заявки» — заявки сотрудника, чьё имя совпадает с владельцем устройства.
  const ownEmployeeId = useMemo(
    () => employees.find(e => e.fullName === user?.name)?.id,
    [employees, user?.name],
  );
  // Без связанной карточки «своих» заявок нет — открываем заявки команды.
  const [activeTab, setActiveTab] = useState<'my' | 'team'>(() => (ownEmployeeId ? 'my' : 'team'));

  const visibleRequests = (activeTab === 'my'
    ? timeOffRequests.filter(r => r.employeeId === ownEmployeeId)
    : timeOffRequests
  ).slice().sort((a, b) => b.dateFrom.localeCompare(a.dateFrom));

  // Остаток отпуска считается по каждому сотруднику и по каждому году:
  // норма из «Настроек» минус согласованные дни, приходящиеся на этот год.
  // Отпуск через Новый год делится между годами (src/lib/vacation.ts).
  const currentYear = new Date().getFullYear();
  const balanceOf = (employeeId: string, year = currentYear) =>
    vacationBalance(timeOffRequests, employeeId, year, annualVacationDays);

  const [balanceEmployeeId, setBalanceEmployeeId] = useState<string>(() => ownEmployeeId ?? '');
  const balanceTarget = balanceEmployeeId || ownEmployeeId || staff[0]?.id || '';
  const balance = balanceTarget ? balanceOf(balanceTarget) : null;
  const pendingCount = timeOffRequests.filter(r => r.status === 'pending').length;

  // ---- Новая заявка ----
  const emptyRequest = () => ({ employeeId: ownEmployeeId ?? '', type: 'vacation', dateFrom: localDateISO(), dateTo: localDateISO() });
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newRequest, setNewRequest] = useState(emptyRequest);
  const [formError, setFormError] = useState('');

  const requestedDays = daysBetween(newRequest.dateFrom, newRequest.dateTo);
  // Новая заявка сверяется с остатком тех лет, на которые она приходится,
  // а не текущего: в декабре заявка на январь — это отпуск следующего года.
  const requestYears = newRequest.employeeId && requestedDays > 0 ? yearsOf(newRequest) : [];
  const requestExcess = newRequest.type === 'vacation' && newRequest.employeeId && requestedDays > 0
    ? vacationExcess(timeOffRequests, newRequest, annualVacationDays)
    : [];
  const conflict = newRequest.employeeId
    ? timeOffRequests.find(r => r.employeeId === newRequest.employeeId && r.status !== 'rejected' && overlaps(r, newRequest))
    : undefined;

  const handleAddRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!newRequest.employeeId) { setFormError(t('movements.chooseEmployee')); return; }
    if (requestedDays <= 0) { setFormError(t('timeoff.badDates')); return; }
    // Одни и те же дни дважды не отпускаем: это почти всегда ошибка ввода.
    if (conflict) {
      setFormError(t('timeoff.overlap', { from: dates.date(conflict.dateFrom), to: dates.date(conflict.dateTo) }));
      return;
    }
    try {
      await createIn<TimeOffRequest>(TABLES.timeOff, {
        employeeId: newRequest.employeeId,
        type: newRequest.type,
        dateFrom: newRequest.dateFrom,
        dateTo: newRequest.dateTo,
        // Количество дней считается по интервалу, а не вводится руками.
        days: requestedDays,
        status: 'pending',
      });
      notify.success(t('timeoff.created'));
      setNewRequest(emptyRequest());
      setIsModalOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAction = async (req: TimeOffRequest, status: string) => {
    // Согласование отпуска сверх остатка — осознанное решение, спрашиваем.
    if (status === 'approved' && req.type === 'vacation') {
      for (const excess of vacationExcess(timeOffRequests, req, annualVacationDays, req)) {
        if (!(await notify.confirm(t('timeoff.approveOverLimit', { name: employeeName(req.employeeId), ...excess })))) return;
      }
    }
    await updateIn(TABLES.timeOff, req.id, { status });
  };

  const handleDelete = async (req: TimeOffRequest) => {
    if (!(await notify.confirm(t('timeoff.deleteConfirm', { name: employeeName(req.employeeId) }), { danger: true }))) return;
    await removeFrom(TABLES.timeOff, req.id);
  };

  return (
    <div className="space-y-6">
      {isModalOpen && (
        <Modal
          title={t('timeoff.requestTitle')}
          onClose={() => setIsModalOpen(false)}
          footer={(
            <>
              <button type="button" onClick={() => setIsModalOpen(false)} className={secondaryButton}>{t('common.cancel')}</button>
              <button type="submit" form="timeoff-form" className={primaryButton}>{t('timeoff.submit')}</button>
            </>
          )}
        >
          <form id="timeoff-form" onSubmit={handleAddRequest} className="space-y-4" noValidate>
            <Field id="to-employee" label={`${t('timeoff.employee')} *`}>
              <select
                id="to-employee"
                value={newRequest.employeeId}
                onChange={(e) => setNewRequest({ ...newRequest, employeeId: e.target.value })}
                className={inputClass}
              >
                <option value="">{t('employees.form.choose')}</option>
                {staff.map(emp => (
                  <option key={emp.id} value={emp.id}>{emp.fullName}</option>
                ))}
              </select>
            </Field>
            <Field id="to-type" label={`${t('timeoff.type')} *`}>
              <select id="to-type" value={newRequest.type} onChange={(e) => setNewRequest({ ...newRequest, type: e.target.value })} className={inputClass}>
                <option value="vacation">{t('timeoff.types.vacation')}</option>
                <option value="sick">{t('timeoff.types.sick')}</option>
                <option value="dayoff">{t('timeoff.types.dayoff')}</option>
                <option value="remote">{t('timeoff.types.remote')}</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field id="to-from" label={`${t('timeoff.dateFrom')} *`}>
                <input id="to-from" type="date" value={newRequest.dateFrom}
                  onChange={(e) => setNewRequest({ ...newRequest, dateFrom: e.target.value, dateTo: newRequest.dateTo < e.target.value ? e.target.value : newRequest.dateTo })}
                  className={inputClass} />
              </Field>
              <Field id="to-to" label={`${t('timeoff.dateTo')} *`}>
                <input id="to-to" type="date" min={newRequest.dateFrom} value={newRequest.dateTo}
                  onChange={(e) => setNewRequest({ ...newRequest, dateTo: e.target.value })} className={inputClass} />
              </Field>
            </div>
            <p className="text-sm text-secondary">
              {t('timeoff.daysCount')}: <span className="text-primary font-medium" data-testid="timeoff-days">{requestedDays}</span>
              {newRequest.type === 'vacation' && requestYears.map(year => (
                <React.Fragment key={year}> · {t('timeoff.leftAfter', { year, left: balanceOf(newRequest.employeeId, year).left })}</React.Fragment>
              ))}
            </p>
            {requestExcess.map(excess => (
              <p key={excess.year} className="text-sm text-amber-700 dark:text-amber-400">{t('timeoff.overLimit', { year: excess.year, left: excess.left })}</p>
            ))}
            {conflict && !formError && (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {t('timeoff.overlap', { from: dates.date(conflict.dateFrom), to: dates.date(conflict.dateTo) })}
              </p>
            )}
            {formError && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{formError}</p>}
          </form>
        </Modal>
      )}

      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-primary">{t('timeoff.manageTitle')}</h2>
          <p className="text-muted mt-1">{t('timeoff.subtitle')}</p>
        </div>
        <button onClick={() => { setNewRequest(emptyRequest()); setFormError(''); setIsModalOpen(true); }} className="bg-accent-600 hover:bg-accent-700 text-white px-4 py-2 rounded-xl flex items-center gap-2 text-sm font-medium transition-colors">
          <CalendarIcon className="w-4 h-4" />
          {t('timeoff.submitRequest')}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-surface border border-line rounded-2xl p-6 md:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-blue-500/10 text-blue-700 dark:text-blue-300 rounded-xl flex items-center justify-center">
                <CalendarIcon className="w-5 h-5" />
              </div>
              <h3 className="font-medium text-primary">{t('timeoff.balanceTitle', { year: currentYear })}</h3>
            </div>
            <select
              aria-label={t('timeoff.employee')}
              value={balanceTarget}
              onChange={(e) => setBalanceEmployeeId(e.target.value)}
              className="bg-app border border-line rounded-xl px-3 py-2 text-sm text-primary max-w-[16rem]"
            >
              {staff.map(emp => <option key={emp.id} value={emp.id}>{emp.fullName}</option>)}
            </select>
          </div>
          {balance ? (
            <div className="grid grid-cols-3 gap-4 mt-4">
              <div>
                <p className="text-3xl font-bold text-primary tabular-nums" data-testid="vacation-left">{balance.left}</p>
                <p className="text-sm text-muted">{t('timeoff.left')}</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-secondary tabular-nums">{balance.used}</p>
                <p className="text-sm text-muted">{t('timeoff.used')}</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-secondary tabular-nums">{balance.pending}</p>
                <p className="text-sm text-muted">{t('timeoff.onApproval')}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted mt-4">{t('dashboard.noEmployees')}</p>
          )}
          <p className="text-xs text-muted mt-3">{t('timeoff.normHint', { days: annualVacationDays })}</p>
        </div>
        <div className="bg-surface border border-line rounded-2xl p-6">
          <div className="flex items-center gap-4 mb-2">
            <div className="w-10 h-10 bg-amber-500/10 text-amber-700 dark:text-amber-300 rounded-xl flex items-center justify-center">
              <Clock className="w-5 h-5" />
            </div>
            <h3 className="font-medium text-primary">{t('timeoff.pendingApproval')}</h3>
          </div>
          <p className="text-3xl font-bold text-primary mt-4 tabular-nums" data-testid="timeoff-pending">{t('timeoff.requestsCount', { count: pendingCount })}</p>
        </div>
      </div>

      <div className="bg-surface border border-line rounded-2xl overflow-hidden mt-8">
        <div className="flex border-b border-line" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === 'my'}
            onClick={() => setActiveTab('my')}
            className={`px-6 py-4 text-sm font-medium border-b-2 transition-colors ${activeTab === 'my' ? 'border-accent-500 text-accent-700 dark:text-accent-400' : 'border-transparent text-secondary hover:text-primary'}`}
          >
            {t('timeoff.myRequests')}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'team'}
            onClick={() => setActiveTab('team')}
            className={`px-6 py-4 text-sm font-medium border-b-2 transition-colors ${activeTab === 'team' ? 'border-accent-500 text-accent-700 dark:text-accent-400' : 'border-transparent text-secondary hover:text-primary'}`}
          >
            {t('timeoff.teamRequests')}
          </button>
        </div>

        <div className="p-0 overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs text-muted bg-surface border-b border-line">
              <tr>
                {activeTab === 'team' && <th className="p-table text-table font-medium">{t('timeoff.colEmployee')}</th>}
                <th className="p-table text-table font-medium">{t('timeoff.colType')}</th>
                <th className="p-table text-table font-medium">{t('timeoff.colDates')}</th>
                <th className="p-table text-table font-medium text-right">{t('timeoff.colDays')}</th>
                {activeTab === 'team' && <th className="p-table text-table font-medium text-right">{t('timeoff.colLeft')}</th>}
                <th className="p-table text-table font-medium">{t('employees.col.status')}</th>
                {activeTab === 'team' && <th className="p-table text-table font-medium text-right">{t('timeoff.colActions')}</th>}
              </tr>
            </thead>
            <tbody>
              {visibleRequests.map(req => (
                <tr key={req.id} className="border-b border-line hover:bg-surface-hover">
                  {activeTab === 'team' && <td className="p-table text-table font-medium text-primary">{employeeName(req.employeeId)}</td>}
                  <td className="p-table text-table text-primary">{t(`timeoff.types.${req.type}`)}</td>
                  <td className="p-table text-table text-secondary tabular-nums">{dates.date(req.dateFrom)} — {dates.date(req.dateTo)}</td>
                  <td className="p-table text-table text-secondary text-right tabular-nums">{req.days}</td>
                  {activeTab === 'team' && (
                    <td className="p-table text-table text-secondary text-right tabular-nums">
                      {req.type === 'vacation' ? balanceOf(req.employeeId, Number(req.dateFrom.slice(0, 4))).left : '—'}
                    </td>
                  )}
                  <td className="p-table text-table">
                    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                      req.status === 'approved' ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300' :
                      req.status === 'rejected' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' :
                      'bg-amber-500/15 text-amber-800 dark:text-amber-300'
                    }`}>
                      {req.status === 'approved' && <CheckCircle2 className="w-3.5 h-3.5" />}
                      {req.status === 'rejected' && <XCircle className="w-3.5 h-3.5" />}
                      {req.status === 'pending' && <Clock3 className="w-3.5 h-3.5" />}
                      {req.status === 'approved' ? t('timeoff.status.approved') : req.status === 'rejected' ? t('timeoff.status.rejected') : t('timeoff.status.pending')}
                    </div>
                  </td>
                  {activeTab === 'team' && (
                    <td className="p-table text-table text-right">
                      <div className="flex justify-end gap-1">
                        {req.status === 'pending' && (
                          <>
                            <button onClick={() => handleAction(req, 'approved')} className="p-1.5 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors" title={t('timeoff.approve')} aria-label={`${t('timeoff.approve')}: ${employeeName(req.employeeId)}`}>
                              <CheckCircle2 className="w-5 h-5" />
                            </button>
                            <button onClick={() => handleAction(req, 'rejected')} className="p-1.5 text-rose-700 dark:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors" title={t('timeoff.reject')} aria-label={`${t('timeoff.reject')}: ${employeeName(req.employeeId)}`}>
                              <XCircle className="w-5 h-5" />
                            </button>
                          </>
                        )}
                        <button onClick={() => handleDelete(req)} className="p-1.5 text-muted hover:text-rose-600 hover:bg-rose-500/10 rounded-lg transition-colors" title={t('common.delete')} aria-label={`${t('common.delete')}: ${employeeName(req.employeeId)}`}>
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {visibleRequests.length === 0 && (
                <tr>
                  <td colSpan={activeTab === 'team' ? 7 : 4} className="p-table text-table text-center text-muted py-8">
                    {activeTab === 'my' && !ownEmployeeId ? t('timeoff.noOwnCard') : t('timeoff.noRequests')}
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
