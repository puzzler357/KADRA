import { useRef, useState } from 'react';
import type { FocusEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Save, Plus, Type, Table as TableIcon, FileSignature, LayoutTemplate, Printer, Trash2, GripVertical, ChevronUp, ChevronDown, X, AlertTriangle } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import type { DropResult } from '@hello-pangea/dnd';
import { useDatabaseStore } from '../store/useDatabaseStore';
import { useNotify } from '../components/Toasts';
import { BUILTIN_VARIABLES } from '../lib/templateVars';
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, defaultTable, parseTable, serializeTable } from '../lib/templateBlocks';
import type { BlockType, TableBlockData, TemplateBlock } from '../lib/templateBlocks';
import { templateError } from '../lib/validation';
import { PrintPortal, TemplateDocument, useTemplateValues } from '../components/TemplateDocument';

interface Draft { name: string; blocks: TemplateBlock[] }

/**
 * Несохранённые правки шаблонов. Живут, пока открыто окно: ушли в другой
 * раздел и вернулись — правки на месте и видно, что они не сохранены.
 * Раньше они пропадали молча.
 */
const drafts = new Map<string, Draft>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (drafts.size > 0) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

/** Поле, в которое вставляется переменная по щелчку в списке справа. */
interface FocusedField {
  blockId: string;
  kind: 'text' | 'column' | 'cell';
  row: number;
  col: number;
  el: HTMLInputElement | HTMLTextAreaElement;
}

const fieldClass = 'w-full bg-transparent border border-[var(--border-color)] rounded-lg px-2 py-1.5 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-500';

