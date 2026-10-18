import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Users, Briefcase, Plus, Pencil, Trash2, History, AlertTriangle } from 'lucide-react';
import { useDatabaseStore, TABLES } from '../store/useDatabaseStore';
import type { Department, Position, StaffingRevision } from '../store/useDatabaseStore';
import { useAppStore } from '../store/useAppStore';
import { useMoney } from '../lib/money';
import { useDates, localDateISO } from '../lib/dates';
import { positionStats, staffingSummary } from '../lib/staffing';
import { departmentNameError, descendantIds, parentError, positionErrors } from '../lib/validation';
import { compareSnapshots, makeSnapshot, parseSnapshot, snapshotTotals } from '../lib/staffingRevisions';
import { clickable } from '../lib/a11y';
import { useNotify } from '../components/Toasts';
import Modal, { Field, inputClass, primaryButton, secondaryButton, dangerButton } from '../components/Modal';

const errorText = (t: (k: string, o?: Record<string, unknown>) => string, code?: string | null) =>
  code ? t(`errors.${code}`) : null;

export default function OrgChart() {
  const { t } = useTranslation();
  const notify = useNotify();
  const money = useMoney();
  const dates = useDates();
  const orgName = useAppStore((s) => s.orgName);
  const {
    employees, departments, positions, staffingRevisions,
    addDepartment, updateDepartment, deleteDepartment, addPosition, updatePosition, deletePosition,
    createIn, removeFrom,
  } = useDatabaseStore();

  // null — вся организация.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [withChildren, setWithChildren] = useState(false);

  // Корень подписан названием организации из «Настроек», а не вымышленной
  // демо-компанией. Пока название не задано, — просто «Вся организация».
  // Заголовок — название организации из настроек. В дереве корень всегда
  // «Вся организация»: подразделение верхнего уровня часто называют так же,
  // как организацию, и два одинаковых пункта подряд путали бы.
  const orgTitle = orgName && orgName !== 'KADRA' ? orgName : t('orgchart.wholeOrg');
  const rootLabel = t('orgchart.wholeOrg');

  // Индекс «родитель → дети». Узлы, чей родитель указывает в никуда (старые
  // данные), считаем корневыми: иначе они пропали бы из дерева.
  const { roots, childrenOf, depthOf } = useMemo(() => {
    const known = new Set(departments.map((d) => d.id));
    const byParent = new Map<string, Department[]>();
    const topLevel: Department[] = [];
    for (const dep of departments) {
      if (!dep.parentId || !known.has(dep.parentId)) {
        topLevel.push(dep);
        continue;
      }
      byParent.set(dep.parentId, [...(byParent.get(dep.parentId) ?? []), dep]);
    }
    const sortByName = (list: Department[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const depth = new Map<string, number>();
    const walk = (list: Department[], level: number) => {
      for (const d of list) {
        depth.set(d.id, level);
        walk(byParent.get(d.id) ?? [], level + 1);
      }
    };
    walk(topLevel, 0);
    return {
      roots: sortByName(topLevel),
      childrenOf: (id: string) => sortByName(byParent.get(id) ?? []),
      depthOf: (id: string) => depth.get(id) ?? 0,
    };
  }, [departments]);

  /** Подразделения в порядке дерева — для выпадающего списка «Вышестоящее». */
  const treeOrder = useMemo(() => {
    const out: Department[] = [];
    const walk = (list: Department[]) => list.forEach((d) => { out.push(d); walk(childrenOf(d.id)); });
    walk(roots);
    return out;
  }, [roots, childrenOf]);

  const current = selectedId ? departments.find((d) => d.id === selectedId) ?? null : null;
  const currentHasChildren = current ? childrenOf(current.id).length > 0 : false;

  // Область расчёта: вся организация, подразделение или подразделение с
  // вложенными. Вложенные по умолчанию не включаются — так цифры совпадают
  // с собственным штатом подразделения.
  const scopeIds = useMemo(() => {
    if (!current) return null;
    const ids = new Set([current.id]);
    if (withChildren) descendantIds(departments, current.id).forEach((id) => ids.add(id));
    return ids;
  }, [current, withChildren, departments]);

  const stats = useMemo(() => {
    const scoped = scopeIds ? positions.filter((p) => scopeIds.has(p.departmentId)) : positions;
    return positionStats(scoped, employees, departments);
  }, [positions, employees, departments, scopeIds]);
  const summary = staffingSummary(stats);
  const showDepartmentColumn = !current || withChildren;

  const toggleCollapsed = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ---- Подразделение: создание и правка ----
  const [depDialog, setDepDialog] = useState<{ id: string | null; name: string; parentId: string } | null>(null);
  const [depError, setDepError] = useState<{ name?: string | null; parent?: string | null; form?: string | null }>({});
  const [busy, setBusy] = useState(false);

  const openNewDepartment = () => {
    setDepError({});
    // Новое подразделение по умолчанию кладётся внутрь выбранного.
    setDepDialog({ id: null, name: '', parentId: current?.id ?? '' });
  };
  const openEditDepartment = () => {
    if (!current) return;
    setDepError({});
    setDepDialog({ id: current.id, name: current.name, parentId: current.parentId ?? '' });
  };

  // Нельзя подчинить подразделение самому себе или своему потомку.
  const forbiddenParents = useMemo(() => {
    if (!depDialog?.id) return new Set<string>();
    return new Set([depDialog.id, ...descendantIds(departments, depDialog.id)]);
  }, [depDialog, departments]);

  const saveDepartment = async () => {
    if (!depDialog) return;
    const nameErr = departmentNameError(depDialog.name, departments, depDialog.id);
    const parentErr = parentError(departments, depDialog.id, depDialog.parentId || null);
    if (nameErr || parentErr) {
      setDepError({ name: errorText(t, nameErr), parent: errorText(t, parentErr) });
      return;
    }
    setBusy(true);
    try {
      const data = { name: depDialog.name.trim(), parentId: depDialog.parentId || null };
      if (depDialog.id) {
        const renamed = departments.find((d) => d.id === depDialog.id)?.name !== data.name;
        const affected = renamed ? employees.filter((e) => e.department === departments.find((d) => d.id === depDialog.id)?.name).length : 0;
        await updateDepartment(depDialog.id, data);
        notify.success(affected > 0 ? t('orgchart.depRenamed', { count: affected }) : t('orgchart.depSaved'));
      } else {
        const id = await addDepartment(data);
        if (id) setSelectedId(id);
        notify.success(t('orgchart.depSaved'));
      }
      setDepDialog(null);
    } catch (e) {
      setDepError({ form: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const removeDepartment = async () => {
    if (!current) return;
    const ownPositions = positions.filter((p) => p.departmentId === current.id).length;
    const message = ownPositions > 0
      ? t('orgchart.deleteDepConfirmPositions', { name: current.name, count: ownPositions })
      : t('orgchart.deleteDepConfirm', { name: current.name });
    if (!(await notify.confirm(message, { danger: true }))) return;
    try {
      await deleteDepartment(current.id);
      setSelectedId(current.parentId && departments.some((d) => d.id === current.parentId) ? current.parentId : null);
      notify.success(t('orgchart.depDeleted'));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  // ---- Должность: создание, правка, удаление ----
  interface PosDraft { id: string | null; departmentId: string; title: string; maxCount: string; salary: string }
  const [posDialog, setPosDialog] = useState<PosDraft | null>(null);
  const [posError, setPosError] = useState<Record<string, string | null>>({});

  const openNewPosition = () => {
    if (!current) return;
    setPosError({});
    setPosDialog({ id: null, departmentId: current.id, title: '', maxCount: '1', salary: '0' });
  };
  const openEditPosition = (p: Position) => {
    setPosError({});
    setPosDialog({ id: p.id, departmentId: p.departmentId, title: p.title, maxCount: String(p.maxCount), salary: String(p.salary) });
  };

  const savePosition = async () => {
    if (!posDialog) return;
    const siblings = positions.filter((p) => p.departmentId === posDialog.departmentId);
    const errors = positionErrors(posDialog, siblings, posDialog.id);
    if (Object.keys(errors).length > 0) {
      setPosError({ title: errorText(t, errors.title), maxCount: errorText(t, errors.maxCount), salary: errorText(t, errors.salary) });
      return;
    }
    setBusy(true);
    try {
      const data = {
        departmentId: posDialog.departmentId,
        title: posDialog.title.trim(),
        maxCount: Number(posDialog.maxCount),
        salary: Number(posDialog.salary),
      };
      if (posDialog.id) await updatePosition(posDialog.id, data);
      else await addPosition(data);
      notify.success(t('orgchart.posSaved'));
      setPosDialog(null);
    } catch (e) {
      setPosError({ form: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const removePosition = async (p: Position) => {
    const depName = departments.find((d) => d.id === p.departmentId)?.name;
    const occupied = employees.filter((e) => e.status !== 'dismissed' && e.position === p.title && e.department === depName).length;
    const message = occupied > 0
      ? t('orgchart.deletePosConfirmOccupied', { title: p.title, count: occupied })
      : t('orgchart.deletePosConfirm', { title: p.title });
    if (!(await notify.confirm(message, { danger: true }))) return;
    try {
      await deletePosition(p.id);
      notify.success(t('orgchart.posDeleted'));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  // ---- Редакции штатного расписания ----
  const [revisionDialog, setRevisionDialog] = useState<{ title: string; effectiveDate: string; note: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [comparing, setComparing] = useState<StaffingRevision | null>(null);
  const currentSnapshot = useMemo(() => makeSnapshot(departments, positions), [departments, positions]);

  const openNewRevision = () => {
    const today = localDateISO();
    setRevisionDialog({ title: t('orgchart.revisionDefaultName', { date: dates.date(today) }), effectiveDate: today, note: '' });
  };

  const saveRevision = async () => {
    if (!revisionDialog || !revisionDialog.title.trim() || !revisionDialog.effectiveDate) return;
    setBusy(true);
    try {
      await createIn<StaffingRevision>(TABLES.staffingRevisions, {
        title: revisionDialog.title.trim(),
        effectiveDate: revisionDialog.effectiveDate,
        createdAt: new Date().toISOString(),
        note: revisionDialog.note.trim() || undefined,
        snapshot: JSON.stringify(currentSnapshot),
      });
      notify.success(t('orgchart.revisionSaved'));
      setRevisionDialog(null);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeRevision = async (r: StaffingRevision) => {
    if (!(await notify.confirm(t('orgchart.revisionDeleteConfirm', { title: r.title }), { danger: true }))) return;
    await removeFrom(TABLES.staffingRevisions, r.id);
    if (comparing?.id === r.id) setComparing(null);
  };

  const sortedRevisions = useMemo(
    () => [...staffingRevisions].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.createdAt.localeCompare(a.createdAt)),
    [staffingRevisions],
  );

  const renderNode = (dep: Department, depth: number) => {
    const children = childrenOf(dep.id);
    const hasChildren = children.length > 0;
    const isOpen = hasChildren && !collapsed.has(dep.id);
    const isSelected = selectedId === dep.id;
    return (
      <div key={dep.id}>
        <div
          {...clickable(() => setSelectedId(dep.id), dep.name)}
          aria-current={isSelected ? 'true' : undefined}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          className={`flex items-center gap-2 py-2 pr-2 rounded-lg cursor-pointer transition-colors ${isSelected ? 'bg-accent-500/15 text-accent-800 dark:text-accent-300' : 'hover:bg-surface-hover text-secondary'}`}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-label={isOpen ? t('orgchart.collapse', { name: dep.name }) : t('orgchart.expand', { name: dep.name })}
              aria-expanded={isOpen}
              onClick={(e) => { e.stopPropagation(); toggleCollapsed(dep.id); }}
              className="p-0.5 rounded hover:bg-surface-hover transition-colors flex-shrink-0"
            >
              <ChevronRight className={`w-4 h-4 transform transition-transform ${isOpen ? 'rotate-90' : ''}`} />
            </button>
          ) : (
            <span className="w-5 flex-shrink-0" />
          )}
          <Users className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm truncate">{dep.name}</span>
        </div>
        {isOpen && children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-semibold tracking-tight">{t('nav.org_chart')}</h2>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setHistoryOpen(true)} className={`${secondaryButton} flex items-center gap-2`}>
              <History className="w-4 h-4" />
              {t('orgchart.revisions')} ({staffingRevisions.length})
            </button>
            <button onClick={openNewRevision} className={`${secondaryButton} flex items-center gap-2`}>
              {t('orgchart.newRevision')}
            </button>
            <button onClick={openNewDepartment} className={`${primaryButton} flex items-center gap-2`}>
              <Plus className="w-4 h-4" />
              {t('orgchart.newDepartment')}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 min-w-0 bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm overflow-hidden flex flex-col h-[600px]">
            <div className="p-4 border-b border-[var(--border-color)] bg-surface-2">
              <h3 className="font-semibold">{t('orgchart.structure')}</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
              <div
                {...clickable(() => setSelectedId(null), rootLabel)}
                aria-current={selectedId === null ? 'true' : undefined}
                className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${selectedId === null ? 'bg-accent-500/15 text-accent-800 dark:text-accent-300' : 'hover:bg-surface-hover text-secondary'}`}
              >
                <Briefcase className="w-4 h-4" />
                <span className="font-medium text-sm truncate" data-testid="org-root">{rootLabel}</span>
              </div>
              <div className="space-y-1">
                {roots.map((dep) => renderNode(dep, 0))}
              </div>
              {departments.length === 0 && (
                <p className="text-sm text-muted px-2 py-4">{t('orgchart.noDepartments')}</p>
              )}
            </div>
          </div>

          <div className="lg:col-span-2 min-w-0 bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm flex flex-col h-[600px]">
            <div className="p-6 border-b border-[var(--border-color)] flex flex-wrap justify-between items-start gap-3 flex-shrink-0">
              <div className="min-w-0">
                <h3 className="text-xl font-semibold mb-1 truncate" data-testid="org-title">{current ? current.name : orgTitle}</h3>
                <p className="text-sm text-muted">
                  {current
                    ? (current.parentId && departments.find((d) => d.id === current.parentId)
                      ? t('orgchart.subordinateTo', { name: departments.find((d) => d.id === current.parentId)!.name })
                      : t('orgchart.topLevelDep'))
                    : t('orgchart.headOrg')}
                </p>
              </div>
              {current && (
                <div className="flex gap-2">
                  <button onClick={openEditDepartment} className={`${secondaryButton} flex items-center gap-2`}>
                    <Pencil className="w-4 h-4" />
                    {t('common.edit')}
                  </button>
                  <button onClick={removeDepartment} className={`${dangerButton} flex items-center gap-2`}>
                    <Trash2 className="w-4 h-4" />
                    {t('common.delete')}
                  </button>
                </div>
              )}
            </div>

            <div className="p-6 overflow-y-auto flex-1 custom-scrollbar">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h4 className="text-sm font-medium text-muted uppercase tracking-wider">{t('orgchart.staffSummary')}</h4>
                {current && currentHasChildren && (
                  <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
                    <input type="checkbox" checked={withChildren} onChange={(e) => setWithChildren(e.target.checked)} className="rounded" />
                    {t('orgchart.withChildren')}
                  </label>
                )}
              </div>
              <div className={`grid ${summary.over > 0 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-3'} gap-4 mb-8`}>
                <div className="bg-surface-2 p-4 rounded-xl border border-[var(--border-color)]">
                  <div className="text-2xl font-semibold mb-1 tabular-nums" data-testid="sum-total">{summary.total}</div>
                  <div className="text-sm text-muted">{t('orgchart.staffUnits')}</div>
                </div>
                <div className="bg-emerald-500/10 p-4 rounded-xl border border-emerald-500/30">
                  <div className="text-2xl font-semibold mb-1 text-emerald-800 dark:text-emerald-300 tabular-nums" data-testid="sum-occupied">{summary.occupied}</div>
                  <div className="text-sm text-emerald-800 dark:text-emerald-300">{t('orgchart.occupied')}</div>
                </div>
                <div className="bg-amber-500/10 p-4 rounded-xl border border-amber-500/30">
                  <div className="text-2xl font-semibold mb-1 text-amber-800 dark:text-amber-300 tabular-nums" data-testid="sum-vacant">{summary.vacant}</div>
                  <div className="text-sm text-amber-800 dark:text-amber-300">{t('orgchart.vacant')}</div>
                </div>
                {summary.over > 0 && (
                  <div className="bg-rose-500/10 p-4 rounded-xl border border-rose-500/30">
                    <div className="text-2xl font-semibold mb-1 text-rose-700 dark:text-rose-300 tabular-nums" data-testid="sum-over">{summary.over}</div>
                    <div className="text-sm text-rose-700 dark:text-rose-300">{t('orgchart.over')}</div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between mb-4">
                <h4 className="text-sm font-medium text-muted uppercase tracking-wider">{t('orgchart.positionsTitle')}</h4>
                {current && (
                  <button
                    onClick={openNewPosition}
                    className="flex items-center gap-1 text-accent-700 dark:text-accent-400 hover:text-accent-800 dark:hover:text-accent-300 text-sm font-medium transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    {t('orgchart.newPosition')}
                  </button>
                )}
              </div>
              {/* Узкое окно: таблица прокручивается в карточке, а не раздвигает страницу. */}
              <div className="relative border border-[var(--border-color)] rounded-xl overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-surface-2 border-b border-[var(--border-color)]">
                    <tr>
                      <th className="p-table text-table font-medium">{t('employees.col.position')}</th>
                      {showDepartmentColumn && <th className="p-table text-table font-medium">{t('employees.col.department')}</th>}
                      <th className="p-table text-table font-medium text-center">{t('orgchart.occupied')}</th>
                      <th className="p-table text-table font-medium text-center">{t('orgchart.vacant')}</th>
                      <th className="p-table text-table font-medium text-right">{t('orgchart.unitsCount')}</th>
                      <th className="p-table text-table font-medium text-right">{t('orgchart.salary')}</th>
                      <th className="p-table text-table font-medium w-20"><span className="sr-only">{t('orgchart.actions')}</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-color)]">
                    {stats.length === 0 ? (
                      <tr>
                        <td colSpan={showDepartmentColumn ? 7 : 6} className="p-table text-table text-center text-muted py-8">
                          {current ? t('orgchart.noPositions') : t('orgchart.noData')}
                        </td>
                      </tr>
                    ) : (
                      stats.map((stat) => {
                        const position = positions.find((p) => p.id === stat.positionId)!;
                        return (
                          <tr key={stat.positionId} className="hover:bg-surface-hover transition-colors">
                            <td className="p-table text-table font-medium">{stat.title}</td>
                            {showDepartmentColumn && <td className="p-table text-table text-secondary">{stat.department}</td>}
                            <td className={`p-table text-table text-center tabular-nums ${stat.over > 0 ? 'text-rose-700 dark:text-rose-400 font-semibold' : 'text-emerald-700 dark:text-emerald-400'}`}>
                              {stat.occupied}
                              {stat.over > 0 && (
                                <span className="ml-1 inline-flex items-center gap-0.5 text-xs" title={t('orgchart.overHint', { count: stat.over })}>
                                  <AlertTriangle className="w-3 h-3" aria-hidden />
                                  <span>{t('orgchart.overHint', { count: stat.over })}</span>
                                </span>
                              )}
                            </td>
                            <td className="p-table text-table text-center text-amber-700 dark:text-amber-400 tabular-nums">{stat.vacant}</td>
                            <td className="p-table text-table text-right font-medium tabular-nums">{stat.total}</td>
                            <td className="p-table text-table text-right text-secondary tabular-nums">
                              {stat.salary > 0 ? money.format(stat.salary) : t('orgchart.notSet')}
                            </td>
                            <td className="p-table text-table text-right whitespace-nowrap">
                              <button
                                onClick={() => openEditPosition(position)}
                                aria-label={t('orgchart.editPosAria', { title: stat.title })}
                                title={t('orgchart.editPosAria', { title: stat.title })}
                                className="p-1.5 rounded-lg text-muted hover:text-primary hover:bg-surface-hover"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => removePosition(position)}
                                aria-label={t('orgchart.deletePosAria', { title: stat.title })}
                                title={t('orgchart.deletePosAria', { title: stat.title })}
                                className="p-1.5 rounded-lg text-muted hover:text-rose-600 hover:bg-rose-500/10"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      {depDialog && (
        <Modal
          title={depDialog.id ? t('orgchart.editDep') : t('orgchart.newDepartment')}
          onClose={() => setDepDialog(null)}
          footer={(
            <>
              <button onClick={() => setDepDialog(null)} className={secondaryButton}>{t('common.cancel')}</button>
              <button onClick={saveDepartment} disabled={busy} className={primaryButton}>{t('common.save')}</button>
            </>
          )}
        >
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void saveDepartment(); }}>
            <Field id="dep-name" label={t('orgchart.depName')} error={depError.name}>
              <input
                id="dep-name"
                type="text"
                value={depDialog.name}
                aria-invalid={Boolean(depError.name)}
                onChange={(e) => { setDepDialog({ ...depDialog, name: e.target.value }); setDepError({ ...depError, name: null }); }}
                className={inputClass}
              />
            </Field>
            <Field id="dep-parent" label={t('orgchart.parent')} error={depError.parent}>
              <select
                id="dep-parent"
                value={depDialog.parentId}
                onChange={(e) => { setDepDialog({ ...depDialog, parentId: e.target.value }); setDepError({ ...depError, parent: null }); }}
                className={inputClass}
              >
                <option value="">{t('orgchart.topLevel')}</option>
                {treeOrder.filter((d) => !forbiddenParents.has(d.id)).map((d) => (
                  <option key={d.id} value={d.id}>{`${'  '.repeat(depthOf(d.id))}${d.name}`}</option>
                ))}
              </select>
            </Field>
            {depError.form && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{depError.form}</p>}
            <button type="submit" hidden />
          </form>
        </Modal>
      )}

      {posDialog && (
        <Modal
          title={posDialog.id ? t('orgchart.editPos') : t('orgchart.newPosition')}
          onClose={() => setPosDialog(null)}
          footer={(
            <>
              <button onClick={() => setPosDialog(null)} className={secondaryButton}>{t('common.cancel')}</button>
              <button onClick={savePosition} disabled={busy} className={primaryButton}>{t('common.save')}</button>
            </>
          )}
        >
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void savePosition(); }}>
            <Field id="pos-title" label={t('orgchart.posName')} error={posError.title}>
              <input
                id="pos-title"
                type="text"
                value={posDialog.title}
                aria-invalid={Boolean(posError.title)}
                onChange={(e) => { setPosDialog({ ...posDialog, title: e.target.value }); setPosError({ ...posError, title: null }); }}
                className={inputClass}
              />
            </Field>
            <Field id="pos-department" label={t('employees.col.department')}>
              <select
                id="pos-department"
                value={posDialog.departmentId}
                onChange={(e) => setPosDialog({ ...posDialog, departmentId: e.target.value })}
                className={inputClass}
              >
                {treeOrder.map((d) => (
                  <option key={d.id} value={d.id}>{`${'  '.repeat(depthOf(d.id))}${d.name}`}</option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field id="pos-units" label={t('orgchart.unitsCount')} error={posError.maxCount}>
                <input
                  id="pos-units"
                  type="number"
                  min={1}
                  step={1}
                  value={posDialog.maxCount}
                  aria-invalid={Boolean(posError.maxCount)}
                  onChange={(e) => { setPosDialog({ ...posDialog, maxCount: e.target.value }); setPosError({ ...posError, maxCount: null }); }}
                  className={inputClass}
                />
              </Field>
              <Field id="pos-salary" label={t('orgchart.salary')} error={posError.salary}>
                <input
                  id="pos-salary"
                  type="number"
                  min={0}
                  step="0.01"
                  value={posDialog.salary}
                  aria-invalid={Boolean(posError.salary)}
                  onChange={(e) => { setPosDialog({ ...posDialog, salary: e.target.value }); setPosError({ ...posError, salary: null }); }}
                  className={inputClass}
                />
              </Field>
            </div>
            {posError.form && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{posError.form}</p>}
            <button type="submit" hidden />
          </form>
        </Modal>
      )}

      {revisionDialog && (
        <Modal
          title={t('orgchart.newRevision')}
          onClose={() => setRevisionDialog(null)}
          footer={(
            <>
              <button onClick={() => setRevisionDialog(null)} className={secondaryButton}>{t('common.cancel')}</button>
              <button
                onClick={saveRevision}
                disabled={busy || !revisionDialog.title.trim() || !revisionDialog.effectiveDate}
                className={primaryButton}
              >
                {t('common.save')}
              </button>
            </>
          )}
        >
          <div className="space-y-4">
            <p className="text-sm text-muted">{t('orgchart.revisionHint')}</p>
            <Field id="rev-title" label={t('orgchart.revisionName')}>
              <input id="rev-title" type="text" value={revisionDialog.title} onChange={(e) => setRevisionDialog({ ...revisionDialog, title: e.target.value })} className={inputClass} />
            </Field>
            <Field id="rev-date" label={t('orgchart.revisionDate')}>
              <input id="rev-date" type="date" value={revisionDialog.effectiveDate} onChange={(e) => setRevisionDialog({ ...revisionDialog, effectiveDate: e.target.value })} className={inputClass} />
            </Field>
            <Field id="rev-note" label={t('orgchart.revisionNote')}>
              <textarea id="rev-note" value={revisionDialog.note} onChange={(e) => setRevisionDialog({ ...revisionDialog, note: e.target.value })} className={`${inputClass} h-20 resize-none`} />
            </Field>
            <p className="text-sm text-secondary">
              {t('orgchart.revisionCurrent', {
                departments: snapshotTotals(currentSnapshot).departments,
                positions: snapshotTotals(currentSnapshot).positions,
                units: snapshotTotals(currentSnapshot).units,
              })}
            </p>
          </div>
        </Modal>
      )}

      {historyOpen && (
        <Modal
          title={comparing ? t('orgchart.diffTitle', { title: comparing.title }) : t('orgchart.revisionsTitle')}
          onClose={() => { setHistoryOpen(false); setComparing(null); }}
          size="xl"
          footer={comparing ? <button onClick={() => setComparing(null)} className={secondaryButton}>{t('common.back')}</button> : undefined}
        >
          {!comparing ? (
            sortedRevisions.length === 0 ? (
              <p className="text-sm text-muted">{t('orgchart.revisionsEmpty')}</p>
            ) : (
              <table className="w-full text-sm text-left">
                <thead className="border-b border-[var(--border-color)] text-muted">
                  <tr>
                    <th className="p-table font-medium">{t('orgchart.revisionName')}</th>
                    <th className="p-table font-medium">{t('orgchart.revisionDate')}</th>
                    <th className="p-table font-medium text-right">{t('orgchart.revisionUnits')}</th>
                    <th className="p-table font-medium text-right">{t('orgchart.revisionFund')}</th>
                    <th className="p-table font-medium"><span className="sr-only">{t('orgchart.actions')}</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-color)]">
                  {sortedRevisions.map((r) => {
                    const totals = snapshotTotals(parseSnapshot(r.snapshot));
                    return (
                      <tr key={r.id}>
                        <td className="p-table">
                          <div className="font-medium text-primary">{r.title}</div>
                          {r.note && <div className="text-xs text-muted">{r.note}</div>}
                        </td>
                        <td className="p-table tabular-nums">{dates.date(r.effectiveDate)}</td>
                        <td className="p-table text-right tabular-nums">{totals.units}</td>
                        <td className="p-table text-right tabular-nums">{money.format(totals.fund)}</td>
                        <td className="p-table text-right whitespace-nowrap">
                          <button onClick={() => setComparing(r)} className="text-accent-700 dark:text-accent-400 hover:underline text-sm font-medium mr-3">
                            {t('orgchart.revisionCompare')}
                          </button>
                          <button onClick={() => removeRevision(r)} className="text-rose-700 dark:text-rose-400 hover:underline text-sm font-medium">
                            {t('common.delete')}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : (
            <RevisionDiff revision={comparing} current={currentSnapshot} />
          )}
        </Modal>
      )}
    </>
  );
}

function RevisionDiff({ revision, current }: { revision: StaffingRevision; current: ReturnType<typeof makeSnapshot> }) {
  const { t } = useTranslation();
  const money = useMoney();
  const before = parseSnapshot(revision.snapshot);
  const rows = compareSnapshots(before, current).filter((r) => r.status !== 'same');
  const a = snapshotTotals(before);
  const b = snapshotTotals(current);
  const cell = (x: number | null, fmt: (n: number) => string = String) => (x === null ? '—' : fmt(x));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="bg-surface-2 rounded-xl p-3">
          <div className="text-muted">{t('orgchart.staffUnits')}</div>
          <div className="tabular-nums font-semibold">{a.units} → {b.units}</div>
        </div>
        <div className="bg-surface-2 rounded-xl p-3">
          <div className="text-muted">{t('orgchart.positionsTitle')}</div>
          <div className="tabular-nums font-semibold">{a.positions} → {b.positions}</div>
        </div>
        <div className="bg-surface-2 rounded-xl p-3">
          <div className="text-muted">{t('orgchart.revisionFund')}</div>
          <div className="tabular-nums font-semibold">{money.format(a.fund)} → {money.format(b.fund)}</div>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t('orgchart.diffNone')}</p>
      ) : (
        <table className="w-full text-sm text-left">
          <thead className="border-b border-[var(--border-color)] text-muted">
            <tr>
              <th className="p-table font-medium">{t('employees.col.department')}</th>
              <th className="p-table font-medium">{t('employees.col.position')}</th>
              <th className="p-table font-medium text-right">{t('orgchart.unitsCount')}</th>
              <th className="p-table font-medium text-right">{t('orgchart.salary')}</th>
              <th className="p-table font-medium">{t('orgchart.diffStatus')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-color)]">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="p-table">{r.department}</td>
                <td className="p-table font-medium">{r.title}</td>
                <td className="p-table text-right tabular-nums">{cell(r.beforeUnits)} → {cell(r.afterUnits)}</td>
                <td className="p-table text-right tabular-nums">{cell(r.beforeSalary, money.format)} → {cell(r.afterSalary, money.format)}</td>
                <td className="p-table">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${r.status === 'added' ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300' : r.status === 'removed' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : 'bg-amber-500/15 text-amber-800 dark:text-amber-300'}`}>
                    {t(`orgchart.diff.${r.status}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
