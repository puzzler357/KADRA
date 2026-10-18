import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Target, TrendingUp, Users, BarChart3, Pencil, Trash2 } from 'lucide-react';
import { useDatabaseStore, TABLES } from '../store/useDatabaseStore';
import type { Goal, Review, ReviewCycle } from '../store/useDatabaseStore';
import { descendantIds } from '../lib/validation';
import { useNotify } from '../components/Toasts';
import Modal, { Field, inputClass, primaryButton, secondaryButton } from '../components/Modal';

/** Текущий период в том же формате, в каком он лежит в базе: 2026-Q3. */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}

/** Кварталы прошлого, текущего и следующего года — для выбора периода. */
function periodOptions(): string[] {
  const year = new Date().getFullYear();
  return [year + 1, year, year - 1].flatMap(y => [4, 3, 2, 1].map(q => `${y}-Q${q}`));
}

interface GoalDraft { id: string | null; title: string; progress: number; status: string; period: string }

export default function Performance() {
  const { t } = useTranslation();
  const { goals, reviews, reviewCycles, employees, departments, createIn, updateIn, removeFrom } = useDatabaseStore();
  const notify = useNotify();

  const periodLabel = (period: string) => {
    const match = /^(\d{4})-Q([1-4])$/.exec(period);
    return match ? t('performance.periodLabel', { year: match[1], q: match[2] }) : period;
  };

  const staff = useMemo(
    () => employees.filter(e => e.status !== 'dismissed').sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')),
    [employees],
  );
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const currentEmployeeId = staff.some(e => e.id === selectedEmployeeId) ? selectedEmployeeId : staff[0]?.id || '';
  const employeeName = (id: string) => employees.find(e => e.id === id)?.fullName ?? '—';

  // ---- Цели ----
  const [goalPeriod, setGoalPeriod] = useState<string>(currentPeriod());
  const employeeGoals = useMemo(
    () => goals.filter(g => g.employeeId === currentEmployeeId && (goalPeriod === 'all' || g.period === goalPeriod)),
    [goals, currentEmployeeId, goalPeriod],
  );
  const [goalDialog, setGoalDialog] = useState<GoalDraft | null>(null);

  const saveGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goalDialog || !goalDialog.title.trim() || !currentEmployeeId) return;
    const data = {
      title: goalDialog.title.trim(),
      progress: Math.max(0, Math.min(100, Math.round(goalDialog.progress) || 0)),
      // Прогресс 100% — цель выполнена, как бы ни был выставлен статус.
      status: goalDialog.progress >= 100 ? 'completed' : goalDialog.status,
      period: goalDialog.period,
    };
    if (goalDialog.id) await updateIn(TABLES.goals, goalDialog.id, data);
    else await createIn<Goal>(TABLES.goals, { employeeId: currentEmployeeId, ...data });
    notify.success(t('performance.goalSaved'));
    setGoalDialog(null);
  };

  const deleteGoal = async (goal: Goal) => {
    if (!(await notify.confirm(t('performance.deleteGoalConfirm', { title: goal.title }), { danger: true }))) return;
    await removeFrom(TABLES.goals, goal.id);
  };

  // ---- Цикл оценки 360° ----
  const activeCycle = useMemo(
    () => reviewCycles.filter(c => c.status === 'active').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0],
    [reviewCycles],
  );
  const scopeOf = (cycle: ReviewCycle): string[] => {
    try {
      const ids = JSON.parse(cycle.scope || '[]');
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  };

  // Участники цикла: вся организация или выбранные подразделения вместе с
  // вложенными. Уволенные не оцениваются.
  const cycleParticipants = useMemo(() => {
    if (!activeCycle) return [];
    const ids = scopeOf(activeCycle);
    if (ids.length === 0) return staff;
    const all = new Set<string>();
    for (const id of ids) {
      all.add(id);
      descendantIds(departments, id).forEach(d => all.add(d));
    }
    const names = new Set(departments.filter(d => all.has(d.id)).map(d => d.name));
    return staff.filter(e => names.has(e.department));
  }, [activeCycle, staff, departments]);

  const reviewedInCycle = useMemo(
    () => new Set(reviews.filter(r => activeCycle && r.period === activeCycle.period).map(r => r.employeeId)),
    [reviews, activeCycle],
  );
  const pendingReview = cycleParticipants.filter(e => !reviewedInCycle.has(e.id));
  const cycleReviews = reviews.filter(r => activeCycle && r.period === activeCycle.period && cycleParticipants.some(e => e.id === r.employeeId));
  const cycleAverage = cycleReviews.length > 0 ? cycleReviews.reduce((s, r) => s + r.score, 0) / cycleReviews.length : null;

  const [launchDialog, setLaunchDialog] = useState<{ period: string; whole: boolean; departments: string[] } | null>(null);

  const launchCycle = async () => {
    if (!launchDialog) return;
    if (!launchDialog.whole && launchDialog.departments.length === 0) {
      notify.error(t('performance.chooseScope'));
      return;
    }
    // Одновременно идёт один цикл: прежний активный закрывается.
    if (activeCycle) {
      if (!(await notify.confirm(t('performance.replaceCycle', { period: periodLabel(activeCycle.period) })))) return;
      await updateIn(TABLES.reviewCycles, activeCycle.id, { status: 'closed' });
    }
    await createIn<ReviewCycle>(TABLES.reviewCycles, {
      period: launchDialog.period,
      scope: JSON.stringify(launchDialog.whole ? [] : launchDialog.departments),
      startedAt: new Date().toISOString(),
      status: 'active',
    });
    notify.success(t('performance.launched'));
    setLaunchDialog(null);
  };

  const closeCycle = async () => {
    if (!activeCycle) return;
    if (!(await notify.confirm(t('performance.closeCycleConfirm', { period: periodLabel(activeCycle.period) })))) return;
    await updateIn(TABLES.reviewCycles, activeCycle.id, { status: 'closed' });
  };

  // ---- Оценка ----
  const [reviewDialog, setReviewDialog] = useState<{ employeeId: string; score: string; comment: string; period: string } | null>(null);
  const saveReview = async () => {
    if (!reviewDialog) return;
    await createIn<Review>(TABLES.reviews, {
      employeeId: reviewDialog.employeeId,
      // Однопользовательское приложение: оценку ставит владелец устройства.
      reviewer: t('user.owner'),
      period: reviewDialog.period,
      score: Number(reviewDialog.score),
      comment: reviewDialog.comment,
    });
    notify.success(t('performance.reviewSaved'));
    setReviewDialog(null);
  };

  const employeeReviews = useMemo(
    () => reviews.filter(r => r.employeeId === currentEmployeeId).sort((a, b) => b.period.localeCompare(a.period)),
    [reviews, currentEmployeeId],
  );

  const initials = (name: string) => name.split(' ').slice(0, 2).map(part => part[0]).join('');
  const goalStatusClass = (status: string) =>
    status === 'completed' ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
      : status === 'on-track' ? 'bg-blue-500/15 text-blue-800 dark:text-blue-300'
        : 'bg-amber-500/15 text-amber-800 dark:text-amber-300';

  return (
    <div className="space-y-6">
      {goalDialog && (
        <Modal
          title={goalDialog.id ? t('performance.editGoal') : t('performance.addGoal')}
          onClose={() => setGoalDialog(null)}
          footer={(
            <>
              <button type="button" onClick={() => setGoalDialog(null)} className={secondaryButton}>{t('common.cancel')}</button>
              <button type="submit" form="goal-form" disabled={!goalDialog.title.trim()} className={primaryButton}>{t('common.save')}</button>
            </>
          )}
        >
          <form id="goal-form" onSubmit={saveGoal} className="space-y-4">
            <Field id="goal-title" label={`${t('performance.goalDesc')} *`}>
              <input id="goal-title" type="text" value={goalDialog.title} onChange={(e) => setGoalDialog({ ...goalDialog, title: e.target.value })} className={inputClass} placeholder={t('performance.goalPh')} />
            </Field>
            <Field id="goal-progress" label={t('performance.progressPct')}>
              <input id="goal-progress" type="number" min="0" max="100" value={goalDialog.progress} onChange={(e) => setGoalDialog({ ...goalDialog, progress: parseInt(e.target.value, 10) || 0 })} className={inputClass} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field id="goal-period" label={t('performance.period')}>
                <select id="goal-period" value={goalDialog.period} onChange={(e) => setGoalDialog({ ...goalDialog, period: e.target.value })} className={inputClass}>
                  {periodOptions().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
                </select>
              </Field>
              <Field id="goal-status" label={t('employees.col.status')}>
                <select id="goal-status" value={goalDialog.status} onChange={(e) => setGoalDialog({ ...goalDialog, status: e.target.value })} className={inputClass}>
                  <option value="on-track">{t('performance.statusOnTrack')}</option>
                  <option value="at-risk">{t('performance.statusAtRisk')}</option>
                  <option value="completed">{t('performance.statusCompleted')}</option>
                </select>
              </Field>
            </div>
          </form>
        </Modal>
      )}

      {launchDialog && (
        <Modal
          title={t('performance.launchTitle')}
          onClose={() => setLaunchDialog(null)}
          footer={(
            <>
              <button onClick={() => setLaunchDialog(null)} className={secondaryButton}>{t('common.cancel')}</button>
              <button onClick={launchCycle} className={primaryButton}>{t('performance.launch')}</button>
            </>
          )}
        >
          <div className="space-y-4">
            <Field id="cycle-period" label={t('performance.reviewPeriod')}>
              <select id="cycle-period" value={launchDialog.period} onChange={(e) => setLaunchDialog({ ...launchDialog, period: e.target.value })} className={inputClass}>
                {periodOptions().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
              </select>
            </Field>
            <fieldset>
              <legend className="block text-sm font-medium text-secondary mb-2">{t('performance.participants')}</legend>
              <div className="space-y-2 bg-app border border-line rounded-xl p-3 max-h-56 overflow-y-auto">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={launchDialog.whole} onChange={(e) => setLaunchDialog({ ...launchDialog, whole: e.target.checked, departments: [] })} className="rounded" />
                  <span className="text-sm text-secondary">{t('performance.wholeCompany')}</span>
                </label>
                {departments.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru')).map(dep => (
                  <label key={dep.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={launchDialog.whole}
                      checked={launchDialog.whole || launchDialog.departments.includes(dep.id)}
                      onChange={(e) => setLaunchDialog({
                        ...launchDialog,
                        departments: e.target.checked ? [...launchDialog.departments, dep.id] : launchDialog.departments.filter(id => id !== dep.id),
                      })}
                      className="rounded"
                    />
                    <span className="text-sm text-secondary">{dep.name}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted mt-2">{t('performance.scopeHint')}</p>
            </fieldset>
          </div>
        </Modal>
      )}

      {reviewDialog && (
        <Modal
          title={t('performance.reviewTitle')}
          onClose={() => setReviewDialog(null)}
          footer={(
            <>
              <button onClick={() => setReviewDialog(null)} className={secondaryButton}>{t('common.cancel')}</button>
              <button onClick={saveReview} className={primaryButton}>{t('performance.submitReview')}</button>
            </>
          )}
        >
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-secondary">{t('performance.colleague')}: {employeeName(reviewDialog.employeeId)}</p>
              <p className="text-xs text-muted mt-1">{t('performance.reviewHint')}</p>
              <p className="text-xs text-muted mt-1">{t('performance.reviewPeriod')}: {periodLabel(reviewDialog.period)}</p>
            </div>
            <Field id="review-score" label={t('performance.overallScore')}>
              <select id="review-score" value={reviewDialog.score} onChange={(e) => setReviewDialog({ ...reviewDialog, score: e.target.value })} className={inputClass}>
                <option value="5">{t('performance.score5')}</option>
                <option value="4">{t('performance.score4')}</option>
                <option value="3">{t('performance.score3')}</option>
                <option value="2">{t('performance.score2')}</option>
                <option value="1">{t('performance.score1')}</option>
              </select>
            </Field>
            <Field id="review-comment" label={t('onboarding.comment')}>
              <textarea id="review-comment" value={reviewDialog.comment} onChange={(e) => setReviewDialog({ ...reviewDialog, comment: e.target.value })} className={`${inputClass} resize-none h-24`} placeholder={t('performance.reviewPh')} />
            </Field>
          </div>
        </Modal>
      )}

      <div className="flex flex-wrap justify-between items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-primary">{t('performance.title')}</h2>
          <p className="text-muted mt-1">{t('performance.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={currentEmployeeId}
            onChange={(e) => setSelectedEmployeeId(e.target.value)}
            className="bg-surface border border-line rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-primary"
            aria-label={t('performance.employee')}
          >
            {staff.map(emp => (
              <option key={emp.id} value={emp.id}>{emp.fullName}</option>
            ))}
          </select>
          <button onClick={() => setLaunchDialog({ period: currentPeriod(), whole: true, departments: [] })} className={primaryButton}>
            {t('performance.launchReview')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          <div className="bg-surface border border-line rounded-2xl p-6">
            <div className="flex flex-wrap justify-between items-center gap-3 mb-6">
              <h3 className="text-lg font-medium text-primary flex items-center gap-2">
                <Target className="w-5 h-5 text-accent-600" />
                {goalPeriod === 'all' ? t('performance.goalsAll') : t('performance.goalsFor', { period: periodLabel(goalPeriod) })}
              </h3>
              <div className="flex items-center gap-3">
                <select aria-label={t('performance.period')} value={goalPeriod} onChange={(e) => setGoalPeriod(e.target.value)} className="bg-app border border-line rounded-xl px-3 py-1.5 text-sm text-primary">
                  <option value="all">{t('performance.allPeriods')}</option>
                  {periodOptions().map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
                </select>
                <button
                  onClick={() => setGoalDialog({ id: null, title: '', progress: 0, status: 'on-track', period: goalPeriod === 'all' ? currentPeriod() : goalPeriod })}
                  disabled={!currentEmployeeId}
                  className="text-sm text-accent-700 dark:text-accent-400 hover:underline font-medium disabled:opacity-50"
                >
                  {t('performance.addGoalShort')}
                </button>
              </div>
            </div>
            <div className="space-y-4">
              {employeeGoals.map(goal => (
                <div key={goal.id} className="bg-surface-3 rounded-xl p-4 border border-line">
                  <div className="flex justify-between items-start mb-2 gap-3">
                    <p className="font-medium text-primary">{goal.title}</p>
                    <div className="flex items-center gap-1">
                      <span className={`text-xs px-2 py-1 rounded-md whitespace-nowrap ${goalStatusClass(goal.status)}`}>
                        {goal.status === 'completed' ? t('performance.gCompleted') : goal.status === 'on-track' ? t('performance.gOnTrack') : t('performance.gRisk')}
                      </span>
                      <button onClick={() => setGoalDialog({ id: goal.id, title: goal.title, progress: goal.progress, status: goal.status, period: goal.period })} aria-label={`${t('common.edit')}: ${goal.title}`} className="p-1.5 text-muted hover:text-primary rounded-lg">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => deleteGoal(goal)} aria-label={`${t('common.delete')}: ${goal.title}`} className="p-1.5 text-muted hover:text-rose-600 rounded-lg">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-muted">{periodLabel(goal.period)}</p>
                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-muted mb-1">
                      <span>{t('performance.progress')}</span>
                      <span className="tabular-nums">{goal.progress}%</span>
                    </div>
                    <div className="w-full bg-surface-4 rounded-full h-1.5" role="progressbar" aria-valuenow={goal.progress} aria-valuemin={0} aria-valuemax={100}>
                      <div className={`h-1.5 rounded-full ${goal.progress === 100 ? 'bg-emerald-600' : 'bg-accent-600'}`} style={{ width: `${goal.progress}%` }} />
                    </div>
                  </div>
                </div>
              ))}

              {employeeGoals.length === 0 && (
                <div className="p-8 text-center text-muted border border-dashed border-line rounded-xl">
                  {t('performance.noGoals')}
                </div>
              )}
            </div>
          </div>

          <div className="bg-surface border border-line rounded-2xl p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h3 className="text-lg font-medium text-primary flex items-center gap-2">
                <Users className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                {activeCycle ? t('performance.cycleTitle', { period: periodLabel(activeCycle.period) }) : t('performance.review360Pending')}
              </h3>
              {activeCycle && (
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-secondary tabular-nums" data-testid="cycle-progress">
                    {t('performance.cycleProgress', { done: cycleParticipants.length - pendingReview.length, total: cycleParticipants.length })}
                  </span>
                  <button onClick={closeCycle} className="text-secondary hover:text-primary hover:underline">{t('performance.closeCycle')}</button>
                </div>
              )}
            </div>
            <div className="space-y-3">
              {activeCycle && pendingReview.map(emp => (
                <div key={emp.id} className="flex items-center justify-between p-4 bg-surface-3 rounded-xl border border-line">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-surface-4 flex items-center justify-center font-medium text-secondary" aria-hidden>
                      {initials(emp.fullName)}
                    </div>
                    <div>
                      <p className="font-medium text-primary">{emp.fullName}</p>
                      <p className="text-xs text-muted">{emp.position}, {emp.department}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setReviewDialog({ employeeId: emp.id, score: '4', comment: '', period: activeCycle.period })}
                    className="bg-surface-4 hover:bg-surface-hover px-3 py-1.5 rounded-lg text-sm text-primary transition-colors"
                  >
                    {t('performance.fill')}
                  </button>
                </div>
              ))}

              {!activeCycle && (
                <div className="p-8 text-center text-muted border border-dashed border-line rounded-xl">{t('performance.noCycle')}</div>
              )}
              {activeCycle && pendingReview.length === 0 && (
                <div className="p-8 text-center text-muted border border-dashed border-line rounded-xl">{t('performance.cycleDone')}</div>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-surface border border-line rounded-2xl p-6">
            <h3 className="text-lg font-medium text-primary flex items-center gap-2 mb-4">
              <TrendingUp className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              {t('performance.devHistory')}
            </h3>
            <div className="relative pl-4 border-l-2 border-line space-y-6">
              {employeeReviews.map(review => (
                <div key={review.id} className="relative">
                  <div className={`absolute -left-[21px] top-1 w-3 h-3 rounded-full ring-4 ring-[var(--surface)] ${review.score >= 4.5 ? 'bg-emerald-500' : review.score >= 3.5 ? 'bg-blue-500' : 'bg-amber-500'}`} />
                  <p className="text-sm font-medium text-primary">{periodLabel(review.period)}: {review.score}</p>
                  {review.comment && <p className="text-xs text-secondary mt-1">{review.comment}</p>}
                  <p className="text-xs text-muted mt-1">{review.reviewer}</p>
                </div>
              ))}
              {employeeReviews.length === 0 && <p className="text-sm text-muted">{t('performance.noReviews')}</p>}
            </div>
          </div>

          {/* Итоги цикла — по сохранённым оценкам, а не похвала-заглушка. */}
          <div className="bg-surface border border-line rounded-2xl p-6">
            <h4 className="font-medium text-primary flex items-center gap-2 mb-3">
              <BarChart3 className="w-5 h-5 text-accent-600" />
              {t('performance.cycleSummary')}
            </h4>
            {activeCycle ? (
              <div className="space-y-1 text-sm">
                <p className="text-secondary">{t('performance.cycleProgress', { done: cycleParticipants.length - pendingReview.length, total: cycleParticipants.length })}</p>
                <p className="text-secondary">
                  {t('performance.averageScore')}: <span className="font-semibold text-primary tabular-nums">{cycleAverage !== null ? cycleAverage.toFixed(1) : '—'}</span>
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted">{t('performance.noCycle')}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