export default function TemplateBuilder() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const templateId = searchParams.get('id');
  const draftKey = templateId ?? 'new';

  const { templates, addTemplate, updateTemplate } = useDatabaseStore();
  const notify = useNotify();
  // Для печати из конструктора: организация и дата подставляются, данные
  // сотрудника остаются видимыми {{маркерами}}.
  const { values: previewValues } = useTemplateValues(null);

  // Текст нового шаблона переведён и ссылается на {{orgName}}: название
  // организации подставляется при генерации из «Настройки → Общие».
  const freshTemplate = (): Draft => ({
    name: t('builder.newTemplate'),
    blocks: [{
      id: '1',
      type: 'text',
      content: t('builder.defaultText', { fullName: '{{fullName}}', orgName: '{{orgName}}', position: '{{position}}' }),
    }],
  });

  const [state, setState] = useState<Draft>(() => drafts.get(draftKey) ?? (templateId ? { name: '', blocks: [] } : freshTemplate()));
  const [loadedKey, setLoadedKey] = useState<string | null>(() => (drafts.has(draftKey) || !templateId ? draftKey : null));
  const [dirty, setDirty] = useState(() => drafts.has(draftKey));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const focused = useRef<FocusedField | null>(null);

  // Подгрузка шаблона при рендере, а не в эффекте: так React сразу рисует
  // нужное состояние. loadedKey не даёт затереть правки при обновлении списка.
  if (loadedKey !== draftKey) {
    const draft = drafts.get(draftKey);
    const template = templateId ? templates.find(item => item.id === templateId) : undefined;
    if (draft) {
      setState(draft);
      setDirty(true);
      setLoadedKey(draftKey);
    } else if (!templateId) {
      setState(freshTemplate());
      setDirty(false);
      setLoadedKey(draftKey);
    } else if (template) {
      setState({ name: template.name, blocks: template.blocks });
      setDirty(false);
      setLoadedKey(draftKey);
    }
  }
  const loaded = loadedKey === draftKey;

  const commit = (next: Draft) => {
    setState(next);
    setDirty(true);
    setError(null);
    drafts.set(draftKey, next);
  };
  const setBlocks = (blocks: TemplateBlock[]) => commit({ ...state, blocks });
  const setContent = (id: string, content: string) => setBlocks(state.blocks.map(b => (b.id === id ? { ...b, content } : b)));

  const addBlock = (type: BlockType) => {
    // Идентификатор выводится из уже существующих: случайное число здесь
    // ничего не давало, кроме нечистого вызова в теле компонента.
    const nextId = String(state.blocks.reduce((max, b) => Math.max(max, Number(b.id) || 0), 0) + 1);
    const content = type === 'table' ? serializeTable(defaultTable(t)) : '';
    setBlocks([...state.blocks, { id: nextId, type, content }]);
  };

  const moveBlock = (from: number, to: number) => {
    if (to < 0 || to >= state.blocks.length || from === to) return;
    const next = state.blocks.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setBlocks(next);
  };

  const onDragEnd = (result: DropResult) => {
    if (result.destination) moveBlock(result.source.index, result.destination.index);
  };

  const removeBlock = (id: string) => setBlocks(state.blocks.filter(b => b.id !== id));

  const updateTable = (block: TemplateBlock, change: (table: TableBlockData) => TableBlockData) =>
    setContent(block.id, serializeTable(change(parseTable(block.content, t))));

  /** Вставка переменной в позицию курсора последнего поля; иначе — в буфер. */
  const insertVariable = (variable: string) => {
    const field = focused.current;
    const block = field && field.el.isConnected ? state.blocks.find(b => b.id === field.blockId) : undefined;
    if (!field || !block) {
      navigator.clipboard?.writeText(variable)
        .then(() => notify.success(t('builder.copied', { v: variable })))
        .catch(() => notify.info(t('builder.insertHint')));
      return;
    }
    const { el } = field;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const insert = (value: string) => value.slice(0, start) + variable + value.slice(end);
    if (field.kind === 'text') {
      setContent(block.id, insert(block.content || ''));
    } else {
      updateTable(block, (table) => field.kind === 'column'
        ? { ...table, columns: table.columns.map((c, i) => (i === field.col ? insert(c) : c)) }
        : { ...table, rows: table.rows.map((r, ri) => (ri === field.row ? r.map((c, ci) => (ci === field.col ? insert(c) : c)) : r)) });
    }
    const caret = start + variable.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const rememberFocus = (blockId: string, kind: FocusedField['kind'], row = 0, col = 0) =>
    (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      focused.current = { blockId, kind, row, col, el: event.currentTarget };
    };

  const handleSave = async () => {
    const draft = { name: state.name.trim(), blocks: state.blocks };
    const problem = templateError(draft);
    if (problem) { setError(t(`errors.${problem}`)); return; }
    if (draft.blocks.length === 0) { setError(t('builder.noBlocks')); return; }
    setSaving(true);
    try {
      if (templateId) await updateTemplate(templateId, draft);
      else await addTemplate(draft);
      drafts.delete(draftKey);
      setDirty(false);
      notify.success(t('builder.saved'));
      navigate('/templates');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const goBack = async () => {
    if (dirty && !(await notify.confirm(t('builder.discardConfirm')))) return;
    drafts.delete(draftKey);
    navigate('/templates');
  };

  const discard = async () => {
    if (!(await notify.confirm(t('builder.discardConfirm')))) return;
    drafts.delete(draftKey);
    setLoadedKey(null);
  };

  if (!loaded) {
    return (
      <div className="space-y-4">
        <button onClick={() => navigate('/templates')} className="flex items-center gap-2 text-sm text-secondary hover:text-primary">
          <ArrowLeft className="w-4 h-4" /> {t('common.back')}
        </button>
        <p className="text-muted">{t('builder.notFound')}</p>
      </div>
    );
  }

  const blockLabel = (type: string) => (type === 'table' ? t('builder.table') : type === 'signature' ? t('builder.signatures') : t('builder.text'));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4 flex-1 min-w-[16rem]">
          <button
            onClick={goBack}
            aria-label={t('common.back')}
            className="p-2 rounded-xl hover:bg-surface-hover text-muted transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <label htmlFor="tpl-name" className="sr-only">{t('builder.templateName')}</label>
            <input
              id="tpl-name"
              value={state.name}
              onChange={(e) => commit({ ...state, name: e.target.value })}
              placeholder={t('builder.templateName')}
              className="w-full text-2xl font-semibold tracking-tight text-primary bg-transparent border border-transparent hover:border-[var(--border-color)] focus:outline-none focus:ring-2 focus:ring-accent-500 rounded-lg px-2 py-1 -ml-2"
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => window.print()} className="flex items-center gap-2 bg-surface border border-[var(--border-color)] hover:bg-surface-hover text-secondary px-4 py-2 rounded-xl font-medium transition-colors shadow-sm">
            <Printer className="w-4 h-4" />
            {t('employees.doc.print')}
          </button>
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 bg-accent-600 hover:bg-accent-700 disabled:opacity-50 text-white px-4 py-2 rounded-xl font-medium transition-colors shadow-sm">
            <Save className="w-4 h-4" />
            {t('common.save')}
          </button>
        </div>
      </div>

      {dirty && (
        <div className="flex flex-wrap items-center justify-between gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-2 text-sm">
          <span className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="w-4 h-4" /> {t('builder.unsaved')}
          </span>
          <button onClick={discard} className="text-secondary hover:text-primary hover:underline">{t('builder.discard')}</button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">{error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3 space-y-4">
          <div className="bg-surface border border-[var(--border-color)] rounded-2xl p-6 min-h-[600px] shadow-sm flex flex-col gap-4">
            <DragDropContext onDragEnd={onDragEnd}>
              <Droppable droppableId="template-blocks">
                {(dropProvided) => (
                  <div ref={dropProvided.innerRef} {...dropProvided.droppableProps} className="flex flex-col gap-4">
                    {state.blocks.map((block, index) => (
                      <Draggable key={block.id} draggableId={block.id} index={index}>
                        {(dragProvided, snapshot) => (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            className={`relative border rounded-xl p-4 pl-12 bg-surface transition-colors ${snapshot.isDragging ? 'border-accent-500 shadow-lg' : 'border-[var(--border-color)]'}`}
                            data-testid={`block-${index}`}
                          >
                            <div className="absolute left-2 top-3 flex flex-col items-center gap-1">
                              <span {...dragProvided.dragHandleProps} aria-label={t('builder.dragBlock', { n: index + 1 })} className="p-1 text-muted hover:text-primary cursor-grab rounded">
                                <GripVertical className="w-4 h-4" />
                              </span>
                              <button type="button" onClick={() => moveBlock(index, index - 1)} disabled={index === 0} aria-label={t('builder.moveUp', { n: index + 1 })} className="p-1 text-muted hover:text-primary disabled:opacity-30 rounded">
                                <ChevronUp className="w-4 h-4" />
                              </button>
                              <button type="button" onClick={() => moveBlock(index, index + 1)} disabled={index === state.blocks.length - 1} aria-label={t('builder.moveDown', { n: index + 1 })} className="p-1 text-muted hover:text-primary disabled:opacity-30 rounded">
                                <ChevronDown className="w-4 h-4" />
                              </button>
                            </div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-medium uppercase tracking-wider text-muted">{index + 1}. {blockLabel(block.type)}</span>
                              <button type="button" onClick={() => removeBlock(block.id)} aria-label={t('builder.removeBlock', { n: index + 1 })} className="p-1.5 text-rose-700 dark:text-rose-400 rounded-lg hover:bg-rose-500/10">
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>

                            {block.type === 'text' && (
                              <textarea
                                value={block.content || ''}
                                onChange={(e) => setContent(block.id, e.target.value)}
                                onFocus={rememberFocus(block.id, 'text')}
                                aria-label={t('builder.blockText', { n: index + 1 })}
                                className="w-full bg-transparent border border-transparent hover:border-[var(--border-color)] rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-accent-500 resize-y min-h-[100px] text-primary"
                                placeholder={t('builder.textPlaceholder')}
                              />
                            )}

                            {block.type === 'table' && (() => {
                              const table = parseTable(block.content, t);
                              return (
                                <div>
                                  <div className="overflow-x-auto">
                                    <table className="w-full border-collapse">
                                      <thead>
                                        <tr>
                                          {table.columns.map((col, c) => (
                                            <th key={c} className="p-1 align-top">
                                              <div className="flex items-center gap-1">
                                                <input
                                                  value={col}
                                                  onChange={(e) => updateTable(block, tb => ({ ...tb, columns: tb.columns.map((v, i) => (i === c ? e.target.value : v)) }))}
                                                  onFocus={rememberFocus(block.id, 'column', 0, c)}
                                                  aria-label={t('builder.columnName', { n: c + 1 })}
                                                  className={`${fieldClass} font-semibold bg-surface-2`}
                                                />
                                                {table.columns.length > 1 && (
                                                  <button
                                                    type="button"
                                                    onClick={() => updateTable(block, tb => ({ columns: tb.columns.filter((_, i) => i !== c), rows: tb.rows.map(r => r.filter((_, i) => i !== c)) }))}
                                                    aria-label={t('builder.removeColumn', { n: c + 1 })}
                                                    className="p-1 text-muted hover:text-rose-600 rounded"
                                                  >
                                                    <X className="w-3.5 h-3.5" />
                                                  </button>
                                                )}
                                              </div>
                                            </th>
                                          ))}
                                          <th className="w-8" />
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {table.rows.map((row, r) => (
                                          <tr key={r}>
                                            {row.map((cell, c) => (
                                              <td key={c} className="p-1">
                                                <input
                                                  value={cell}
                                                  onChange={(e) => updateTable(block, tb => ({ ...tb, rows: tb.rows.map((rr, ri) => (ri === r ? rr.map((v, ci) => (ci === c ? e.target.value : v)) : rr)) }))}
                                                  onFocus={rememberFocus(block.id, 'cell', r, c)}
                                                  aria-label={t('builder.cell', { row: r + 1, col: c + 1 })}
                                                  className={fieldClass}
                                                />
                                              </td>
                                            ))}
                                            <td className="p-1 text-center">
                                              <button
                                                type="button"
                                                onClick={() => updateTable(block, tb => ({ ...tb, rows: tb.rows.filter((_, i) => i !== r) }))}
                                                aria-label={t('builder.removeRow', { n: r + 1 })}
                                                className="p-1 text-muted hover:text-rose-600 rounded"
                                              >
                                                <Trash2 className="w-3.5 h-3.5" />
                                              </button>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                  <div className="flex flex-wrap gap-4 mt-2 text-sm">
                                    <button
                                      type="button"
                                      disabled={table.rows.length >= MAX_TABLE_ROWS}
                                      onClick={() => updateTable(block, tb => ({ ...tb, rows: [...tb.rows, tb.columns.map(() => '')] }))}
                                      className="flex items-center gap-1 text-accent-700 dark:text-accent-300 hover:underline disabled:opacity-40"
                                    >
                                      <Plus className="w-4 h-4" /> {t('builder.addRow')}
                                    </button>
                                    <button
                                      type="button"
                                      disabled={table.columns.length >= MAX_TABLE_COLUMNS}
                                      onClick={() => updateTable(block, tb => ({ columns: [...tb.columns, t('builder.newColumn')], rows: tb.rows.map(r => [...r, '']) }))}
                                      className="flex items-center gap-1 text-accent-700 dark:text-accent-300 hover:underline disabled:opacity-40"
                                    >
                                      <Plus className="w-4 h-4" /> {t('builder.addColumn')}
                                    </button>
                                  </div>
                                </div>
                              );
                            })()}

                            {block.type === 'signature' && (
                              <div className="border border-dashed border-[var(--border-color)] rounded-xl p-6 flex justify-between items-end text-muted mt-2">
                                <div className="border-t border-strong w-1/3 pt-2 text-center text-sm">{t('builder.employeeSignature')}</div>
                                <div className="border-t border-strong w-1/3 pt-2 text-center text-sm">{t('builder.headSignature')}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {dropProvided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>

            {state.blocks.length === 0 && <p className="text-sm text-muted text-center py-6">{t('builder.noBlocks')}</p>}

            <button
              type="button"
              onClick={() => addBlock('text')}
              className="border-2 border-dashed border-[var(--border-color)] rounded-xl p-6 flex flex-col items-center justify-center text-muted hover:bg-surface-hover hover:border-accent-500 transition-colors"
            >
              <Plus className="w-6 h-6 mb-2 text-accent-700 dark:text-accent-300" />
              <span className="font-medium">{t('builder.addBlock')}</span>
            </button>
          </div>
        </div>

        <div className="lg:col-span-1 space-y-6">
          <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl p-5 shadow-sm">
            <h3 className="font-semibold mb-4 flex items-center gap-2 text-primary">
              <LayoutTemplate className="w-4 h-4 text-accent-700 dark:text-accent-300" />
              {t('builder.blocks')}
            </h3>
            <div className="space-y-2">
              {([['text', Type, t('builder.text')], ['table', TableIcon, t('builder.table')], ['signature', FileSignature, t('builder.signatures')]] as const).map(([type, Icon, label]) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => addBlock(type)}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border border-[var(--border-color)] hover:border-accent-500 hover:text-accent-700 dark:hover:text-accent-300 text-secondary transition-colors text-left text-sm font-medium"
                >
                  <Icon className="w-4 h-4" /> {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted mt-3">{t('builder.reorderHint')}</p>
          </div>

          <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl p-5 shadow-sm">
            <h3 className="font-semibold mb-1 text-sm text-muted uppercase tracking-wider">{t('templates.variables')}</h3>
            <p className="text-xs text-muted mb-3">{t('builder.insertHint')}</p>
            <div className="space-y-1">
              {BUILTIN_VARIABLES.map(name => {
                const variable = `{{${name}}}`;
                return (
                  <button
                    key={name}
                    type="button"
                    // Фокус остаётся в поле: иначе неизвестно, куда вставлять.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertVariable(variable)}
                    title={t(`docgen.vars.${name}`)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-surface-2 rounded-lg text-sm cursor-pointer hover:bg-surface-hover transition-colors border border-[var(--border-color)]"
                  >
                    <span className="font-mono text-accent-700 dark:text-accent-300">{variable}</span>
                    <span className="text-xs text-muted truncate">{t(`docgen.vars.${name}`)}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted mt-3">{t('builder.customVarsHint', { example: `{{${t('builder.customVarExample')}}}` })}</p>
          </div>
        </div>
      </div>

      <PrintPortal>
        <TemplateDocument template={{ id: draftKey, name: state.name, blocks: state.blocks }} values={previewValues} />
      </PrintPortal>
    </div>
  );
}
