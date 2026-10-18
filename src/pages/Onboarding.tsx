import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckSquare, Square, UserPlus, UserMinus, ArrowRight, Plus, Trash2 } from 'lucide-react';
import { useDatabaseStore, TABLES } from '../store/useDatabaseStore';
import type { ChecklistTask } from '../store/useDatabaseStore';
import { useNotify } from '../components/Toasts';
import Modal, { Field, inputClass, primaryButton, secondaryButton, dangerButton } from '../components/Modal';

type Kind = 'onboarding' | 'offboarding';

interface DraftTask { title: string; assignee: string }

export default function Onboarding() {
  const { t } = useTranslation();
  const notify = useNotify();
  const { checklistTasks, employees, updateIn, createIn, removeFrom } = useDatabaseStore();

  const [activeTab, setActiveTab] = useState<Kind>('onboarding');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');

  const tasksOfKind = useMemo(
    () => checklistTasks.filter(task => task.kind === activeTab),
    [checklistTasks, activeTab],
  );

  // Сотрудники, у которых есть чек-лист этого типа.
  const employeeIds = useMemo(
    () => Array.from(new Set(tasksOfKind.map(task => task.employeeId))),
    [tasksOfKind],
  );

  const countActive = (kind: Kind) => {
    const tasks = checklistTasks.filter(task => task.kind === kind && !task.done);
    return new Set(tasks.map(task => task.employeeId)).size;
  };

  const currentEmployeeId = employeeIds.includes(selectedEmployeeId)
    ? selectedEmployeeId
    : employeeIds[0] ?? '';

  const tasks = tasksOfKind
    .filter(task => task.employeeId === currentEmployeeId)
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  const selectedTask = selectedTaskId ? tasks.find(task => task.id === selectedTaskId) ?? null : null;

  const employeeName = (id: string) => employees.find(e => e.id === id)?.fullName ?? `— (${t('movements.cardDeleted')})`;

  const completed = tasks.filter(task => task.done).length;
  const progress = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;

  const toggleTask = (task: ChecklistTask) => {
    void updateIn(TABLES.checklistTasks, task.id, { done: !task.done });
  };

  const openTask = (task: ChecklistTask) => {
    setSelectedTaskId(task.id);
    setCommentDraft(task.comment ?? '');
  };

  const saveComment = () => {
    if (!selectedTask) return;
    void updateIn(TABLES.checklistTasks, selectedTask.id, { comment: commentDraft });
    setSelectedTaskId(null);
  };

  const deleteTask = async (task: ChecklistTask) => {
    if (!(await notify.confirm(t('onboarding.deleteTaskConfirm', { title: task.title }), { danger: true }))) return;
    await removeFrom(TABLES.checklistTasks, task.id);
    setSelectedTaskId(null);
  };

  const deleteChecklist = async () => {
    if (!currentEmployeeId) return;
    if (!(await notify.confirm(t('onboarding.deleteChecklistConfirm', { name: employeeName(currentEmployeeId) }), { danger: true }))) return;
    for (const task of tasks) await removeFrom(TABLES.checklistTasks, task.id);
    notify.success(t('onboarding.checklistDeleted'));
  };

  // ---- Новая задача в открытом чек-листе ----
  const [newTask, setNewTask] = useState<DraftTask>({ title: '', assignee: '' });
  const addTask = async () => {
    if (!currentEmployeeId || !newTask.title.trim()) return;
    await createIn<ChecklistTask>(TABLES.checklistTasks, {
      employeeId: currentEmployeeId,
      kind: activeTab,
      title: newTask.title.trim(),
      assignee: newTask.assignee.trim() || undefined,
      done: false,
      orderIndex: Math.max(0, ...tasks.map(x => x.orderIndex ?? 0)) + 1,
    } as Omit<ChecklistTask, 'id'>);
    setNewTask({ title: '', assignee: '' });
  };

  // ---- Новый чек-лист по шаблону ----
  const templateFor = (kind: Kind): DraftTask[] => {
    const titles = t(`onboarding.tpl.${kind}Titles`, { returnObjects: true }) as string[];
    const assignees = t(`onboarding.tpl.${kind}Assignees`, { returnObjects: true }) as string[];
    return titles.map((title, i) => ({ title, assignee: assignees[i] ?? '' }));
  };
  const [createDialog, setCreateDialog] = useState<{ employeeId: string; tasks: DraftTask[] } | null>(null);
  const [createError, setCreateError] = useState('');

  // Адаптация — для работающих без чек-листа, увольнение — для работающих
  // (уволенный уже ушёл) без чек-листа увольнения.
  const candidates = employees
    .filter(e => e.status !== 'dismissed' && !employeeIds.includes(e.id))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'));

  const openCreate = () => {
    setCreateError('');
    setCreateDialog({ employeeId: candidates[0]?.id ?? '', tasks: templateFor(activeTab) });
  };

  const saveChecklist = async () => {
    if (!createDialog) return;
    const items = createDialog.tasks.filter(x => x.title.trim());
    if (!createDialog.employeeId) { setCreateError(t('movements.chooseEmployee')); return; }
    if (items.length === 0) { setCreateError(t('onboarding.noTasksToCreate')); return; }
    try {
      for (const [i, item] of items.entries()) {
        await createIn<ChecklistTask>(TABLES.checklistTasks, {
          employeeId: createDialog.employeeId,
          kind: activeTab,
          title: item.title.trim(),
          assignee: item.assignee.trim() || undefined,
          done: false,
          orderIndex: i + 1,
        } as Omit<ChecklistTask, 'id'>);
      }
      setSelectedEmployeeId(createDialog.employeeId);
      setCreateDialog(null);
      notify.success(t('onboarding.checklistCreated'));
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    }
  };

  const tabTitle = (kind: Kind) => (kind === 'onboarding' ? t('onboarding.tabOnboarding') : t('onboarding.tabOffboarding'));

  return (
    <div className="space-y-6">
      {selectedTask && (
        <Modal
          title={t('onboarding.taskDetails')}
          onClose={() => setSelectedTaskId(null)}
          footer={(
            <>
              <button onClick={() => deleteTask(selectedTask)} className={dangerButton}>{t('common.delete')}</button>
              <button onClick={saveComment} className={secondaryButton}>{t('onboarding.saveComment')}</button>
              <button onClick={() => { toggleTask(selectedTask); setSelectedTaskId(null); }} className={primaryButton}>
                {selectedTask.done ? t('onboarding.markUndone') : t('onboarding.markDone')}
              </button>
            </>
          )}
        >
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-muted uppercase tracking-wider mb-1">{t('onboarding.task')}</p>
              <p className="text-primary">{selectedTask.title}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted uppercase tracking-wider mb-1">{t('onboarding.responsible')}</p>
              <p className="text-primary">{selectedTask.assignee || '—'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted uppercase tracking-wider mb-1">{t('employees.col.status')}</p>
              <p className="text-primary">{selectedTask.done ? t('onboarding.done') : t('onboarding.inProgress')}</p>
            </div>
            <Field id="task-comment" label={t('onboarding.comment')}>
              <textarea
                id="task-comment"
                value={commentDraft}
                onChange={(e) => setCommentDraft(e.target.value)}
                className={`${inputClass} resize-none h-24`}
                placeholder={t('onboarding.commentPh')}
              />
            </Field>
          </div>
        </Modal>
      )}

      {createDialog && (
        <Modal
          title={t('onboarding.createTitle', { kind: tabTitle(activeTab) })}
          onClose={() => setCreateDialog(null)}
          size="lg"
          footer={(
            <>
              <button onClick={() => setCreateDialog(null)} className={secondaryButton}>{t('common.cancel')}</button>
              <button onClick={saveChecklist} className={primaryButton}>{t('onboarding.create')}</button>
            </>
          )}
        >
          <div className="space-y-4">
            <Field id="cl-employee" label={`${t('onboarding.employee')} *`}>
              <select id="cl-employee" value={createDialog.employeeId} onChange={(e) => setCreateDialog({ ...createDialog, employeeId: e.target.value })} className={inputClass}>
                <option value="">{t('employees.form.choose')}</option>
                {candidates.map(e => <option key={e.id} value={e.id}>{e.fullName}</option>)}
              </select>
            </Field>
            <p className="text-sm text-muted">{t('onboarding.templateHint')}</p>
            <div className="space-y-2">
              {createDialog.tasks.map((task, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    aria-label={`${t('onboarding.task')} ${i + 1}`}
                    value={task.title}
                    onChange={(e) => setCreateDialog({ ...createDialog, tasks: createDialog.tasks.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                    className={`${inputClass} flex-[2]`}
                  />
                  <input
                    aria-label={`${t('onboarding.responsible')} ${i + 1}`}
                    value={task.assignee}
                    placeholder={t('onboarding.responsible')}
                    onChange={(e) => setCreateDialog({ ...createDialog, tasks: createDialog.tasks.map((x, j) => (j === i ? { ...x, assignee: e.target.value } : x)) })}
                    className={`${inputClass} flex-1`}
                  />
                  <button
                    type="button"
                    aria-label={`${t('common.delete')}: ${task.title}`}
                    onClick={() => setCreateDialog({ ...createDialog, tasks: createDialog.tasks.filter((_, j) => j !== i) })}
                    className="p-2 text-muted hover:text-rose-600 rounded-lg"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setCreateDialog({ ...createDialog, tasks: [...createDialog.tasks, { title: '', assignee: '' }] })}
                className="flex items-center gap-1 text-sm text-accent-700 dark:text-accent-400 font-medium"
              >
                <Plus className="w-4 h-4" /> {t('onboarding.addTask')}
              </button>
            </div>
            {createError && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{createError}</p>}
          </div>
        </Modal>
      )}

      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-primary">{t('onboarding.title')}</h2>
          <p className="text-muted mt-1">{t('onboarding.subtitle')}</p>
        </div>
        <button onClick={openCreate} disabled={candidates.length === 0} className={`${primaryButton} flex items-center gap-2`}>
          <Plus className="w-4 h-4" />
          {t('onboarding.newChecklist')}
        </button>
      </div>

      <div className="flex gap-4 mb-6">
        {(['onboarding', 'offboarding'] as Kind[]).map(kind => (
          <button
            key={kind}
            onClick={() => setActiveTab(kind)}
            aria-pressed={activeTab === kind}
            className={`flex-1 p-6 rounded-2xl border transition-colors flex items-center gap-4 ${activeTab === kind ? 'bg-accent-500/10 border-accent-500/50' : 'bg-surface border-line hover:bg-surface-hover'}`}
          >
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${activeTab === kind ? 'bg-accent-600 text-white' : 'bg-surface-3 text-muted'}`}>
              {kind === 'onboarding' ? <UserPlus className="w-6 h-6" /> : <UserMinus className="w-6 h-6" />}
            </div>
            <div className="text-left">
              <h3 className={`font-semibold text-lg ${activeTab === kind ? 'text-accent-800 dark:text-accent-300' : 'text-primary'}`}>{tabTitle(kind)}</h3>
              <p className="text-sm text-muted">{t('onboarding.active', { count: countActive(kind) })}</p>
            </div>
          </button>
        ))}
      </div>

      <div className="bg-surface border border-line rounded-2xl p-6">
        <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
          <div className="flex items-center gap-3">
            <label htmlFor="cl-current" className="text-sm text-secondary">
              {activeTab === 'onboarding' ? t('onboarding.newEmployee') : t('onboarding.leaving')}:
            </label>
            <select
              id="cl-current"
              value={currentEmployeeId}
              onChange={(e) => setSelectedEmployeeId(e.target.value)}
              className="bg-app border border-line rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-primary"
            >
              {employeeIds.length === 0 && <option value="">—</option>}
              {employeeIds.map(id => (
                <option key={id} value={id}>{employeeName(id)}</option>
              ))}
            </select>
            {currentEmployeeId && (
              <button onClick={deleteChecklist} className="text-sm text-rose-700 dark:text-rose-400 hover:underline">{t('onboarding.deleteChecklist')}</button>
            )}
          </div>
          {tasks.length > 0 && (
            <div className="flex items-center gap-3 min-w-[12rem]">
              <div className="flex-1 h-2 rounded-full bg-surface-3 overflow-hidden" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={t('onboarding.progress')}>
                <div className="h-full bg-accent-600" style={{ width: `${progress}%` }} />
              </div>
              <span className="text-sm text-secondary tabular-nums">{progress}%</span>
            </div>
          )}
        </div>

        <div className="space-y-3">
          {tasks.map(task => (
            <div key={task.id} className="flex items-center gap-4 p-4 rounded-xl border border-line bg-surface-2 hover:bg-surface-hover transition-colors">
              <button
                onClick={() => toggleTask(task)}
                aria-label={task.done ? t('onboarding.markUndone') : t('onboarding.markDone')}
                aria-pressed={task.done}
                className={`${task.done ? 'text-accent-600' : 'text-muted hover:text-accent-600'} transition-colors`}
              >
                {task.done ? <CheckSquare className="w-6 h-6" /> : <Square className="w-6 h-6" />}
              </button>
              <div className="flex-1">
                <p className={`font-medium ${task.done ? 'text-muted line-through' : 'text-primary'}`}>{task.title}</p>
                <p className="text-xs text-muted mt-1">
                  {t('onboarding.responsible')}: {task.assignee || '—'}
                  {task.comment ? ` · ${task.comment}` : ''}
                </p>
              </div>
              <button onClick={() => openTask(task)} aria-label={t('onboarding.taskDetails')} className="p-2 text-muted hover:text-primary transition-colors cursor-pointer">
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          ))}

          {currentEmployeeId && (
            <form className="flex flex-wrap gap-2 pt-2" onSubmit={(e) => { e.preventDefault(); void addTask(); }}>
              <input
                aria-label={t('onboarding.newTaskTitle')}
                placeholder={t('onboarding.newTaskTitle')}
                value={newTask.title}
                onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                className={`${inputClass} flex-[2] min-w-[12rem]`}
              />
              <input
                aria-label={t('onboarding.responsible')}
                placeholder={t('onboarding.responsible')}
                value={newTask.assignee}
                onChange={(e) => setNewTask({ ...newTask, assignee: e.target.value })}
                className={`${inputClass} flex-1 min-w-[8rem]`}
              />
              <button type="submit" disabled={!newTask.title.trim()} className={`${secondaryButton} flex items-center gap-1 disabled:opacity-50`}>
                <Plus className="w-4 h-4" /> {t('onboarding.addTask')}
              </button>
            </form>
          )}

          {tasks.length === 0 && (
            <div className="p-8 text-center text-muted border border-dashed border-line rounded-xl">
              {t('onboarding.noChecklists')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
