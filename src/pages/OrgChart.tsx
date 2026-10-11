import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Users, Briefcase, Plus, X } from 'lucide-react';
import { useDatabaseStore } from '../store/useDatabaseStore';
import { useMoney } from '../lib/money';
import { positionStats, staffingSummary } from '../lib/staffing';
import { clickable } from '../lib/a11y';

export default function OrgChart() {
  const { t } = useTranslation();
  const { employees, departments, positions } = useDatabaseStore();
  const money = useMoney();
  
  const [selectedDepartment, setSelectedDepartment] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Индекс «родитель -> дети» для рекурсивного обхода. Узлы, чей parentId
  // указывает в никуда, считаем корневыми: иначе они пропали бы из дерева.
  const { roots, childrenOf } = useMemo(() => {
    const known = new Set(departments.map((d) => d.id));
    const byParent = new Map<string, typeof departments>();
    const topLevel: typeof departments = [];

    for (const dep of departments) {
      const parentId = dep.parentId;
      if (!parentId || !known.has(parentId)) {
        topLevel.push(dep);
        continue;
      }
      const siblings = byParent.get(parentId);
      if (siblings) siblings.push(dep);
      else byParent.set(parentId, [dep]);
    }

    return {
      roots: topLevel,
      childrenOf: (id: string) => byParent.get(id) ?? [],
    };
  }, [departments]);

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  
  // Modals state
  const [isDepModalOpen, setIsDepModalOpen] = useState(false);
  const [isPosModalOpen, setIsPosModalOpen] = useState(false);
  const [editingDep, setEditingDep] = useState<any>(null);
  const [editingPos, setEditingPos] = useState<any>(null);
  const [depForm, setDepForm] = useState({ name: '', parentId: 'd1' });
  const [posForm, setPosForm] = useState({ title: '', maxCount: 1, salary: 0 });
  const { addDepartment, updateDepartment, addPosition, updatePosition } = useDatabaseStore();

  const handleSaveDep = async () => {
    if (editingDep) await updateDepartment(editingDep.id, depForm);
    else await addDepartment(depForm);
    setIsDepModalOpen(false);
    setEditingDep(null);
  };

  const handleSavePos = async () => {
    const data = { ...posForm, departmentId: selectedDepartment || 'd1' };
    if (editingPos) await updatePosition(editingPos.id, data);
    else await addPosition(data);
    setIsPosModalOpen(false);
    setEditingPos(null);
  };

  // Using the new departments state

  const currentDepartment = useMemo(() => {
    if (!selectedDepartment) return null;
    return departments.find(d => d.name === selectedDepartment || d.id === selectedDepartment);
  }, [departments, selectedDepartment]);

  // Расчёт занятости вынесен в src/lib/staffing.ts: он же используется в
  // отчёте по штатной расстановке, и держать две слегка разные версии
  // было нечем оправдать.
  const stats = useMemo(
    () => positionStats(positions, employees, departments, currentDepartment?.id ?? null),
    [positions, employees, departments, currentDepartment],
  );

  const { total: totalPositions, occupied: totalOccupied, vacant: totalVacant } = staffingSummary(stats);

  // Рекурсивный рендер: раньше здесь был плоский список с условием
  // `d.parentId === 'd1' || d.parentId !== null`, пропускавшим любой узел
  // с непустым родителем, из-за чего вложенность не отрисовывалась вовсе.
  const renderNode = (dep: (typeof departments)[number], depth: number) => {
    const children = childrenOf(dep.id);
    const hasChildren = children.length > 0;
    const isOpen = hasChildren && !collapsed.has(dep.id);
    const isSelected = selectedDepartment === dep.id;

    return (
      <div key={dep.id}>
        <div
          {...clickable(() => setSelectedDepartment(dep.id), dep.name)}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          className={`flex items-center gap-2 py-2 pr-2 rounded-lg cursor-pointer transition-colors ${isSelected ? 'bg-accent-50 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400' : 'hover:bg-surface-hover dark:hover:bg-slate-800 text-secondary dark:text-slate-300'}`}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-label={dep.name}
              onClick={(e) => { e.stopPropagation(); toggleCollapsed(dep.id); }}
              className="p-0.5 rounded hover:bg-surface-hover transition-colors flex-shrink-0"
            >
              <ChevronRight className={`w-4 h-4 transform transition-transform ${isOpen ? 'rotate-90' : ''} ${isSelected ? 'text-accent-500' : ''}`} />
            </button>
          ) : (
            <span className="w-5 flex-shrink-0" />
          )}
          <Users className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'text-accent-500' : ''}`} />
          <span className="text-sm truncate">{dep.name}</span>
        </div>
        {isOpen && children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <>
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">{t('nav.org_chart')}</h2>
        <button 
          onClick={() => { setDepForm({ name: '', parentId: 'd1' }); setEditingDep(null); setIsDepModalOpen(true); }}
          className="flex items-center gap-2 bg-accent-600 hover:bg-accent-700 text-white px-4 py-2 rounded-xl font-medium transition-colors shadow-sm">
          <Plus className="w-4 h-4" />
          {t('orgchart.newDepartment')}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm overflow-hidden flex flex-col h-[600px]">
          <div className="p-4 border-b border-[var(--border-color)] bg-surface-2 dark:bg-slate-900/50">
            <h3 className="font-semibold">{t('orgchart.structure')}</h3>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
            <div
              {...clickable(() => setSelectedDepartment(null), t('orgchart.all'))}
              className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors ${selectedDepartment === null ? 'bg-accent-50 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400' : 'hover:bg-surface-hover dark:hover:bg-slate-800 text-secondary dark:text-slate-300'}`}
            >
              <ChevronRight className={`w-4 h-4 transform ${selectedDepartment === null ? 'rotate-90' : ''}`} />
              <Briefcase className="w-4 h-4" />
              <span className="font-medium text-sm">{t('profile.company')} ({t('orgchart.all')})</span>
            </div>
            
            <div className="space-y-1">
              {roots.map((dep) => renderNode(dep, 0))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm flex flex-col h-[600px]">
          <div className="p-6 border-b border-[var(--border-color)] flex justify-between items-start flex-shrink-0">
            <div>
              <h3 className="text-xl font-semibold mb-1">
                {currentDepartment ? currentDepartment.name : t('profile.company')}
              </h3>
              <p className="text-sm text-muted">
                {selectedDepartment ? t('orgchart.subdivision') : t('orgchart.headOrg')}
              </p>
            </div>
            <div className="flex gap-2">
              {currentDepartment && (
                <button 
                  onClick={() => { setDepForm({ name: currentDepartment.name, parentId: currentDepartment.parentId || 'd1' }); setEditingDep(currentDepartment); setIsDepModalOpen(true); }}
                  className="border border-[var(--border-color)] hover:bg-surface-hover dark:hover:bg-slate-800 px-3 py-1.5 rounded-lg transition-colors text-sm font-medium">
                  {t('employees.form.editTitle')}
                </button>
              )}
              <button
                className="bg-accent-50 text-accent-700 hover:bg-accent-100 dark:bg-accent-900/30 dark:text-accent-400 dark:hover:bg-accent-900/50 px-3 py-1.5 rounded-lg transition-colors text-sm font-medium">
                {t('orgchart.newRevision')}
              </button>
            </div>
          </div>
          
          <div className="p-6 overflow-y-auto flex-1 custom-scrollbar">
            <h4 className="text-sm font-medium text-muted mb-4 uppercase tracking-wider">{t('orgchart.staffSummary')}</h4>
            <div className="grid grid-cols-3 gap-4 mb-8">
              <div className="bg-surface-2 dark:bg-slate-900/50 p-4 rounded-xl border border-[var(--border-color)]">
                <div className="text-2xl font-semibold mb-1 tabular-nums">{totalPositions}</div>
                <div className="text-sm text-muted">{t('orgchart.staffUnits')}</div>
              </div>
              <div className="bg-emerald-50 dark:bg-emerald-900/20 p-4 rounded-xl border border-emerald-100 dark:border-emerald-900/50">
                <div className="text-2xl font-semibold mb-1 text-emerald-700 dark:text-emerald-400 tabular-nums">{totalOccupied}</div>
                <div className="text-sm text-emerald-600 dark:text-emerald-500">{t('orgchart.occupied')}</div>
              </div>
              <div className="bg-amber-50 dark:bg-amber-900/20 p-4 rounded-xl border border-amber-100 dark:border-amber-900/50">
                <div className="text-2xl font-semibold mb-1 text-amber-700 dark:text-amber-400 tabular-nums">{totalVacant}</div>
                <div className="text-sm text-amber-600 dark:text-amber-500">{t('orgchart.vacant')}</div>
              </div>
            </div>

            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-medium text-muted uppercase tracking-wider">{t('nav.org_chart')}</h4>
              {currentDepartment && (
                <button 
                  onClick={() => { setPosForm({ title: '', maxCount: 1, salary: 0 }); setEditingPos(null); setIsPosModalOpen(true); }}
                  className="flex items-center gap-1 text-accent-600 dark:text-accent-400 hover:text-accent-700 dark:hover:text-accent-300 text-sm font-medium transition-colors">
                  <Plus className="w-4 h-4" />
                  {t('orgchart.newPosition')}
                </button>
              )}
            </div>
            <div className="border border-[var(--border-color)] rounded-xl overflow-hidden">
              <table className="w-full text-sm text-left">
                <thead className="bg-surface-2 dark:bg-slate-900/50 border-b border-[var(--border-color)]">
                  <tr>
                    <th className="p-table text-table font-medium">{t('employees.col.position')}</th>
                    <th className="p-table text-table font-medium text-center">{t('orgchart.occupied')}</th>
                    <th className="p-table text-table font-medium text-center">{t('orgchart.vacant')}</th>
                    <th className="p-table text-table font-medium text-right">{t('orgchart.unitsCount')}</th>
                    <th className="p-table text-table font-medium text-right">{t('orgchart.salary')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-color)]">
                  {stats.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-table text-table text-center text-muted py-8">
                        {t('orgchart.noData')}
                      </td>
                    </tr>
                  ) : (
                    stats.map((pos, idx) => (
                      <tr key={idx} className="hover:bg-surface-hover dark:hover:bg-slate-900 transition-colors">
                        <td className="p-table text-table font-medium">{pos.title}</td>
                        <td className="p-table text-table text-center text-emerald-600 dark:text-emerald-400">{pos.occupied}</td>
                        <td className="p-table text-table text-center text-amber-600 dark:text-amber-400">{pos.vacant}</td>
                        <td className="p-table text-table text-right font-medium">{pos.total}</td>
                        <td className="p-table text-table text-right text-muted">
                          {pos.salary > 0 ? money.format(pos.salary) : t('orgchart.notSet')}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>

      {/* Modals */}
      {isDepModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl w-full max-w-md p-6 max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold">{editingDep ? t('orgchart.editDep') : t('orgchart.newDepartment')}</h3>
              <button onClick={() => setIsDepModalOpen(false)} className="text-muted hover:text-secondary">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">{t('orgchart.depName')}</label>
                <input 
                  type="text" 
                  value={depForm.name} 
                  onChange={e => setDepForm({ ...depForm, name: e.target.value })}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2"
                />
              </div>
              <button 
                onClick={handleSaveDep}
                className="w-full bg-accent-600 hover:bg-accent-700 text-white py-2 rounded-xl font-medium"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isPosModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl w-full max-w-md p-6 max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold">{editingPos ? t('orgchart.editPos') : t('orgchart.newPosition')}</h3>
              <button onClick={() => setIsPosModalOpen(false)} className="text-muted hover:text-secondary">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">{t('orgchart.posName')}</label>
                <input 
                  type="text" 
                  value={posForm.title} 
                  onChange={e => setPosForm({ ...posForm, title: e.target.value })}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t('orgchart.unitsCount')}</label>
                <input 
                  type="number" 
                  value={posForm.maxCount} 
                  onChange={e => setPosForm({ ...posForm, maxCount: parseInt(e.target.value) })}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t('orgchart.salary')}</label>
                <input 
                  type="number" 
                  value={posForm.salary} 
                  onChange={e => setPosForm({ ...posForm, salary: parseFloat(e.target.value) })}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2"
                />
              </div>
              <button 
                onClick={handleSavePos}
                className="w-full bg-accent-600 hover:bg-accent-700 text-white py-2 rounded-xl font-medium"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}
