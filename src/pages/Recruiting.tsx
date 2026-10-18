import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Plus, Filter, UserCheck, Calendar, Briefcase, Pencil } from 'lucide-react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import type { DropResult } from '@hello-pangea/dnd';
import { useDatabaseStore, TABLES } from '../store/useDatabaseStore';
import type { Candidate, CandidateStatus } from '../store/useDatabaseStore';
import { positionStats } from '../lib/staffing';
import { localDateISO, useDates } from '../lib/dates';
import { useNotify } from '../components/Toasts';
import Modal, { Field, inputClass, primaryButton, secondaryButton, dangerButton } from '../components/Modal';

const STATUSES: CandidateStatus[] = ['new', 'screening', 'interview', 'offer', 'hired', 'rejected'];

interface CandidateDraft {
  id: string | null;
  fullName: string;
  position: string;
  experience: string;
  status: CandidateStatus;
  note: string;
}

const emptyDraft = (): CandidateDraft => ({ id: null, fullName: '', position: '', experience: '', status: 'new', note: '' });

export default function Recruiting() {
  const { t } = useTranslation();
  const notify = useNotify();
  const dates = useDates();
  const { candidates, positions, employees, departments, createIn, updateIn, removeFrom } = useDatabaseStore();
  const [dialog, setDialog] = useState<CandidateDraft | null>(null);
  const [formError, setFormError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [positionFilter, setPositionFilter] = useState('');

  // Все шесть статусов воронки достижимы: раньше колонок было четыре, и
  // «Принят» с «Отказом» выставить было нечем.
  const statusLabel = (status: string) => t(`recruiting.col.${status}`, { defaultValue: status });

  // Вакансии — свободные штатные единицы из штатного расписания, как на
  // главной. Раньше плитка считала должности, на которые есть кандидаты.
  const vacancies = useMemo(
    () => positionStats(positions, employees, departments).filter(s => s.vacant > 0),
    [positions, employees, departments],
  );
  const vacantUnits = vacancies.reduce((sum, s) => sum + s.vacant, 0);
  const vacancyTitles = Array.from(new Set(vacancies.map(v => v.title))).sort((a, b) => a.localeCompare(b, 'ru'));

  const uniquePositions = Array.from(new Set(candidates.map(c => c.position))).sort((a, b) => a.localeCompare(b, 'ru'));
  const query = searchQuery.trim().toLowerCase();
  const filteredCandidates = candidates.filter(c => {
    const matchesSearch = !query || c.fullName.toLowerCase().includes(query) || c.position.toLowerCase().includes(query);
    const matchesFilter = positionFilter ? c.position === positionFilter : true;
    return matchesSearch && matchesFilter;
  });

  const stats = {
    newApplicants: candidates.filter(c => c.status === 'new').length,
    interviews: candidates.filter(c => c.status === 'interview').length,
    inProgress: candidates.filter(c => c.status !== 'hired' && c.status !== 'rejected').length,
  };

  const openNew = () => { setFormError(''); setDialog(emptyDraft()); };
  const openEdit = (c: Candidate) => {
    setFormError('');
    setDialog({ id: c.id, fullName: c.fullName, position: c.position, experience: c.experience ?? '', status: c.status, note: c.note ?? '' });
  };

  const saveCandidate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dialog) return;
    const fullName = dialog.fullName.trim();
    const position = dialog.position.trim();
    if (fullName.length < 2) { setFormError(t('recruiting.nameRequired')); return; }
    if (!position) { setFormError(t('recruiting.positionRequired')); return; }
    const data = { fullName, position, experience: dialog.experience.trim(), status: dialog.status, note: dialog.note.trim() };
    try {
      if (dialog.id) await updateIn(TABLES.candidates, dialog.id, data);
      else await createIn<Candidate>(TABLES.candidates, { ...data, createdAt: localDateISO() });
      notify.success(t('recruiting.saved'));
      setDialog(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteCandidate = async () => {
    if (!dialog?.id) return;
    if (!(await notify.confirm(t('recruiting.deleteConfirm', { name: dialog.fullName }), { danger: true }))) return;
    await removeFrom(TABLES.candidates, dialog.id);
    setDialog(null);
  };

  const onDragEnd = (result: DropResult) => {
    const { destination, source, draggableId } = result;
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;
    const candidate = candidates.find(c => c.id === draggableId);
    if (!candidate || candidate.status === destination.droppableId) return;
    // Статус уходит в БД: перемещение карточки — кадровое решение,
    // оно должно переживать перезагрузку.
    void updateIn(TABLES.candidates, candidate.id, { status: destination.droppableId });
    if (destination.droppableId === 'hired') notify.info(t('recruiting.hiredHint', { name: candidate.fullName }));
  };

  return (
    <div className="space-y-6">
      {dialog && (
        <Modal
          title={dialog.id ? t('recruiting.editCandidate') : t('recruiting.addCandidate')}
          onClose={() => setDialog(null)}
          footer={(
            <div className="flex w-full items-center justify-between gap-3">
              {dialog.id ? <button type="button" onClick={deleteCandidate} className={dangerButton}>{t('common.delete')}</button> : <span />}
              <div className="flex gap-3">
                <button type="button" onClick={() => setDialog(null)} className={secondaryButton}>{t('common.cancel')}</button>
                <button type="submit" form="candidate-form" className={primaryButton}>{dialog.id ? t('common.save') : t('common.add')}</button>
              </div>
            </div>
          )}
        >
          <form id="candidate-form" onSubmit={saveCandidate} className="space-y-4">
            <Field id="cand-name" label={`${t('recruiting.candidateName')} *`}>
              <input id="cand-name" type="text" value={dialog.fullName} onChange={(e) => setDialog({ ...dialog, fullName: e.target.value })} className={inputClass} placeholder={t('recruiting.ph.name')} />
            </Field>
            <Field id="cand-position" label={`${t('employees.col.position')} *`} hint={vacancyTitles.length > 0 ? t('recruiting.vacancyHint') : undefined}>
              <input id="cand-position" type="text" list="cand-vacancies" value={dialog.position} onChange={(e) => setDialog({ ...dialog, position: e.target.value })} className={inputClass} placeholder={t('recruiting.ph.position')} />
              <datalist id="cand-vacancies">
                {vacancyTitles.map(title => <option key={title} value={title} />)}
              </datalist>
            </Field>
            <Field id="cand-experience" label={t('recruiting.experience')}>
              <input id="cand-experience" type="text" value={dialog.experience} onChange={(e) => setDialog({ ...dialog, experience: e.target.value })} className={inputClass} placeholder={t('recruiting.ph.experience')} />
            </Field>
            <Field id="cand-status" label={t('recruiting.stage')}>
              <select id="cand-status" value={dialog.status} onChange={(e) => setDialog({ ...dialog, status: e.target.value as CandidateStatus })} className={inputClass}>
                {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select>
            </Field>
            <Field id="cand-note" label={t('recruiting.note')}>
              <textarea id="cand-note" value={dialog.note} onChange={(e) => setDialog({ ...dialog, note: e.target.value })} className={`${inputClass} resize-none h-20`} />
            </Field>
            {formError && <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">{formError}</p>}
          </form>
        </Modal>
      )}

      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-primary">{t('recruiting.title')}</h2>
          <p className="text-muted mt-1">{t('recruiting.subtitle')}</p>
        </div>
        <button onClick={openNew} className={`${primaryButton} flex items-center gap-2`}>
          <Plus className="w-4 h-4" />
          {t('recruiting.addCandidate')}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-surface border border-line rounded-2xl p-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-500/10 text-blue-700 dark:text-blue-300 rounded-xl flex items-center justify-center">
              <Briefcase className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm text-muted">{t('recruiting.stats.openJobs')}</p>
              <p className="text-2xl font-bold text-primary tabular-nums" data-testid="recruiting-vacancies">{vacantUnits}</p>
            </div>
          </div>
          <p className="text-xs text-muted mt-3">
            {vacancies.length > 0
              ? vacancies.slice(0, 3).map(v => `${v.title} (${v.department}) — ${v.vacant}`).join('; ') + (vacancies.length > 3 ? '…' : '')
              : t('recruiting.noVacancies')}
          </p>
        </div>
        <div className="bg-surface border border-line rounded-2xl p-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 rounded-xl flex items-center justify-center">
              <UserCheck className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm text-muted">{t('recruiting.stats.newApplicants')}</p>
              <p className="text-2xl font-bold text-primary tabular-nums">{stats.newApplicants}</p>
            </div>
          </div>
          <p className="text-xs text-muted mt-3">{t('recruiting.inProgress', { count: stats.inProgress })}</p>
        </div>
        <div className="bg-surface border border-line rounded-2xl p-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-amber-500/10 text-amber-700 dark:text-amber-300 rounded-xl flex items-center justify-center">
              <Calendar className="w-6 h-6" />
            </div>
            <div>
              <p className="text-sm text-muted">{t('recruiting.stats.interviews')}</p>
              <p className="text-2xl font-bold text-primary tabular-nums">{stats.interviews}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-4 mb-6">
        <div className="relative flex-1">
          <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            placeholder={t('recruiting.searchCandidates')}
            aria-label={t('recruiting.searchCandidates')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-surface border border-line rounded-xl pl-10 pr-4 py-2.5 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
        </div>
        <div className="relative">
          <button
            onClick={() => setIsFilterOpen(!isFilterOpen)}
            aria-expanded={isFilterOpen}
            className={`relative bg-surface border ${isFilterOpen ? 'border-accent-500' : 'border-line'} hover:bg-surface-hover px-4 py-2 rounded-xl flex items-center gap-2 text-sm font-medium text-secondary transition-colors`}
          >
            <Filter className="w-4 h-4" />
            {t('recruiting.filters')}
            {positionFilter && <span className="w-2 h-2 rounded-full bg-accent-500 absolute top-0 right-0 -mt-1 -mr-1" />}
          </button>

          {isFilterOpen && (
            <div className="absolute right-0 top-full mt-2 w-64 bg-surface border border-line rounded-xl shadow-xl z-10 p-4">
              <div className="mb-4">
                <label htmlFor="cand-filter-position" className="block text-sm font-medium text-secondary mb-2">{t('employees.col.position')}</label>
                <select
                  id="cand-filter-position"
                  value={positionFilter}
                  onChange={(e) => setPositionFilter(e.target.value)}
                  className="w-full bg-app border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-primary"
                >
                  <option value="">{t('recruiting.allPositions')}</option>
                  {uniquePositions.map(pos => (
                    <option key={pos} value={pos}>{pos}</option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => { setPositionFilter(''); setIsFilterOpen(false); }}
                  className="text-xs text-secondary hover:text-primary transition-colors"
                >
                  {t('common.reset')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <DragDropContext onDragEnd={onDragEnd}>
        <div className="flex gap-6 overflow-x-auto pb-4">
          {STATUSES.map(status => {
            const columnCandidates = filteredCandidates.filter(c => c.status === status);
            return (
              <div key={status} className="flex-1 min-w-[260px] bg-surface-2 border border-line rounded-2xl p-4 flex flex-col h-[600px]">
                <div className="flex justify-between items-center mb-4 px-2">
                  <h3 className="font-semibold text-primary">{statusLabel(status)}</h3>
                  <span className="bg-surface-3 text-secondary text-xs px-2 py-1 rounded-full tabular-nums">
                    {columnCandidates.length}
                  </span>
                </div>

                <Droppable droppableId={status}>
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`flex-1 overflow-y-auto space-y-3 pr-2 transition-colors rounded-xl ${snapshot.isDraggingOver ? 'bg-surface-3' : ''}`}
                    >
                      {columnCandidates.map((candidate, index) => (
                        <Draggable key={candidate.id} draggableId={candidate.id} index={index}>
                          {(dragProvided, dragSnapshot) => (
                            <div
                              ref={dragProvided.innerRef}
                              {...dragProvided.draggableProps}
                              {...dragProvided.dragHandleProps}
                              className={`bg-surface border border-line rounded-xl p-4 cursor-grab hover:border-accent-500/50 transition-colors ${dragSnapshot.isDragging ? 'shadow-xl ring-2 ring-accent-500 rotate-2' : ''}`}
                            >
                              <div className="flex justify-between items-start mb-2 gap-2">
                                <h4 className="font-medium text-primary">{candidate.fullName}</h4>
                                <button
                                  type="button"
                                  onClick={() => openEdit(candidate)}
                                  aria-label={`${t('common.edit')}: ${candidate.fullName}`}
                                  className="p-1 text-muted hover:text-primary rounded"
                                >
                                  <Pencil className="w-4 h-4" />
                                </button>
                              </div>
                              <p className="text-sm text-accent-700 dark:text-accent-300 mb-3">{candidate.position}</p>
                              <div className="flex items-center justify-between gap-2 text-xs text-muted">
                                <span className="flex items-center gap-2">
                                  <Briefcase className="w-3 h-3" />
                                  {candidate.experience ? `${t('recruiting.experienceLabel')} ${candidate.experience}` : t('recruiting.noExperience')}
                                </span>
                                {candidate.createdAt && <span>{dates.date(candidate.createdAt)}</span>}
                              </div>
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}

                      {columnCandidates.length === 0 && !snapshot.isDraggingOver && (
                        <div className="text-center p-6 border-2 border-dashed border-line rounded-xl text-muted text-sm">
                          {t('recruiting.dropHere')}
                        </div>
                      )}
                    </div>
                  )}
                </Droppable>
              </div>
            );
          })}
        </div>
      </DragDropContext>
      <p className="text-xs text-muted">{t('recruiting.dragHint')}</p>
    </div>
  );
}
