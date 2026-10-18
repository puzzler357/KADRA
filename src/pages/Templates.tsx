import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, FileText, Search, Trash2, FileSignature } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useDatabaseStore } from '../store/useDatabaseStore';
import { clickable } from '../lib/a11y';
import { useNotify } from '../components/Toasts';

export default function Templates() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { templates, deleteTemplate } = useDatabaseStore();
  const notify = useNotify();
  const [searchTerm, setSearchTerm] = useState('');

  const filteredTemplates = templates.filter(template => 
    template.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight text-primary">{t('nav.templates')}</h2>
        <button 
          onClick={() => navigate('/templates/new')}
          className="flex items-center gap-2 bg-accent-600 hover:bg-accent-700 text-white px-4 py-2 rounded-xl font-medium transition-colors shadow-sm"
        >
          <Plus className="w-4 h-4" />
          {t('templates.create')}
        </button>
      </div>

      <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm overflow-hidden flex flex-col">
        <div className="p-4 border-b border-[var(--border-color)] flex items-center gap-4 bg-surface-2 dark:bg-slate-900/50">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
            <input 
              type="text" 
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder={t('common.search')}
              aria-label={t('common.search')}
              className="w-full pl-9 pr-4 py-2 bg-surface border border-[var(--border-color)] rounded-xl text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-500 transition-shadow"
            />
          </div>
        </div>
        
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredTemplates.map(template => (
            <div key={template.id} className="border border-[var(--border-color)] rounded-2xl p-5 hover:border-accent-500 transition-colors group bg-surface flex flex-col cursor-pointer" {...clickable(() => navigate(`/templates/new?id=${template.id}`), template.name)}>
              <div className="flex justify-between items-start mb-4">
                <div className="w-10 h-10 rounded-xl bg-accent-500/10 text-accent-700 dark:text-accent-300 flex items-center justify-center">
                  <FileText className="w-5 h-5" />
                </div>
                {/* Кнопка удаления видна всегда и подписана: раньше это было
                    безымянное «⋯», появлявшееся только при наведении. */}
                <button
                  type="button"
                  aria-label={`${t('common.delete')}: ${template.name}`}
                  title={t('common.delete')}
                  className="p-1.5 rounded-lg text-muted hover:text-rose-700 dark:hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!(await notify.confirm(t('templates.deleteConfirm', { name: template.name }), { danger: true }))) return;
                    try {
                      await deleteTemplate(template.id);
                      notify.success(t('templates.deleted'));
                    } catch (err) {
                      notify.error(err instanceof Error ? err.message : String(err));
                    }
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <h3 className="font-semibold text-lg text-primary group-hover:text-accent-700 dark:group-hover:text-accent-300 transition-colors mb-2">{template.name}</h3>
              <p className="text-sm text-muted flex-1">
                {t('templates.customTemplate', { count: template.blocks.length })}
              </p>
              <div className="mt-4 pt-4 border-t border-[var(--border-color)] flex justify-between items-center text-xs text-muted">
                <span>{t('templates.savedLocally')}</span>
                <span className="flex items-center gap-1"><FileSignature className="w-3 h-3" /> {t('templates.variables')}</span>
              </div>
            </div>
          ))}
          {filteredTemplates.length === 0 && (
            <div className="col-span-full py-12 text-center text-muted">
              {t('templates.notFound')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
