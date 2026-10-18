import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Download, Printer } from 'lucide-react';
import { useDatabaseStore } from '../store/useDatabaseStore';
import { useAppStore } from '../store/useAppStore';
import { generateDocx } from '../lib/docx';
import { localDateISO, useDates } from '../lib/dates';
import { documentParagraphs, safeFileName, templateVariables } from '../lib/templateBlocks';
import { useNotify } from '../components/Toasts';
import { PrintPortal, TemplateDocument, useTemplateValues } from '../components/TemplateDocument';

export default function DocumentGenerator() {
  const { t } = useTranslation();
  const { templates, employees } = useDatabaseStore();
  const docxTemplatePath = useAppStore((s) => s.docxTemplatePath);
  const dates = useDates();
  const notify = useNotify();
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});

  const template = templates.find(item => item.id === selectedTemplate);
  const employee = employees.find(e => e.id === selectedEmployee);
  const { values, auto } = useTemplateValues(employee, variables);
  const sortedEmployees = useMemo(
    () => employees.slice().sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru')),
    [employees],
  );

  // Переменные шаблона — из текста и из ячеек таблиц, в каноническом виде:
  // {{ФИО}} и {{fullName}} — одно поле.
  const templateVars = template ? templateVariables(template, t) : [];
  const fileName = template
    ? `${safeFileName(employee ? `${template.name} — ${employee.fullName}` : template.name)}.docx`
    : '';

  const handleDownloadDocx = async () => {
    if (!template) return;
    try {
      await generateDocx(docxTemplatePath, {
        orgName: values.orgName ?? '',
        title: template.name,
        date: dates.date(localDateISO()),
        paragraphs: documentParagraphs(template, values, t),
      }, fileName);
      notify.success(t('docgen.docxSaved', { file: fileName }));
    } catch {
      // generateDocx уже пишет причину в консоль; пользователю нужен факт.
      notify.error(t('docgen.docxFailed'));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap justify-between items-center gap-3 no-print">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-primary">{t('docgen.title')}</h2>
          <p className="text-muted mt-1">{t('docgen.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleDownloadDocx}
            disabled={!template}
            className="bg-surface-3 border border-line hover:bg-surface-hover disabled:opacity-50 text-secondary px-4 py-2 rounded-xl flex items-center gap-2 text-sm font-medium transition-colors"
          >
            <Download className="w-4 h-4" />
            {t('docgen.downloadDocx')}
          </button>
          <button
            onClick={() => window.print()}
            disabled={!template}
            className="bg-accent-600 hover:bg-accent-700 disabled:opacity-50 text-white px-4 py-2 rounded-xl flex items-center gap-2 text-sm font-medium transition-colors"
          >
            <Printer className="w-4 h-4" />
            {t('docgen.printPdf')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6 no-print">
          <div className="bg-surface border border-line rounded-2xl p-6">
            <h3 className="font-medium text-primary mb-4">{t('docgen.docSettings')}</h3>

            <div className="space-y-4">
              <div>
                <label htmlFor="docgen-template" className="block text-sm font-medium text-muted mb-1">{t('docgen.template')}</label>
                <select
                  id="docgen-template"
                  className="w-full bg-app border border-line rounded-xl px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent-500"
                  value={selectedTemplate}
                  onChange={e => setSelectedTemplate(e.target.value)}
                >
                  <option value="">{t('docgen.chooseTemplate')}</option>
                  {templates.map(item => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="docgen-employee" className="block text-sm font-medium text-muted mb-1">{t('docgen.employeeOptional')}</label>
                <select
                  id="docgen-employee"
                  className="w-full bg-app border border-line rounded-xl px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent-500"
                  value={selectedEmployee}
                  onChange={e => setSelectedEmployee(e.target.value)}
                >
                  <option value="">{t('docgen.noEmployee')}</option>
                  {sortedEmployees.map(e => (
                    <option key={e.id} value={e.id}>
                      {e.fullName} — {e.position}{e.status === 'dismissed' ? ` (${t('employees.status.dismissed')})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {template && (
            <div className="bg-surface border border-line rounded-2xl p-6">
              <h3 className="font-medium text-primary mb-1">{t('templates.variables')}</h3>
              <p className="text-xs text-muted mb-4">{t('docgen.fillFields')}</p>

              <div className="space-y-3">
                {templateVars.map((name, index) => (
                  <div key={name}>
                    <label htmlFor={`docgen-var-${index}`} className="block text-xs font-medium text-muted mb-1">
                      {t(`docgen.vars.${name}`, { defaultValue: name })}
                    </label>
                    <input
                      id={`docgen-var-${index}`}
                      type="text"
                      className="w-full bg-app border border-line rounded-xl px-3 py-2 text-sm text-primary focus:outline-none focus:border-accent-500"
                      value={variables[name] ?? ''}
                      onChange={e => setVariables({ ...variables, [name]: e.target.value })}
                      // Подсказка — значение, которое подставится само; если
                      // его нет — просьба ввести.
                      placeholder={auto[name] || t('docgen.enterValue')}
                    />
                  </div>
                ))}
                {templateVars.length === 0 && <p className="text-sm text-muted">{t('docgen.noVariables')}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-2">
          {template ? (
            <>
              <TemplateDocument template={template} values={values} className="p-12 min-h-[842px] shadow-lg rounded-sm no-print" />
              <PrintPortal>
                <TemplateDocument template={template} values={values} className="p-0" />
              </PrintPortal>
            </>
          ) : (
            <div className="bg-surface-2 border-2 border-dashed border-line rounded-2xl p-12 flex flex-col items-center justify-center text-center h-[500px] no-print">
              <div className="w-16 h-16 bg-surface-3 rounded-2xl flex items-center justify-center mb-4 text-muted">
                <FileText className="w-8 h-8" />
              </div>
              <h3 className="text-lg font-medium text-secondary">{t('employees.doc.selectTemplate')}</h3>
              <p className="text-muted text-sm mt-2 max-w-sm">
                {t('docgen.emptyDesc')}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
