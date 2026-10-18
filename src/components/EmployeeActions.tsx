import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Edit, Trash, FileText, Printer, X, History } from 'lucide-react';
import { useDatabaseStore, Employee, Template } from '../store/useDatabaseStore';
import EmployeeForm from './EmployeeForm';
import EmployeeHistory from './EmployeeHistory';
import { PrintPortal, TemplateDocument, useTemplateValues } from './TemplateDocument';
import { clickable } from '../lib/a11y';
import { useNotify } from './Toasts';

export default function EmployeeActions({ employee }: { employee: Employee }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [isDocModalOpen, setIsDocModalOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const notify = useNotify();

  const { deleteEmployee, updateEmployee, templates } = useDatabaseStore();

  const toggleDropdown = () => setIsOpen(!isOpen);

  const handleDelete = async () => {
    setIsOpen(false);
    const ok = await notify.confirm(t('employees.actions.deleteConfirm', { name: employee.fullName }), { danger: true });
    if (!ok) return;
    try {
      await deleteEmployee(employee.id);
      notify.success(t('employees.deleted'));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    }
  };

  const openDocModal = () => {
    setIsDocModalOpen(true);
    setIsOpen(false);
  };

  // Ошибка сохранения уходит в форму: она её покажет и не закроется.
  const handleEdit = async (data: Omit<Employee, 'id'>) => {
    await updateEmployee(employee.id, data);
    setIsEditOpen(false);
    notify.success(t('employees.saved'));
  };

  return (
    <div className="relative">
      <button
        onClick={toggleDropdown}
        aria-label={t('employees.actions.menu', { name: employee.fullName })}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className="p-1 rounded hover:bg-surface-hover dark:hover:bg-slate-800 text-muted transition-colors"
      >
        <MoreHorizontal className="w-5 h-5" />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" {...clickable(() => setIsOpen(false), t('common.close'))} />
          <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-slate-900 border border-[var(--border-color)] rounded-xl shadow-lg z-20 py-1 overflow-hidden">
            <button 
              className="w-full text-left px-4 py-2 text-sm text-secondary dark:text-slate-300 hover:bg-surface-hover dark:hover:bg-slate-800 flex items-center gap-2"
              onClick={() => { setIsEditOpen(true); setIsOpen(false); }}
            >
              <Edit className="w-4 h-4" />
              {t('employees.form.editTitle')}
            </button>
            <button
              className="w-full text-left px-4 py-2 text-sm text-secondary dark:text-slate-300 hover:bg-surface-hover dark:hover:bg-slate-800 flex items-center gap-2"
              onClick={openDocModal}
            >
              <FileText className="w-4 h-4" />
              {t('employees.actions.genDoc')}
            </button>
            <button
              className="w-full text-left px-4 py-2 text-sm text-secondary dark:text-slate-300 hover:bg-surface-hover dark:hover:bg-slate-800 flex items-center gap-2"
              onClick={() => { setIsHistoryOpen(true); setIsOpen(false); }}
            >
              <History className="w-4 h-4" />
              {t('movements.history')}
            </button>
            <div className="border-t border-[var(--border-color)] my-1"></div>
            <button
              className="w-full text-left px-4 py-2 text-sm text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 flex items-center gap-2"
              onClick={handleDelete}
            >
              <Trash className="w-4 h-4" />
              {t('common.delete')}
            </button>
          </div>
        </>
      )}

      {isDocModalOpen && (
        <DocModal 
          employee={employee} 
          templates={templates} 
          onClose={() => setIsDocModalOpen(false)} 
        />
      )}

      {isHistoryOpen && (
        <EmployeeHistory employee={employee} onClose={() => setIsHistoryOpen(false)} />
      )}

      {isEditOpen && (
        <EmployeeForm 
          initialData={employee}
          onClose={() => setIsEditOpen(false)}
          onSubmit={handleEdit}
        />
      )}
    </div>
  );
}

function DocModal({ employee, templates, onClose }: { employee: Employee, templates: Template[], onClose: () => void }) {
  const { t } = useTranslation();
  const [selectedTemplateId, setSelectedTemplateId] = useState(templates[0]?.id || '');
  const template = templates.find(item => item.id === selectedTemplateId);
  // Подстановка та же, что в «Генерации документов»: оклад, дата приёма в
  // формате из настроек, организация, таблицы и подписи.
  const { values } = useTemplateValues(employee);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="doc-modal-title">
      <div className="bg-surface border border-[var(--border-color)] rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-4 border-b border-[var(--border-color)]">
          <h3 id="doc-modal-title" className="text-lg font-semibold text-primary">{t('employees.doc.title')}</h3>
          <button onClick={onClose} aria-label={t('common.close')} className="p-1 rounded-lg hover:bg-surface-hover">
            <X className="w-5 h-5 text-muted" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          <label htmlFor="doc-template" className="block text-sm font-medium mb-2 text-secondary">{t('employees.doc.selectTemplate')}</label>
          <select
            id="doc-template"
            value={selectedTemplateId}
            onChange={e => setSelectedTemplateId(e.target.value)}
            className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-500 mb-6"
          >
            {templates.length === 0 && <option value="" disabled>{t('employees.doc.noTemplates')}</option>}
            {templates.map(item => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>

          {template && (
            <div className="border border-[var(--border-color)] rounded-xl overflow-hidden">
              <TemplateDocument template={template} values={values} className="p-8 font-serif" />
            </div>
          )}
        </div>

        <div className="p-4 border-t border-[var(--border-color)] flex justify-end gap-3 bg-surface-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-secondary hover:bg-surface-hover transition-colors border border-transparent">
            {t('common.cancel')}
          </button>
          <button
            disabled={!template}
            onClick={() => window.print()}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 transition-colors disabled:opacity-50"
          >
            <Printer className="w-4 h-4" />
            {t('employees.doc.print')}
          </button>
        </div>
      </div>
      {template && (
        <PrintPortal>
          <TemplateDocument template={template} values={values} className="font-serif" />
        </PrintPortal>
      )}
    </div>
  );
}
