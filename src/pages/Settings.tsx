import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { useDatabaseStore, TABLES } from '../store/useDatabaseStore';
import type { AuditEntry, BackupEntry } from '../store/useDatabaseStore';
import { exportToExcel } from '../lib/excel';
import ImportWizard from '../components/ImportWizard';
import LicenseSettings from '../components/LicenseSettings';
import { formatMoney } from '../lib/money';
import type { CurrencyDecimals, CurrencyPosition, ThousandsSeparator } from '../lib/money';
import * as api from '../data';
import { hasDemoRows, demoIds } from '../data/demo';
import { auditActionLabel, auditEntityLabel, auditEntityOfSetting } from '../lib/audit';
import { useDates, localDateOf, fileStamp } from '../lib/dates';
import type { DateFormat } from '../store/useAppStore';
import PasswordInput from '../components/PasswordInput';
import { Settings as SettingsIcon, ShieldCheck, Key, Shield, Database, Link, Palette, Download, Check, Sun, Moon, Monitor } from 'lucide-react';
import { clickable } from '../lib/a11y';
import { useNotify } from '../components/Toasts';

export default function Settings() {
  const [resetPassword, setResetPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const { t } = useTranslation();
  const { theme, language, setTheme, setLanguage, accentColor, setAccentColor, density, setDensity, fontSize, setFontSize, user } = useAppStore();
  const {
    currencySymbol, currencyPosition, currencyDecimals, thousandsSeparator,
    setCurrencySymbol, setCurrencyPosition, setCurrencyDecimals, setThousandsSeparator,
    docxTemplatePath, setDocxTemplatePath,
    orgName, orgInn, orgDirector, dateFormat, startScreen, annualVacationDays,
    setOrgName, setOrgInn, setOrgDirector, setDateFormat, setStartScreen, setAnnualVacationDays,
    requirePassword, setRequirePassword,
    lockTimeoutMinutes, setLockTimeoutMinutes, lock,
    resetAppearance, resetSettings, resetOrganizationSettings,
  } = useAppStore();
  const dates = useDates();
  const notify = useNotify();
  // Вкладку можно открыть ссылкой: /settings?tab=security (например, с главной).
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(() => searchParams.get('tab') || 'general');

  // Учётной записи может не быть вовсе, а у существующей может не быть
  // пароля. Тогда подтверждать сброс нечем, менять нечего, а тумблер запроса
  // при входе недоступен: включить запрос несуществующего пароля значило бы
  // запереть владельца на экране входа.
  const [hasOwner, setHasOwner] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  useEffect(() => {
    api.authStatus()
      .then(status => { setHasOwner(status.hasOwner); setHasPassword(status.hasPassword); })
      .catch(() => undefined);
  }, []);

  
  const {
    auditLog, backups, createIn, removeFrom, fetchAll, fetchArchiveFacets, archiveFacets,
    employees, departments, positions, templates, candidates, timeOffRequests, checklistTasks, goals, reviews, movements, kbArticles,
  } = useDatabaseStore();

  // Демо-данные первого запуска: есть ли что удалять. Архив в стор целиком
  // не грузится, поэтому для него смотрим список сотрудников архива.
  useEffect(() => { void fetchArchiveFacets(); }, [fetchArchiveFacets]);
  const demoPresent = useMemo(() => {
    const demoEmployees = new Set(demoIds().employees ?? []);
    return hasDemoRows({
      employees, departments, positions, templates, candidates,
      time_off_requests: timeOffRequests, checklist_tasks: checklistTasks, goals, reviews, movements, kb_articles: kbArticles,
    }) || archiveFacets.employees.some((e) => demoEmployees.has(e.id));
  }, [employees, departments, positions, templates, candidates, timeOffRequests, checklistTasks, goals, reviews, movements, kbArticles, archiveFacets]);

  const handleClearDemo = async () => {
    if (!(await notify.confirm(t('settings.demo.confirm'), { danger: true }))) return;
    try {
      await api.clearDemoData();
      await fetchAll();
      await fetchArchiveFacets();
      notify.success(t('settings.demo.cleared'));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : t('settings.security.resetError'));
    }
  };

  // Фильтры журнала. Раньше оба селекта и поле даты были декорацией.
  const [auditAction, setAuditAction] = useState('all');
  const [auditEntity, setAuditEntity] = useState('all');
  const [auditFrom, setAuditFrom] = useState('');

  const auditActions = useMemo(
    () => Array.from(new Set(auditLog.map(a => a.action))).sort(),
    [auditLog],
  );
  const auditEntities = useMemo(
    () => Array.from(new Set(auditLog.map(a => a.entity))).sort(),
    [auditLog],
  );

  const filteredAudit = useMemo(() => auditLog.filter(a => {
    if (auditAction !== 'all' && a.action !== auditAction) return false;
    if (auditEntity !== 'all' && a.entity !== auditEntity) return false;
    // Сравниваем по местной дате события, а не по дате в UTC.
    if (auditFrom && localDateOf(a.ts) < auditFrom) return false;
    return true;
  }), [auditLog, auditAction, auditEntity, auditFrom]);

  const handleAuditExport = async () => {
    await exportToExcel(filteredAudit.map(a => ({
      [t('settings.audit.datetime')]: dates.dateTime(a.ts, true),
      [t('settings.audit.action')]: auditActionLabel(t, a.action),
      [t('settings.audit.entity')]: auditEntityLabel(t, a.entity),
      [t('settings.audit.diff')]: a.diff ?? '',
    })), 'AuditLog');
  };

  // Изменения настроек приходят с экрана, а не из слоя данных, поэтому
  // пишутся здесь. Одно событие на одно действие: раньше журнал получал
  // запись на каждую нажатую клавишу в поле.
  const logSetting = (key: string, value: string) => {
    void createIn<AuditEntry>(TABLES.auditLog, {
      ts: new Date().toISOString(),
      action: 'settings',
      entity: auditEntityOfSetting(key),
      entityId: key,
      diff: `${key}: ${value}`,
    });
  };

  // «Общие»: поля правятся в черновике и применяются кнопкой «Сохранить».
  const savedGeneral = {
    orgName, orgInn, orgDirector, dateFormat, startScreen, docxTemplatePath, annualVacationDays,
    currencySymbol, currencyPosition, currencyDecimals, thousandsSeparator,
  };
  const [generalDraft, setGeneralDraft] = useState(savedGeneral);
  const changedGeneral = (Object.keys(savedGeneral) as (keyof typeof savedGeneral)[])
    .filter((key) => generalDraft[key] !== savedGeneral[key]);
  const setDraft = <K extends keyof typeof savedGeneral>(key: K, value: (typeof savedGeneral)[K]) =>
    setGeneralDraft((prev) => ({ ...prev, [key]: value }));

  const saveGeneral = () => {
    if (changedGeneral.length === 0) return;
    const d = generalDraft;
    setOrgName(d.orgName.trim() || 'KADRA');
    setOrgInn(d.orgInn.trim());
    setOrgDirector(d.orgDirector.trim());
    setDateFormat(d.dateFormat);
    setStartScreen(d.startScreen);
    setDocxTemplatePath(d.docxTemplatePath.trim());
    setAnnualVacationDays(Number(d.annualVacationDays));
    setCurrencySymbol(d.currencySymbol);
    setCurrencyPosition(d.currencyPosition);
    setCurrencyDecimals(d.currencyDecimals);
    setThousandsSeparator(d.thousandsSeparator);
    void createIn<AuditEntry>(TABLES.auditLog, {
      ts: new Date().toISOString(),
      action: 'settings',
      entity: 'settings',
      entityId: changedGeneral.join(','),
      diff: changedGeneral.join(', '),
    });
    setGeneralDraft({ ...d, orgName: d.orgName.trim() || 'KADRA' });
    notify.success(t('settings.general.saved'));
  };

  // Сброс устроен ступенями: от безобидного сброса оформления до полного
  // factory reset. Раньше была одна кнопка, стиравшая всё разом.
  const MODULE_TABLES: { id: string; tables: string[]; label: string }[] = [
    { id: 'candidates', tables: ['candidates'], label: t('nav.recruiting') },
    { id: 'timeoff', tables: ['time_off_requests'], label: t('nav.timeoff') },
    { id: 'onboarding', tables: ['checklist_tasks'], label: t('nav.onboarding') },
    { id: 'performance', tables: ['goals', 'reviews', 'review_cycles'], label: t('nav.performance') },
    { id: 'kb', tables: ['kb_articles'], label: t('nav.knowledge_base') },
    { id: 'archive', tables: ['archives'], label: t('nav.archive') },
    { id: 'timesheet', tables: ['timesheets'], label: t('nav.timesheet') },
    { id: 'movements', tables: ['movements'], label: t('nav.movements') },
  ];

  const [modulesToClear, setModulesToClear] = useState<string[]>([]);
  const [factoryPhrase, setFactoryPhrase] = useState('');

  // Пароль подтверждения нужен, только если он задан. Без пароля защитой
  // остаются контрольное слово и подтверждения — раньше кнопки сброса без
  // пароля не нажимались вовсе, и сбросить данные было невозможно.
  const passwordConfirmed = !hasPassword || resetPassword.length > 0;

  const toggleModule = (id: string) => {
    setModulesToClear(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };

  const handleClearModules = async () => {
    if (modulesToClear.length === 0) return;
    if (!(await notify.confirm(t('settings.security.clearConfirm'), { danger: true }))) return;
    try {
      const tables = MODULE_TABLES.filter(m => modulesToClear.includes(m.id)).flatMap(m => m.tables);
      await api.resetTables(resetPassword, tables);
      await fetchAll();
      notify.success(t('settings.security.cleared', { count: modulesToClear.length }));
      setModulesToClear([]);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : t('settings.security.resetError'));
    }
  };

  const FACTORY_PHRASE = t('settings.security.factoryPhraseWord');

  const handleFactoryReset = async () => {
    // Две ступени подтверждения: пароль владельца и точная фраза. Ошибиться
    // случайно здесь стоит слишком дорого.
    if (factoryPhrase.trim() !== FACTORY_PHRASE) {
      notify.error(t('settings.security.factoryPhraseWrong', { phrase: FACTORY_PHRASE }));
      return;
    }
    if (!(await notify.confirm(t('settings.security.backupFirst')))) return;
    if (!(await notify.confirm(t('settings.security.resetConfirm'), { danger: true }))) return;

    try {
      await api.resetSystem(resetPassword);
      // Реквизиты организации уходят вместе с данными; оформление и язык —
      // личные предпочтения — и вход в программу остаются.
      resetOrganizationSettings();
      notify.success(t('settings.security.resetSuccess'));
      // Перезагрузка — чтобы ни один экран не держал в памяти стёртое.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      notify.error(e instanceof Error ? e.message : t('settings.security.resetError'));
    }
  };

  // Резервное копирование. Список ниже — журнал выгрузок, а не хранилище
  // файлов: браузеру негде держать копии, поэтому сам файл сохраняется у
  // пользователя, а приложение помнит, что и когда выгружалось.
  const [backupBusy, setBackupBusy] = useState(false);

  // Автоматических копий в программе нет, и обещать их на этом экране было
  // прямым обманом: человек полагался бы на копии, которых никто не делает.
  // Вместо обещания — дата последней копии и предупреждение, если она стара.
  const lastBackup = useMemo(
    () => backups.reduce<string | null>((latest, b) => (!latest || b.createdAt > latest ? b.createdAt : latest), null),
    [backups],
  );
  // Момент открытия экрана: возраст копии считается от него, а не от
  // каждого перерисовывания.
  const [openedAt] = useState(() => Date.now());
  const backupIsStale = lastBackup === null
    || openedAt - new Date(lastBackup).getTime() > 7 * 24 * 60 * 60 * 1000;
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const handleCreateBackup = async () => {
    setBackupBusy(true);
    try {
      const payload = await api.exportBackup();
      const rows = Object.values(payload.data).reduce((sum, list) => sum + list.length, 0);
      // Имя файла — по местному времени, как его видит пользователь.
      const fileName = `kadra-backup-${fileStamp(new Date(payload.createdAt))}.json`;

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);

      await createIn<BackupEntry>(TABLES.backups, {
        createdAt: payload.createdAt,
        fileName,
        rows,
      });
      notify.success(t('settings.backup.savedAs', { file: fileName }));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : t('settings.backup.failed'));
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (restoreInputRef.current) restoreInputRef.current.value = '';
    if (!file) return;

    let payload: unknown;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      notify.error(t('settings.backup.badFile'));
      return;
    }

    // Восстановление затирает текущие данные — спрашиваем прямо.
    if (!(await notify.confirm(t('settings.backup.restoreConfirm'), { danger: true }))) return;

    setBackupBusy(true);
    try {
      const result = await api.restoreBackup(payload);
      await fetchAll();
      notify.success(t('settings.backup.restored', { n: result.restored }));
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t('settings.backup.failed'));
    } finally {
      setBackupBusy(false);
    }
  };

  const tabs = [
    { id: 'general', icon: SettingsIcon, label: t('settings.tabs.general') },
    { id: 'license', icon: ShieldCheck, label: t('settings.tabs.license') },
    { id: 'passwords', icon: Key, label: t('settings.tabs.password') },
    { id: 'security', icon: Shield, label: t('settings.tabs.security') },
    { id: 'backup', icon: Database, label: t('settings.tabs.backup') },
    { id: 'integrations', icon: Link, label: t('settings.tabs.io') },
    { id: 'appearance', icon: Palette, label: t('settings.tabs.appearance') },
  ];

  return (
    <div className="h-full flex flex-col space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h2>

      <div className="flex flex-1 min-h-0 bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm overflow-hidden">
        
        {/* Left Sidebar for Settings Tabs */}
        <div className="w-56 flex-shrink-0 border-r border-[var(--border-color)] p-4 flex flex-col gap-1 overflow-y-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={`flex items-center gap-3 w-full text-left px-4 py-3 rounded-xl transition-colors ${activeTab === tab.id ? 'bg-accent-600/10 text-accent-700 dark:text-accent-300 font-medium' : 'text-muted hover:bg-surface-hover hover:text-primary'}`}
            >
              <tab.icon className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Right Content Area */}
        <div className="flex-1 p-8 overflow-y-auto">
          {activeTab === 'general' && (
            <div className="max-w-2xl">
              <h3 className="text-lg font-medium mb-8 border-b border-[var(--border-color)] pb-4">{t('settings.general.title')}</h3>

              <div className="space-y-6">
                <div>
                  <label htmlFor="set-org-name" className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.orgName')}</label>
                  <input
                    id="set-org-name"
                    type="text"
                    value={generalDraft.orgName}
                    onChange={(e) => setDraft('orgName', e.target.value)}
                    className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                  />
                </div>
                <div>
                  <label htmlFor="set-org-inn" className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.inn')}</label>
                  <input
                    id="set-org-inn"
                    type="text"
                    value={generalDraft.orgInn}
                    onChange={(e) => setDraft('orgInn', e.target.value)}
                    className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                  />
                </div>
                <div>
                  <label htmlFor="set-org-director" className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.director')}</label>
                  <input
                    id="set-org-director"
                    type="text"
                    value={generalDraft.orgDirector}
                    onChange={(e) => setDraft('orgDirector', e.target.value)}
                    className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="set-date-format" className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.dateFormat')}</label>
                    <select
                      id="set-date-format"
                      value={generalDraft.dateFormat}
                      onChange={(e) => setDraft('dateFormat', e.target.value as DateFormat)}
                      className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                    >
                      <option value="dd.MM.yyyy">31.12.2026</option>
                      <option value="yyyy-MM-dd">2026-12-31</option>
                      <option value="MM/dd/yyyy">12/31/2026</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="set-start-screen" className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.startScreen')}</label>
                    <select
                      id="set-start-screen"
                      value={generalDraft.startScreen}
                      onChange={(e) => setDraft('startScreen', e.target.value)}
                      className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                    >
                      <option value="/dashboard">{t('nav.dashboard')}</option>
                      <option value="/employees">{t('nav.employees')}</option>
                      <option value="/timesheet">{t('nav.timesheet')}</option>
                      <option value="/calendar">{t('nav.calendar')}</option>
                      <option value="/reports">{t('nav.reports')}</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="set-language" className="block text-sm font-medium mb-2 text-secondary">{t('settings.language')}</label>
                    {/* Язык меняется сразу: это видно по самому экрану. */}
                    <select
                      id="set-language"
                      value={language}
                      onChange={(e) => { setLanguage(e.target.value); logSetting('language', e.target.value); }}
                      className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                    >
                      <option value="ru">Русский</option>
                      <option value="en">English</option>
                      <option value="tk">Türkmençe</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="set-vacation-days" className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.vacationDays')}</label>
                    <input
                      id="set-vacation-days"
                      type="number"
                      min={0}
                      max={366}
                      value={generalDraft.annualVacationDays}
                      onChange={(e) => setDraft('annualVacationDays', Number(e.target.value))}
                      className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="set-docx" className="block text-sm font-medium mb-2 text-secondary">{t('docgen.docxTemplate')}</label>
                  <input
                    id="set-docx"
                    type="text"
                    value={generalDraft.docxTemplatePath}
                    onChange={(e) => setDraft('docxTemplatePath', e.target.value)}
                    className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                  />
                  <p className="text-xs text-muted mt-2">{t('docgen.docxHint')}</p>
                </div>

                <div className="pt-2 border-t border-[var(--border-color)]">
                  <h4 className="text-sm font-semibold text-primary mt-4 mb-4">{t('settings.currency.title')}</h4>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="set-cur-symbol" className="block text-sm font-medium mb-2 text-secondary">{t('settings.currency.symbol')}</label>
                      <input
                        id="set-cur-symbol"
                        type="text"
                        value={generalDraft.currencySymbol}
                        maxLength={8}
                        onChange={(e) => setDraft('currencySymbol', e.target.value)}
                        className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                      />
                    </div>
                    <div>
                      <label htmlFor="set-cur-position" className="block text-sm font-medium mb-2 text-secondary">{t('settings.currency.position')}</label>
                      <select
                        id="set-cur-position"
                        value={generalDraft.currencyPosition}
                        onChange={(e) => setDraft('currencyPosition', e.target.value as CurrencyPosition)}
                        className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                      >
                        <option value="prefix">{t('settings.currency.prefix')}</option>
                        <option value="suffix">{t('settings.currency.suffix')}</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="set-cur-decimals" className="block text-sm font-medium mb-2 text-secondary">{t('settings.currency.decimals')}</label>
                      <select
                        id="set-cur-decimals"
                        value={generalDraft.currencyDecimals}
                        onChange={(e) => setDraft('currencyDecimals', Number(e.target.value) as CurrencyDecimals)}
                        className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                      >
                        <option value={0}>0</option>
                        <option value={2}>2</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="set-cur-separator" className="block text-sm font-medium mb-2 text-secondary">{t('settings.currency.separator')}</label>
                      <select
                        id="set-cur-separator"
                        value={generalDraft.thousandsSeparator}
                        onChange={(e) => setDraft('thousandsSeparator', e.target.value as ThousandsSeparator)}
                        className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                      >
                        <option value="space">{t('settings.currency.sepSpace')}</option>
                        <option value="comma">{t('settings.currency.sepComma')}</option>
                        <option value="dot">{t('settings.currency.sepDot')}</option>
                        <option value="none">{t('settings.currency.sepNone')}</option>
                      </select>
                    </div>
                  </div>

                  <p className="text-sm text-muted mt-4">
                    {t('settings.currency.preview')}: <span className="text-primary tabular-nums font-medium">{formatMoney(1234567.89, generalDraft)}</span>
                  </p>
                </div>

                <div className="pt-4 flex items-center gap-4">
                  <button
                    onClick={saveGeneral}
                    disabled={changedGeneral.length === 0}
                    className="bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl font-medium transition-colors"
                  >
                    {t('common.save')}
                  </button>
                  {changedGeneral.length > 0 && (
                    <span className="text-sm text-amber-600 dark:text-amber-400">{t('settings.general.unsaved')}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'license' && <LicenseSettings />}

          {activeTab === 'passwords' && (
            <div className="max-w-3xl space-y-8">
              <div className="bg-surface-2 border border-line rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-2">
                  <Key className="w-5 h-5 text-accent-400" />
                  <h3 className="text-lg font-medium">{t('settings.password.title')}</h3>
                </div>
                <p className="text-sm text-muted mb-6">
                  {!hasOwner ? t('settings.password.hintNoOwner')
                    : hasPassword ? t('settings.password.hint')
                      : t('settings.password.hintNoPassword')}
                </p>

                <div className="space-y-4 max-w-xl">
                  {hasPassword && (
                    <div>
                      <label htmlFor="pwd-current" className="block text-sm font-medium mb-2 text-secondary">{t('settings.password.current')}</label>
                      <PasswordInput id="pwd-current" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder={t('settings.password.currentPlaceholder')} className="w-full bg-input border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500" />
                    </div>
                  )}
                  <div>
                    <label htmlFor="pwd-new" className="block text-sm font-medium mb-2 text-secondary">{t('settings.password.new')}</label>
                    <PasswordInput id="pwd-new" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder={t('settings.password.minChars')} className="w-full bg-input border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500" />
                  </div>
                  <div>
                    <label htmlFor="pwd-confirm" className="block text-sm font-medium mb-2 text-secondary">{t('settings.password.confirm')}</label>
                    <PasswordInput id="pwd-confirm" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder={t('settings.password.confirmPlaceholder')} className="w-full bg-input border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500" />
                  </div>
                  <button onClick={async () => {
                    if (newPassword !== confirmPassword) {
                      notify.error(t('settings.password.mismatch'));
                      return;
                    }
                    if (newPassword.length < 6) {
                      notify.error(t('settings.password.tooShort'));
                      return;
                    }
                    try {
                      await api.changePassword(currentPassword, newPassword);
                      setHasPassword(true);
                      notify.success(t('settings.password.success'));
                      setCurrentPassword('');
                      setNewPassword('');
                      setConfirmPassword('');
                    } catch (e) {
                      notify.error(e instanceof Error ? e.message : t('settings.password.error'));
                    }
                  }} disabled={!hasOwner} className="bg-accent-500 hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl font-medium transition-colors mt-2 text-sm">
                    {t('settings.password.save')}
                  </button>

                  {/* Снятие пароля — обратная операция к установке: приложение
                      снова начнёт открываться сразу. Запрос пароля при входе
                      выключаем тем же действием, иначе владелец остался бы
                      перед формой, к которой подходить уже нечему. */}
                  {hasPassword && (
                    <button onClick={async () => {
                      if (!(await notify.confirm(t('settings.password.removeConfirm'), { danger: true }))) return;
                      try {
                        await api.removePassword(currentPassword);
                        setHasPassword(false);
                        setRequirePassword(false);
                        setCurrentPassword('');
                        setNewPassword('');
                        setConfirmPassword('');
                        logSetting('password', 'removed');
                        notify.success(t('settings.password.removed'));
                      } catch (e) {
                        notify.error(e instanceof Error ? e.message : t('settings.password.removeError'));
                      }
                    }} className="border border-rose-500/40 text-rose-700 dark:text-rose-400 hover:bg-rose-500/10 px-6 py-2.5 rounded-xl font-medium transition-colors text-sm">
                      {t('settings.password.remove')}
                    </button>
                  )}
                </div>
              </div>

            </div>
          )}

          {activeTab === 'security' && (
            <div className="space-y-8 max-w-5xl">
              {/* Пароль при входе — выбор владельца, а не навязанное поведение:
                  приложение однопользовательское и стоит на его устройстве.
                  Пока он выключен, блокировки по бездействию тоже нет —
                  снимать её было бы нечем. */}
              <div className="bg-surface-2 border border-line rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-2">
                  <Key className="w-5 h-5 text-accent-500" />
                  <h3 className="text-lg font-medium">{t('settings.security.askPassword')}</h3>
                </div>
                <p className="text-sm text-muted mb-6">
                  {hasPassword ? t('settings.security.askPasswordHint') : t('settings.security.askPasswordNeedsSet')}
                </p>

                <label className="flex items-center gap-3 cursor-pointer w-fit">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={requirePassword}
                    disabled={!hasPassword}
                    aria-label={t('settings.security.askPassword')}
                    onClick={async () => {
                      // Настройка хранится в базе вместе с учётной записью:
                      // очистка данных браузера её не выключит. Журнал пишет
                      // слой данных.
                      const next = !requirePassword;
                      try {
                        await api.setRequirePassword(next);
                        setRequirePassword(next);
                        notify.success(next ? t('settings.security.askPasswordOn') : t('settings.security.askPasswordOff'));
                      } catch (e) {
                        notify.error(e instanceof Error ? e.message : t('settings.security.resetError'));
                      }
                    }}
                    className={`relative w-11 h-6 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${requirePassword ? 'bg-accent-600' : 'bg-surface-3 border border-line'}`}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${requirePassword ? 'left-[22px]' : 'left-0.5'}`} />
                  </button>
                  <span className="text-sm text-secondary">
                    {requirePassword ? t('settings.security.on') : t('settings.security.off')}
                  </span>
                </label>
              </div>

              <div className="bg-surface-2 border border-line rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-2">
                  <ShieldCheck className="w-5 h-5 text-emerald-500" />
                  <h3 className="text-lg font-medium">{t('settings.security.lockTitle')}</h3>
                </div>
                <p className="text-sm text-muted mb-6">
                  {requirePassword ? t('settings.security.lockHint') : t('settings.security.lockNeedsPassword')}
                </p>

                <div className="flex flex-wrap items-end gap-4">
                  <div className="w-56">
                    <label htmlFor="lock-timeout" className="block text-sm font-medium mb-2 text-secondary">{t('settings.security.lockTimeout')}</label>
                    <select
                      id="lock-timeout"
                      value={lockTimeoutMinutes}
                      disabled={!requirePassword}
                      onChange={(e) => { setLockTimeoutMinutes(Number(e.target.value)); logSetting('lockTimeoutMinutes', e.target.value); }}
                      className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 disabled:opacity-50"
                    >
                      <option value={0}>{t('settings.security.lockOff')}</option>
                      {[5, 10, 15, 30, 60].map(n => (
                        <option key={n} value={n}>{t('settings.security.lockMinutes', { n })}</option>
                      ))}
                    </select>
                  </div>

                  <button
                    onClick={lock}
                    disabled={!requirePassword}
                    className="bg-surface-3 hover:bg-surface-hover border border-line text-secondary px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {t('settings.security.lockNow')}
                  </button>
                </div>
              </div>

              <div className="bg-rose-500/5 border border-rose-500/20 rounded-2xl p-6">
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="w-5 h-5 text-rose-500" />
                  <h3 className="text-lg font-medium text-rose-700 dark:text-rose-400">{t('settings.security.resetTitle')}</h3>
                </div>
                <p className="text-sm text-muted mb-6">{t('settings.security.resetHint')}</p>

                <div className="space-y-6 max-w-2xl">
                  {/* Ступень 1-2: настройки. Данные не затрагиваются, пароль не нужен. */}
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={() => { resetAppearance(); logSetting('reset', 'appearance'); notify.success(t('settings.security.appearanceReset')); }}
                      className="bg-surface-3 hover:bg-surface-hover border border-line text-secondary px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                    >
                      {t('settings.security.resetAppearance')}
                    </button>
                    <button
                      onClick={() => { resetSettings(); logSetting('reset', 'settings'); setGeneralDraft({ ...generalDraft }); notify.success(t('settings.security.settingsReset')); }}
                      className="bg-surface-3 hover:bg-surface-hover border border-line text-secondary px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                    >
                      {t('settings.security.resetSettings')}
                    </button>
                  </div>

                  {/* Ступень 2½: демонстрационные данные первого запуска. Своё не трогается. */}
                  <div className="border-t border-line pt-6">
                    <h4 className="text-sm font-semibold text-primary mb-2">{t('settings.demo.title')}</h4>
                    <p className="text-xs text-muted mb-3">{demoPresent ? t('settings.demo.hint') : t('settings.demo.none')}</p>
                    <button
                      onClick={handleClearDemo}
                      disabled={!demoPresent}
                      className="bg-surface-3 hover:bg-surface-hover border border-line text-secondary disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                    >
                      {t('settings.demo.button')}
                    </button>
                  </div>

                  {!hasPassword && (
                    <p className="text-xs text-muted border-t border-line pt-6">{t('settings.security.noPasswordHint')}</p>
                  )}

                  {hasPassword && (
                    <div className="border-t border-line pt-6">
                      <label htmlFor="reset-password" className="block text-sm font-medium mb-2 text-rose-600 dark:text-rose-400">{t('settings.security.adminPassword')}</label>
                      <PasswordInput
                        id="reset-password"
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                        placeholder={t('settings.security.adminPasswordPlaceholder')}
                        className="w-full bg-input border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-rose-500 text-primary"
                      />
                      <p className="text-xs text-muted mt-2">{t('settings.security.passwordNeeded')}</p>
                    </div>
                  )}

                  {/* Ступень 3: данные выбранных модулей. */}
                  <div className="border-t border-line pt-6">
                    <h4 className="text-sm font-semibold text-primary mb-3">{t('settings.security.clearModules')}</h4>
                    <div className="flex flex-wrap gap-2 mb-4">
                      {MODULE_TABLES.map(({ id, label }) => (
                        <button
                          key={id}
                          aria-pressed={modulesToClear.includes(id)}
                          onClick={() => toggleModule(id)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${modulesToClear.includes(id) ? 'bg-rose-500/20 text-rose-800 dark:text-rose-300 border-rose-500/40' : 'bg-surface-3 text-muted border-line hover:bg-surface-hover'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={handleClearModules}
                      disabled={modulesToClear.length === 0 || !passwordConfirmed}
                      className="bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 disabled:opacity-50 px-6 py-2.5 rounded-xl text-sm font-medium transition-colors"
                    >
                      {t('settings.security.clearBtn')}
                    </button>
                  </div>

                  {/* Ступень 4: полный сброс. Пароль + фраза + предложение бэкапа. */}
                  <div className="border-t border-line pt-6">
                    <h4 className="text-sm font-semibold text-rose-700 dark:text-rose-400 mb-3">{t('settings.security.factoryTitle')}</h4>
                    <p className="text-xs text-muted mb-3">{t('settings.security.factoryHint', { phrase: FACTORY_PHRASE })}</p>
                    <input
                      type="text"
                      value={factoryPhrase}
                      aria-label={t('settings.security.factoryTitle')}
                      onChange={(e) => setFactoryPhrase(e.target.value)}
                      placeholder={FACTORY_PHRASE}
                      className="w-full bg-input border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-rose-500 text-primary mb-4"
                    />
                  <button
                    onClick={handleFactoryReset}
                    disabled={!passwordConfirmed || factoryPhrase.trim() !== FACTORY_PHRASE}
                    className="bg-rose-500/20 text-rose-800 dark:text-rose-300 border border-rose-500/30 hover:bg-rose-500/30 disabled:opacity-50 px-6 py-2.5 rounded-xl text-sm font-medium transition-colors"
                  >
                    {t('settings.security.resetBtn')}
                  </button>
                  </div>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-xl font-bold">{t('settings.audit.title')}</h3>
                    <p className="text-sm text-muted">{t('settings.audit.subtitle')}</p>
                  </div>
                </div>

                <div className="bg-surface-2 border border-line rounded-2xl overflow-hidden">
                  <div className="p-4 border-b border-line flex items-end gap-4 bg-surface">
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-muted mb-2">{t('settings.audit.actionType')}</label>
                      <select
                        aria-label={t('settings.audit.actionType')}
                        value={auditAction}
                        onChange={(e) => setAuditAction(e.target.value)}
                        className="w-full bg-app border border-line rounded-xl px-4 py-2 text-sm focus:outline-none text-secondary"
                      >
                        <option value="all">{t('settings.audit.all')}</option>
                        {auditActions.map(a => <option key={a} value={a}>{auditActionLabel(t, a)}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-muted mb-2">{t('settings.audit.entity')}</label>
                      <select
                        aria-label={t('settings.audit.entity')}
                        value={auditEntity}
                        onChange={(e) => setAuditEntity(e.target.value)}
                        className="w-full bg-app border border-line rounded-xl px-4 py-2 text-sm focus:outline-none text-secondary"
                      >
                        <option value="all">{t('settings.audit.all')}</option>
                        {auditEntities.map(e => <option key={e} value={e}>{auditEntityLabel(t, e)}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-muted mb-2">{t('settings.audit.dateFrom')}</label>
                      <input
                        type="date"
                        aria-label={t('settings.audit.dateFrom')}
                        value={auditFrom}
                        onChange={(e) => setAuditFrom(e.target.value)}
                        className="w-full bg-app border border-line rounded-xl px-4 py-2 text-sm focus:outline-none text-secondary"
                      />
                    </div>
                    <button
                      onClick={() => { setAuditAction('all'); setAuditEntity('all'); setAuditFrom(''); }}
                      className="bg-surface-3 hover:bg-surface-hover text-secondary px-4 py-2 rounded-xl text-sm font-medium transition-colors h-[38px]"
                    >
                      {t('common.reset')}
                    </button>
                    <button
                      onClick={handleAuditExport}
                      className="bg-accent-500/20 text-accent-700 dark:text-accent-300 border border-accent-500/30 hover:bg-accent-500/30 px-6 py-2 rounded-xl text-sm font-medium transition-colors h-[38px]"
                    >
                      {t('common.export')}
                    </button>
                  </div>

                  <table className="w-full text-sm text-left">
                    <thead className="text-table text-secondary bg-surface border-b border-line">
                      <tr>
                        <th className="p-table text-table font-medium">{t('settings.audit.datetime')}</th>
                        <th className="p-table text-table font-medium">{t('settings.audit.user')}</th>
                        <th className="p-table text-table font-medium">{t('settings.audit.action')}</th>
                        <th className="p-table text-table font-medium">{t('settings.audit.entity')}</th>
                        <th className="p-table text-table font-medium">{t('settings.audit.diff')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAudit.slice(0, 200).map(a => (
                        <tr key={a.id} className="border-b border-line hover:bg-surface-hover">
                          <td className="p-table text-table whitespace-nowrap tabular-nums">{dates.dateTime(a.ts, true)}</td>
                          {/* Приложение однопользовательское: действующее лицо — владелец
                              устройства. Неудачный вход владельцу не приписываем. */}
                          <td className="p-table text-accent-700 dark:text-accent-300">{a.action === 'login_failed' ? '—' : (user?.name || t('user.owner'))}</td>
                          <td className="p-table text-table">{auditActionLabel(t, a.action)}</td>
                          <td className="p-table text-table">{auditEntityLabel(t, a.entity)}</td>
                          <td className="p-table font-mono text-xs">{a.diff || a.entityId || '—'}</td>
                        </tr>
                      ))}
                      {filteredAudit.length === 0 && (
                        <tr>
                          <td colSpan={5} className="p-table text-table text-center text-muted py-8">
                            {t('settings.audit.empty')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'backup' && (
            <div className="max-w-5xl space-y-8">
              <div>
                <h3 className="text-xl font-bold mb-1">{t('settings.backup.title')}</h3>
                <p className="text-sm text-muted">{t('settings.backup.subtitle')}</p>
              </div>

              <div className="bg-surface-2 border border-line rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Database className="w-5 h-5 text-accent-400" />
                    <h4 className="text-lg font-medium">{t('settings.backup.createFull')}</h4>
                  </div>
                  <p className="text-sm text-muted">{t('settings.backup.manualInfo')}</p>
                  <p className={`text-sm mt-2 ${backupIsStale ? 'text-amber-700 dark:text-amber-400' : 'text-muted'}`}>
                    {lastBackup
                      ? t('settings.backup.lastCopy', { date: dates.dateTime(lastBackup) })
                      : t('settings.backup.neverCopied')}
                    {lastBackup && backupIsStale ? ' · ' + t('settings.backup.stale') : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <input
                    type="file"
                    accept="application/json,.json"
                    ref={restoreInputRef}
                    data-testid="restore-input"
                    onChange={handleRestoreFile}
                    className="hidden"
                  />
                  <button
                    onClick={() => restoreInputRef.current?.click()}
                    disabled={backupBusy}
                    className="bg-surface-3 hover:bg-surface-hover border border-line text-secondary px-6 py-2.5 rounded-xl font-medium transition-colors text-sm disabled:opacity-50"
                  >
                    {t('settings.backup.restore')}
                  </button>
                  <button
                    onClick={handleCreateBackup}
                    disabled={backupBusy}
                    className="bg-accent-500 hover:bg-accent-600 text-white px-6 py-2.5 rounded-xl font-medium transition-colors flex items-center justify-center gap-2 text-sm disabled:opacity-50"
                  >
                    <Download className="w-4 h-4" /> {t('settings.backup.createNow')}
                  </button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Database className="w-5 h-5 text-muted" />
                    <h4 className="text-lg font-medium">{t('settings.backup.available')}</h4>
                  </div>

                </div>
                <div className="bg-surface-2 border border-line rounded-2xl overflow-hidden">
                  <table className="w-full text-sm text-left">
                    <thead className="text-table text-secondary bg-surface border-b border-line">
                      <tr>
                        <th className="p-table text-table font-medium">{t('settings.backup.file')}</th>
                        <th className="p-table text-table font-medium">{t('settings.backup.rowsCol')}</th>
                        <th className="p-table text-table font-medium">{t('settings.backup.created')}</th>
                        <th className="p-table font-medium text-right">{t('settings.backup.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backups.map(b => (
                        <tr key={b.id} className="border-b border-line hover:bg-surface-hover">
                          <td className="p-table text-accent-700 dark:text-accent-300">{b.fileName}</td>
                          <td className="p-table text-table tabular-nums">{t('settings.backup.rows', { count: b.rows })}</td>
                          <td className="p-table text-table tabular-nums">{dates.dateTime(b.createdAt, true)}</td>
                          <td className="p-table text-right">
                            <button
                              onClick={() => removeFrom(TABLES.backups, b.id)}
                              className="text-rose-700 dark:text-rose-400 hover:text-rose-800 dark:hover:text-rose-300"
                            >
                              {t('common.delete')}
                            </button>
                          </td>
                        </tr>
                      ))}
                      {backups.length === 0 && (
                        <tr>
                          <td colSpan={4} className="p-table text-table text-center text-muted py-8">
                            {t('settings.backup.empty')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'integrations' && (
            <div className="max-w-5xl space-y-8">
              <div>
                <h3 className="text-xl font-bold mb-1">{t('settings.io.title')}</h3>
                <p className="text-sm text-muted">{t('settings.io.subtitle')}</p>
              </div>

              <ImportWizard />
            </div>
          )}

          {activeTab === 'appearance' && (
            <div className="max-w-3xl space-y-8">
              <div>
                <h3 className="text-sm font-medium mb-4 text-primary">{t('settings.appearance.colorTheme')}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {(['light', 'dark', 'system'] as const).map((tOpt) => (
                    <button
                      key={tOpt}
                      aria-pressed={theme === tOpt}
                      onClick={() => { setTheme(tOpt); logSetting('theme', tOpt); }}
                      className={`relative p-6 rounded-2xl border flex flex-col items-center justify-center gap-3 transition-colors ${
                        theme === tOpt 
                          ? 'border-accent-500 bg-accent-500/10 text-accent-700 dark:text-accent-300' 
                          : 'border-line bg-surface-2 hover:bg-surface-hover text-muted'
                      }`}
                    >
                      {tOpt === 'light' ? <Sun className="w-6 h-6" /> : tOpt === 'dark' ? <Moon className="w-6 h-6" /> : <Monitor className="w-6 h-6" />}
                      <span className="text-sm font-medium">{tOpt === 'light' ? t('settings.light') : tOpt === 'dark' ? t('settings.dark') : t('settings.system')}</span>
                      {theme === tOpt && <div className="absolute bottom-3"><Check className="w-4 h-4 text-accent-600 dark:text-accent-400" /></div>}
                    </button>
                  ))}
                </div>
              </div>
              
              <div className="border border-line rounded-2xl p-6 bg-surface-2">
                <h3 className="text-sm font-medium mb-1 text-primary">{t('settings.appearance.accent')}</h3>
                <p className="text-xs text-muted mb-6">{t('settings.appearance.accentHint')}</p>
                <div className="flex gap-4">
                  {(['indigo', 'purple', 'blue', 'emerald', 'rose', 'amber'] as const).map(color => {
                    const colorClasses = {
                      indigo: 'bg-indigo-500 ring-indigo-500',
                      purple: 'bg-purple-500 ring-purple-500',
                      blue: 'bg-blue-500 ring-blue-500',
                      emerald: 'bg-emerald-500 ring-emerald-500',
                      rose: 'bg-rose-500 ring-rose-500',
                      amber: 'bg-amber-500 ring-amber-500',
                    }[color];
                    
                    return (
                      <div
                        key={color}
                        {...clickable(() => { setAccentColor(color); logSetting('accentColor', color); }, t(`settings.appearance.colors.${color}`))}
                        aria-pressed={accentColor === color}
                        className={`w-8 h-8 rounded-full cursor-pointer hover:scale-110 transition-transform flex items-center justify-center text-white ${colorClasses} ${
                          accentColor === color ? 'ring-2 ring-offset-2 ring-offset-[var(--surface-2)]' : ''
                        }`}
                      >
                        {accentColor === color && <Check className="w-4 h-4" />}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="border border-line rounded-2xl p-6 bg-surface-2">
                <h3 className="text-sm font-medium mb-1 text-primary">{t('settings.appearance.density')}</h3>
                <p className="text-xs text-muted mb-6">{t('settings.appearance.densityHint')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {(['compact', 'standard', 'spacious'] as const).map(d => (
                    <div
                      key={d}
                      {...clickable(() => { setDensity(d); logSetting('density', d); }, d === 'compact' ? t('settings.appearance.compact') : d === 'standard' ? t('settings.appearance.standard') : t('settings.appearance.spacious'))}
                      aria-pressed={density === d}
                      className={`rounded-xl p-4 cursor-pointer transition-colors ${
                        density === d 
                          ? 'border border-accent-500 bg-accent-500/10' 
                          : 'border border-line bg-input hover:bg-surface-hover'
                      }`}
                    >
                      <p className={`font-medium text-sm ${density === d ? 'text-accent-700 dark:text-accent-300' : 'text-primary'}`}>
                        {d === 'compact' ? t('settings.appearance.compact') : d === 'standard' ? t('settings.appearance.standard') : t('settings.appearance.spacious')}
                      </p>
                      <p className={`text-xs mt-1 ${density === d ? 'text-accent-700/80 dark:text-accent-300/80' : 'text-muted'}`}>
                        {d === 'compact' ? t('settings.appearance.compactHint') : d === 'standard' ? t('settings.appearance.standardHint') : t('settings.appearance.spaciousHint')}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border border-line rounded-2xl p-6 bg-surface-2">
                <h3 className="text-sm font-medium mb-6 text-primary">{t('settings.appearance.fontSize')}</h3>
                <div className="flex items-center gap-4 px-2">
                  <span className="text-xs font-medium text-muted cursor-pointer" {...clickable(() => { setFontSize('small'); logSetting('fontSize', 'small'); }, t('settings.appearance.small'))}>A</span>
                  <div className="flex-1 relative h-2 bg-surface-3 rounded-full flex items-center">
                    <div className="absolute top-0 left-0 h-full bg-accent-500 rounded-full transition-all" style={{ width: fontSize === 'small' ? '0%' : fontSize === 'standard' ? '50%' : '100%' }}></div>
                    
                    <div
                      {...clickable(() => { setFontSize('small'); logSetting('fontSize', 'small'); }, t('settings.appearance.small14'))}
                      aria-pressed={fontSize === 'small'}
                      className={`absolute left-0 w-4 h-4 rounded-full cursor-pointer -translate-x-1/2 ${fontSize === 'small' ? 'bg-accent-400 ring-4 ring-accent-500/30 shadow-sm' : 'bg-transparent'}`}
                    ></div>
                    <div
                      {...clickable(() => { setFontSize('standard'); logSetting('fontSize', 'standard'); }, t('settings.appearance.standard16'))}
                      aria-pressed={fontSize === 'standard'}
                      className={`absolute left-1/2 w-4 h-4 rounded-full cursor-pointer -translate-x-1/2 ${fontSize === 'standard' ? 'bg-accent-400 ring-4 ring-accent-500/30 shadow-sm' : 'bg-transparent'}`}
                    ></div>
                    <div
                      {...clickable(() => { setFontSize('large'); logSetting('fontSize', 'large'); }, t('settings.appearance.large18'))}
                      aria-pressed={fontSize === 'large'}
                      className={`absolute left-full w-4 h-4 rounded-full cursor-pointer -translate-x-1/2 ${fontSize === 'large' ? 'bg-accent-400 ring-4 ring-accent-500/30 shadow-sm' : 'bg-transparent'}`}
                    ></div>
                  </div>
                  <span className="text-lg font-medium text-muted cursor-pointer" {...clickable(() => { setFontSize('large'); logSetting('fontSize', 'large'); }, t('settings.appearance.large'))}>A</span>
                </div>
                <div className="flex justify-between mt-3 px-2">
                  <span className="text-xs text-muted">{t('settings.appearance.small')}</span>
                  <span className="text-xs text-muted">{t('settings.appearance.standard')}</span>
                  <span className="text-xs text-muted">{t('settings.appearance.large')}</span>
                </div>
                <p className="text-sm text-muted mt-6 pt-4 border-t border-line">{t('settings.appearance.current')} <span className="text-primary font-medium">
                  {fontSize === 'small' ? t('settings.appearance.small14') : fontSize === 'standard' ? t('settings.appearance.standard16') : t('settings.appearance.large18')}
                </span></p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
