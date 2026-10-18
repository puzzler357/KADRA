import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, AlertTriangle, Check } from 'lucide-react';
import { useDatabaseStore } from '../store/useDatabaseStore';
import {
  EXCHANGE_ACCEPT, EXCHANGE_FIELDS, REQUIRED_FIELDS, displayLine, guessField, prepareRow, readExchangeFile,
} from '../lib/employeeExchange';
import type { ExchangeField, ImportRow } from '../lib/employeeExchange';
import { normalizeName } from '../lib/validation';
import { useDates } from '../lib/dates';

interface CheckedRow extends ImportRow {
  /** Такой сотрудник уже есть в базе или выше в этом же файле. */
  duplicate: boolean;
}

/**
 * Мастер импорта сотрудников.
 *
 * Файл разбирается, колонки сопоставляются с полями карточки, строки
 * проверяются теми же правилами, что и сама карточка, дубли находятся по
 * табельному номеру или по ФИО с датой приёма. В базу уходят только
 * корректные строки — одной транзакцией.
 */
export default function ImportWizard() {
  const { t } = useTranslation();
  const dates = useDates();
  const { importEmployees, employees } = useDatabaseStore();

  const [step, setStep] = useState(1);
  const [fileName, setFileName] = useState('');
  const [lineOf, setLineOf] = useState<(index: number) => number>(() => (i: number) => i + 1);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, ExchangeField | ''>>({});
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [importedCount, setImportedCount] = useState<number | null>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError('');
    try {
      const rows = await readExchangeFile(file);
      if (rows.length === 0) {
        setError(t('settings.io.noRows'));
        return;
      }
      // Заголовки собираем по всем строкам: в разреженных файлах первая
      // строка может не содержать всех колонок.
      const found = Array.from(new Set(rows.flatMap(row => Object.keys(row))));
      setFileName(file.name);
      setLineOf(() => (i: number) => displayLine(file, i));
      setRawRows(rows);
      setHeaders(found);
      setMapping(Object.fromEntries(found.map(h => [h, guessField(h)])));
      setStep(2);
    } catch {
      setError(t('settings.io.parseError'));
    }
  };

  const mappedFields = new Set(Object.values(mapping).filter(Boolean));
  const missingRequired = REQUIRED_FIELDS.filter(f => !mappedFields.has(f));
  const duplicatedTargets = EXCHANGE_FIELDS.filter(f => Object.values(mapping).filter(v => v === f).length > 1);

  const checked = useMemo<CheckedRow[]>(() => {
    if (step < 3) return [];
    const seen = new Set<string>();
    const keyOf = (r: ImportRow) => (r.employee.tabNumber
      ? `tab:${normalizeName(r.employee.tabNumber)}`
      : `name:${normalizeName(r.employee.fullName)}|${r.employee.hireDate}`);
    for (const e of employees) {
      if (e.tabNumber) seen.add(`tab:${normalizeName(e.tabNumber)}`);
      seen.add(`name:${normalizeName(e.fullName)}|${e.hireDate}`);
    }
    return rawRows.map((raw, index) => {
      const row = prepareRow(raw, lineOf(index), t, mapping);
      const nameKey = `name:${normalizeName(row.employee.fullName)}|${row.employee.hireDate}`;
      const key = keyOf(row);
      const duplicate = seen.has(key) || seen.has(nameKey);
      seen.add(key);
      seen.add(nameKey);
      return { ...row, duplicate };
    });
  }, [step, rawRows, mapping, employees, t, lineOf]);

  const invalidRows = checked.filter(row => row.problems.length > 0);
  const duplicateRows = checked.filter(row => row.problems.length === 0 && row.duplicate);
  const toImport = checked.filter(row => row.problems.length === 0 && !(skipDuplicates && row.duplicate));

  const handleImport = async () => {
    setBusy(true);
    setError('');
    try {
      const count = await importEmployees(toImport.map(row => row.employee));
      setImportedCount(count);
      setStep(4);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('employees.importFailed'));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep(1);
    setRawRows([]);
    setHeaders([]);
    setMapping({});
    setImportedCount(null);
    setError('');
    setFileName('');
  };

  const stepTitles = [t('settings.io.step1'), t('settings.io.step2'), t('settings.io.step3'), t('settings.io.step4')];
  const shownFields = EXCHANGE_FIELDS.filter(f => mappedFields.has(f));
  const shownValue = (row: CheckedRow, field: ExchangeField) => {
    const v = row.employee[field as keyof typeof row.employee];
    if (v === undefined || v === null || v === '') return '—';
    if (field === 'status') return t(`employees.status.${v === 'on_leave' ? 'onLeave' : v}`);
    if (field === 'paymentType') return t(`employees.form.pay.${v}`);
    if (field === 'hireDate' || field === 'dismissalDate' || field === 'birthDate') return dates.date(String(v));
    return String(v);
  };

  return (
    <div className="bg-surface-2 border border-line rounded-2xl p-6 md:p-8">
      <h4 className="font-medium text-lg mb-6">{t('settings.io.wizard')}</h4>

      <ol className="flex gap-6 mb-8 border-b border-line overflow-x-auto">
        {stepTitles.map((title, i) => (
          <li
            key={title}
            aria-current={step === i + 1 ? 'step' : undefined}
            className={`pb-3 text-sm font-medium whitespace-nowrap ${step === i + 1 ? 'border-b-2 border-accent-500 text-accent-700 dark:text-accent-400' : 'text-muted'}`}
          >
            {title}
          </li>
        ))}
      </ol>

      {error && (
        <div role="alert" className="mb-6 bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {step === 1 && (
        <div className="border-2 border-dashed border-line rounded-2xl p-12 flex flex-col items-center justify-center text-center bg-input">
          <div className="w-12 h-12 bg-surface rounded-xl flex items-center justify-center mb-4">
            <Upload className="w-6 h-6 text-muted" />
          </div>
          <p className="text-secondary font-medium mb-2">{t('settings.io.drop')}</p>
          <p className="text-muted text-sm mb-6">{t('settings.io.formats')}</p>
          <label className="bg-accent-600 hover:bg-accent-700 text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer">
            {t('settings.io.choose')}
            <input type="file" accept={EXCHANGE_ACCEPT} onChange={handleFile} className="hidden" data-testid="wizard-file-input" />
          </label>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t('settings.io.mapHint')} <span className="text-secondary">({fileName}, {t('settings.io.rowsTotal', { n: rawRows.length })})</span></p>

          <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar pr-2">
            {headers.map(header => (
              <div key={header} className="flex items-center gap-4">
                <label htmlFor={`map-${header}`} className="flex-1 text-sm text-secondary truncate" title={header}>{header}</label>
                <select
                  id={`map-${header}`}
                  value={mapping[header] ?? ''}
                  onChange={(e) => setMapping({ ...mapping, [header]: e.target.value as ExchangeField | '' })}
                  className="w-56 bg-app border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-primary"
                >
                  <option value="">{t('settings.io.notMapped')}</option>
                  {EXCHANGE_FIELDS.map(field => (
                    <option key={field} value={field}>
                      {t(`exchange.fields.${field}`)}{REQUIRED_FIELDS.includes(field) ? ' *' : ''}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {missingRequired.length > 0 && (
            <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
              {t('settings.io.missingRequired', { fields: missingRequired.map(f => t(`exchange.fields.${f}`)).join(', ') })}
            </p>
          )}
          {duplicatedTargets.length > 0 && (
            <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
              {t('settings.io.duplicatedTargets', { fields: duplicatedTargets.map(f => t(`exchange.fields.${f}`)).join(', ') })}
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button onClick={reset} className="bg-surface-3 hover:bg-surface-hover border border-line px-4 py-2.5 rounded-xl text-sm font-medium transition-colors">
              {t('settings.io.back')}
            </button>
            <button
              onClick={() => setStep(3)}
              disabled={missingRequired.length > 0}
              className="bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-colors"
            >
              {t('settings.io.next')}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <span className="text-emerald-700 dark:text-emerald-400" data-testid="wizard-valid">{t('settings.io.rowsValid', { n: checked.length - invalidRows.length })}</span>
            <span className="text-rose-700 dark:text-rose-400" data-testid="wizard-invalid">{t('settings.io.rowsInvalid', { n: invalidRows.length })}</span>
            <span className="text-amber-700 dark:text-amber-400" data-testid="wizard-duplicates">{t('settings.io.rowsDuplicate', { n: duplicateRows.length })}</span>
          </div>
          <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer w-fit">
            <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} className="rounded" />
            {t('settings.io.skipDuplicates')}
          </label>
          <p className="text-xs text-muted">{t('settings.io.previewHint')}</p>

          <div className="border border-line rounded-xl overflow-auto max-h-80 custom-scrollbar">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-muted uppercase bg-surface-3 sticky top-0">
                <tr>
                  <th className="p-table text-table">{t('settings.io.rowNo')}</th>
                  {shownFields.map(field => (
                    <th key={field} className="p-table text-table">{t(`exchange.fields.${field}`)}</th>
                  ))}
                  <th className="p-table text-table">{t('settings.io.problems')}</th>
                </tr>
              </thead>
              <tbody>
                {checked.slice(0, 200).map(row => (
                  <tr
                    key={row.line}
                    className={`border-b border-line ${row.problems.length > 0 ? 'bg-rose-500/5' : row.duplicate ? 'bg-amber-500/5' : ''}`}
                  >
                    <td className="p-table text-table text-muted tabular-nums">{row.line}</td>
                    {shownFields.map(field => (
                      <td key={field} className="p-table text-table text-secondary">{shownValue(row, field)}</td>
                    ))}
                    <td className="p-table text-table text-xs">
                      {row.problems.length > 0 ? (
                        <span className="inline-flex items-center gap-1.5 text-rose-700 dark:text-rose-400">
                          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                          {row.problems.join('; ')}
                        </span>
                      ) : row.duplicate ? (
                        <span className="text-amber-700 dark:text-amber-400">{t('settings.io.duplicate')}</span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex gap-3 pt-2">
            <button onClick={() => setStep(2)} className="bg-surface-3 hover:bg-surface-hover border border-line px-4 py-2.5 rounded-xl text-sm font-medium transition-colors">
              {t('settings.io.back')}
            </button>
            <button
              onClick={handleImport}
              disabled={busy || toImport.length === 0}
              className="bg-accent-600 hover:bg-accent-700 disabled:opacity-50 text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-colors"
            >
              {t('settings.io.doImportN', { n: toImport.length })}
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="text-center py-10">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 flex items-center justify-center mx-auto mb-4">
            <Check className="w-6 h-6" />
          </div>
          <p className="text-primary font-medium" data-testid="wizard-imported">{t('settings.io.imported', { n: importedCount ?? 0 })}</p>
          <button
            onClick={reset}
            className="mt-6 bg-surface-3 hover:bg-surface-hover border border-line px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
          >
            {t('settings.io.startOver')}
          </button>
        </div>
      )}
    </div>
  );
}
