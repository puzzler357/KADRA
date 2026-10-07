import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/useAppStore';
import { useDatabaseStore, TABLES } from '../store/useDatabaseStore';
import type { AuditEntry, BackupEntry } from '../store/useDatabaseStore';
import { exportToExcel } from '../lib/excel';
import ImportWizard from '../components/ImportWizard';
import LicenseSettings from '../components/LicenseSettings';
import { useMoney } from '../lib/money';
import type { CurrencyDecimals, CurrencyPosition, ThousandsSeparator } from '../lib/money';
import * as api from '../data';
import { Settings as SettingsIcon, ShieldCheck, Key, Shield, Database, Link, Palette, Eye, Download, RefreshCw, Check, Sun, Moon, Monitor } from 'lucide-react';
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
    orgName, orgInn, orgDirector, dateFormat, startScreen,
    setOrgName, setOrgInn, setOrgDirector, setDateFormat, setStartScreen,
    requirePassword, setRequirePassword,
    lockTimeoutMinutes, setLockTimeoutMinutes, lock,
    resetAppearance, resetSettings,
  } = useAppStore();
  const money = useMoney();
  const notify = useNotify();
  const [activeTab, setActiveTab] = useState('general');

  
  const { auditLog, backups, createIn, removeFrom, fetchAll } = useDatabaseStore();

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
    // ts хранится в ISO, поэтому сравнение строк по префиксу даты корректно.
    if (auditFrom && a.ts.slice(0, 10) < auditFrom) return false;
    return true;
  }), [auditLog, auditAction, auditEntity, auditFrom]);

  const handleAuditExport = async () => {
    await exportToExcel(filteredAudit.map(a => ({
      [t('settings.audit.datetime')]: a.ts.replace('T', ' ').slice(0, 19),
      [t('settings.audit.action')]: a.action,
      [t('settings.audit.entity')]: a.entity,
      [t('settings.audit.diff')]: a.diff ?? '',
    })), 'AuditLog');
  };

  // Изменения оформления приходят с экрана, а не из слоя данных, поэтому
  // пишутся здесь — единственное место, где журнал пополняет интерфейс.
  const logSetting = (key: string, value: string) => {
    void createIn<AuditEntry>(TABLES.auditLog, {
      ts: new Date().toISOString(),
      action: 'settings',
      entity: 'appearance',
      entityId: key,
      diff: `${key}: ${value}`,
    });
  };

  // Сброс устроен ступенями: от безобидного сброса оформления до полного
  // factory reset. Раньше была одна кнопка, стиравшая всё разом.
  const MODULE_TABLES: { table: string; label: string }[] = [
    { table: 'candidates', label: t('reports.srcCandidates') },
    { table: 'time_off_requests', label: t('nav.timeoff') },
    { table: 'checklist_tasks', label: t('nav.onboarding') },
    { table: 'kb_articles', label: t('nav.knowledge_base') },
    { table: 'archives', label: t('nav.archive') },
    { table: 'timesheets', label: t('nav.timesheet') },
    { table: 'movements', label: t('nav.movements') },
  ];

  const [modulesToClear, setModulesToClear] = useState<string[]>([]);
  const [factoryPhrase, setFactoryPhrase] = useState('');

  const toggleModule = (table: string) => {
    setModulesToClear(prev => (prev.includes(table) ? prev.filter(x => x !== table) : [...prev, table]));
  };

  const handleClearModules = async () => {
    if (modulesToClear.length === 0) return;
    if (!(await notify.confirm(t('settings.security.clearConfirm'), { danger: true }))) return;
    try {
      const result = await api.resetTables(resetPassword, modulesToClear);
      await fetchAll();
      setModulesToClear([]);
      notify.success(t('settings.security.cleared', { n: result.cleared.length }));
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
      localStorage.removeItem('hr-docs-local-db');
      localStorage.removeItem('hr-docs-app-storage');
      notify.success(t('settings.security.resetSuccess'));
      window.location.reload();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : t('settings.security.resetError'));
    }
  };

  // Резервное копирование. Список ниже — журнал выгрузок, а не хранилище
  // файлов: браузеру негде держать копии, поэтому сам файл сохраняется у
  // пользователя, а приложение помнит, что и когда выгружалось.
  const [backupBusy, setBackupBusy] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const handleCreateBackup = async () => {
    setBackupBusy(true);
    try {
      const payload = await api.exportBackup();
      const rows = Object.values(payload.data).reduce((sum, list) => sum + list.length, 0);
      const fileName = `hrdesk-backup-${payload.createdAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;

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
              className={`flex items-center gap-3 w-full text-left px-4 py-3 rounded-xl transition-colors ${activeTab === tab.id ? 'bg-accent-600/10 text-accent-400 font-medium' : 'text-muted hover:bg-surface-hover hover:text-primary'}`}
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
                  <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.orgName')}</label>
                  <input
                    type="text"
                    value={orgName}
                    onChange={(e) => { setOrgName(e.target.value); logSetting('orgName', e.target.value); }}
                    className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.inn')}</label>
                  <input
                    type="text"
                    value={orgInn}
                    onChange={(e) => { setOrgInn(e.target.value); logSetting('orgInn', e.target.value); }}
                    className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.director')}</label>
                  <input
                    type="text"
                    value={orgDirector}
                    onChange={(e) => { setOrgDirector(e.target.value); logSetting('orgDirector', e.target.value); }}
                    className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.dateFormat')}</label>
                    <select
                      value={dateFormat}
                      onChange={(e) => { setDateFormat(e.target.value as any); logSetting('dateFormat', e.target.value); }}
                      className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                    >
                      <option value="dd.MM.yyyy">31.12.2026</option>
                      <option value="yyyy-MM-dd">2026-12-31</option>
                      <option value="MM/dd/yyyy">12/31/2026</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.general.startScreen')}</label>
                    <select
                      value={startScreen}
                      onChange={(e) => { setStartScreen(e.target.value); logSetting('startScreen', e.target.value); }}
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
                <div>
                  <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.language')}</label>
                  <select 
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
                  <label className="block text-sm font-medium mb-2 text-secondary">{t('docgen.docxTemplate')}</label>
                  <input
                    type="text"
                    value={docxTemplatePath}
                    onChange={(e) => { setDocxTemplatePath(e.target.value); logSetting('docxTemplatePath', e.target.value); }}
                    className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                  />
                  <p className="text-xs text-muted mt-2">{t('docgen.docxHint')}</p>
                </div>

                <div className="pt-2 border-t border-[var(--border-color)]">
                  <h4 className="text-sm font-semibold text-primary mt-4 mb-4">{t('settings.currency.title')}</h4>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.currency.symbol')}</label>
                      <input
                        type="text"
                        value={currencySymbol}
                        maxLength={8}
                        onChange={(e) => setCurrencySymbol(e.target.value)}
                        className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.currency.position')}</label>
                      <select
                        value={currencyPosition}
                        onChange={(e) => setCurrencyPosition(e.target.value as CurrencyPosition)}
                        className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                      >
                        <option value="prefix">{t('settings.currency.prefix')}</option>
                        <option value="suffix">{t('settings.currency.suffix')}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.currency.decimals')}</label>
                      <select
                        value={currencyDecimals}
                        onChange={(e) => setCurrencyDecimals(Number(e.target.value) as CurrencyDecimals)}
                        className="w-full bg-surface border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                      >
                        <option value={0}>0</option>
                        <option value={2}>2</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.currency.separator')}</label>
                      <select
                        value={thousandsSeparator}
                        onChange={(e) => setThousandsSeparator(e.target.value as ThousandsSeparator)}
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
                    {t('settings.currency.preview')}: <span className="text-primary tabular-nums font-medium">{money.format(1234567.89)}</span>
                  </p>
                </div>

                <div className="pt-4">
                  <button className="bg-accent-600 hover:bg-accent-700 text-white px-6 py-2.5 rounded-xl font-medium transition-colors">
                    {t('common.save')}
                  </button>
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
                <p className="text-sm text-muted mb-6">{t('settings.password.hint')}</p>

                <div className="space-y-4 max-w-xl">
                  <div>
                    <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.password.current')}</label>
                    <div className="relative">
                      <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder={t('settings.password.currentPlaceholder')} className="w-full bg-input border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500" />
                      <button className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary">
                        <Eye className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.password.new')}</label>
                    <div className="relative">
                      <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder={t('settings.password.minChars')} className="w-full bg-input border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500" />
                      <button className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary">
                        <Eye className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.password.confirm')}</label>
                    <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder={t('settings.password.confirmPlaceholder')} className="w-full bg-input border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500" />
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
                      await api.changePassword(user?.email || '', currentPassword, newPassword);
                      notify.success(t('settings.password.success'));
                      setCurrentPassword('');
                      setNewPassword('');
                      setConfirmPassword('');
                    } catch (e) {
                      notify.error(e instanceof Error ? e.message : t('settings.password.error'));
                    }
                  }} className="bg-accent-500 hover:bg-accent-600 text-white px-6 py-2.5 rounded-xl font-medium transition-colors mt-2 text-sm">
                    {t('settings.password.save')}
                  </button>
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
                <p className="text-sm text-muted mb-6">{t('settings.security.askPasswordHint')}</p>

                <label className="flex items-center gap-3 cursor-pointer w-fit">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={requirePassword}
                    onClick={() => { setRequirePassword(!requirePassword); logSetting('requirePassword', String(!requirePassword)); }}
                    className={`relative w-11 h-6 rounded-full transition-colors ${requirePassword ? 'bg-accent-600' : 'bg-surface-3 border border-line'}`}
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
                    <label className="block text-sm font-medium mb-2 text-secondary">{t('settings.security.lockTimeout')}</label>
                    <select
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
                  <h3 className="text-lg font-medium text-rose-500">{t('settings.security.resetTitle')}</h3>
                </div>
                <p className="text-sm text-muted mb-6">{t('settings.security.resetHint')}</p>

                <div className="space-y-6 max-w-2xl">
                  {/* Ступень 1-2: настройки. Данные не затрагиваются, пароль не нужен. */}
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={() => { resetAppearance(); logSetting('reset', 'appearance'); }}
                      className="bg-surface-3 hover:bg-surface-hover border border-line text-secondary px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                    >
                      {t('settings.security.resetAppearance')}
                    </button>
                    <button
                      onClick={() => { resetSettings(); logSetting('reset', 'settings'); }}
                      className="bg-surface-3 hover:bg-surface-hover border border-line text-secondary px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                    >
                      {t('settings.security.resetSettings')}
                    </button>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2 text-rose-400/80">{t('settings.security.adminPassword')}</label>
                    <input
                      type="password"
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      placeholder={t('settings.security.adminPasswordPlaceholder')}
                      className="w-full bg-input border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-rose-500 text-primary"
                    />
                    <p className="text-xs text-muted mt-2">{t('settings.security.passwordNeeded')}</p>
                  </div>

                  {/* Ступень 3: данные выбранных модулей. */}
                  <div className="border-t border-line pt-6">
                    <h4 className="text-sm font-semibold text-primary mb-3">{t('settings.security.clearModules')}</h4>
                    <div className="flex flex-wrap gap-2 mb-4">
                      {MODULE_TABLES.map(({ table, label }) => (
                        <button
                          key={table}
                          onClick={() => toggleModule(table)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${modulesToClear.includes(table) ? 'bg-rose-500/20 text-rose-400 border-rose-500/40' : 'bg-surface-3 text-muted border-line hover:bg-surface-hover'}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={handleClearModules}
                      disabled={modulesToClear.length === 0 || !resetPassword}
                      className="bg-rose-500/10 text-rose-500 border border-rose-500/20 hover:bg-rose-500/20 disabled:opacity-50 px-6 py-2.5 rounded-xl text-sm font-medium transition-colors"
                    >
                      {t('settings.security.clearBtn')}
                    </button>
                  </div>

                  {/* Ступень 4: полный сброс. Пароль + фраза + предложение бэкапа. */}
                  <div className="border-t border-line pt-6">
                    <h4 className="text-sm font-semibold text-rose-500 mb-3">{t('settings.security.factoryTitle')}</h4>
                    <p className="text-xs text-muted mb-3">{t('settings.security.factoryHint', { phrase: FACTORY_PHRASE })}</p>
                    <input
                      type="text"
                      value={factoryPhrase}
                      onChange={(e) => setFactoryPhrase(e.target.value)}
                      placeholder={FACTORY_PHRASE}
                      className="w-full bg-input border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 focus:border-rose-500 text-primary mb-4"
                    />
                  <button
                    onClick={handleFactoryReset}
                    disabled={!resetPassword || factoryPhrase.trim() !== FACTORY_PHRASE}
                    className="bg-rose-500/20 text-rose-500 border border-rose-500/30 hover:bg-rose-500/30 disabled:opacity-50 px-6 py-2.5 rounded-xl text-sm font-medium transition-colors"
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
                  <button className="flex items-center gap-2 text-secondary hover:text-primary transition-colors text-sm font-medium">
                    <Download className="w-4 h-4" /> {t('common.export')}
                  </button>
                </div>

                <div className="bg-surface-2 border border-line rounded-2xl overflow-hidden">
                  <div className="p-4 border-b border-line flex items-end gap-4 bg-surface">
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-muted mb-2">{t('settings.audit.actionType')}</label>
                      <select
                        value={auditAction}
                        onChange={(e) => setAuditAction(e.target.value)}
                        className="w-full bg-app border border-line rounded-xl px-4 py-2 text-sm focus:outline-none text-secondary"
                      >
                        <option value="all">{t('settings.audit.all')}</option>
                        {auditActions.map(a => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-muted mb-2">{t('settings.audit.entity')}</label>
                      <select
                        value={auditEntity}
                        onChange={(e) => setAuditEntity(e.target.value)}
                        className="w-full bg-app border border-line rounded-xl px-4 py-2 text-sm focus:outline-none text-secondary"
                      >
                        <option value="all">{t('settings.audit.all')}</option>
                        {auditEntities.map(e => <option key={e} value={e}>{e}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-muted mb-2">{t('settings.audit.dateFrom')}</label>
                      <input
                        type="date"
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
                      className="bg-accent-500/20 text-accent-400 border border-accent-500/30 hover:bg-accent-500/30 px-6 py-2 rounded-xl text-sm font-medium transition-colors h-[38px]"
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
                          <td className="p-table text-table whitespace-nowrap">{a.ts.replace('T', ' ').slice(0, 19)}</td>
                          {/* Приложение однопользовательское: действующее лицо — владелец устройства. */}
                          <td className="p-table text-accent-400">{user?.name || t('user.owner')}</td>
                          <td className="p-table text-table">{a.action}</td>
                          <td className="p-table text-table">{a.entity}</td>
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
                  <p className="text-sm text-muted">{t('settings.backup.autoInfo')} <span className="bg-surface-3 px-1.5 py-0.5 rounded text-secondary text-xs">/app/backups</span></p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <input
                    type="file"
                    accept="application/json,.json"
                    ref={restoreInputRef}
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
                  <button className="text-muted hover:text-secondary transition-colors">
                    <RefreshCw className="w-4 h-4" />
                  </button>
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
                          <td className="p-table text-accent-400">{b.fileName}</td>
                          <td className="p-table text-table">{t('settings.backup.rows', { n: b.rows })}</td>
                          <td className="p-table text-table">{b.createdAt.replace('T', ' ').slice(0, 19)}</td>
                          <td className="p-table text-right">
                            <button
                              onClick={() => removeFrom(TABLES.backups, b.id)}
                              className="text-rose-400 hover:text-rose-300"
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
                      onClick={() => { setTheme(tOpt); logSetting('theme', tOpt); }}
                      className={`relative p-6 rounded-2xl border flex flex-col items-center justify-center gap-3 transition-colors ${
                        theme === tOpt 
                          ? 'border-accent-500 bg-accent-500/10 text-accent-400' 
                          : 'border-line bg-surface-2 hover:bg-surface-hover text-muted'
                      }`}
                    >
                      {tOpt === 'light' ? <Sun className="w-6 h-6" /> : tOpt === 'dark' ? <Moon className="w-6 h-6" /> : <Monitor className="w-6 h-6" />}
                      <span className="text-sm font-medium">{tOpt === 'light' ? t('settings.light') : tOpt === 'dark' ? t('settings.dark') : t('settings.system')}</span>
                      {theme === tOpt && <div className="absolute bottom-3"><Check className="w-4 h-4 text-accent-400" /></div>}
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
                        {...clickable(() => { setAccentColor(color); logSetting('accentColor', color); }, color)}
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
                      {...clickable(() => { setDensity(d); logSetting('density', d); }, d)}
                      className={`rounded-xl p-4 cursor-pointer transition-colors ${
                        density === d 
                          ? 'border border-accent-500 bg-accent-500/10' 
                          : 'border border-line bg-input hover:bg-surface-hover'
                      }`}
                    >
                      <p className={`font-medium text-sm ${density === d ? 'text-accent-400' : 'text-primary'}`}>
                        {d === 'compact' ? t('settings.appearance.compact') : d === 'standard' ? t('settings.appearance.standard') : t('settings.appearance.spacious')}
                      </p>
                      <p className={`text-xs mt-1 ${density === d ? 'text-accent-400/70' : 'text-muted'}`}>
                        {d === 'compact' ? t('settings.appearance.compactHint') : d === 'standard' ? t('settings.appearance.standardHint') : t('settings.appearance.spaciousHint')}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border border-line rounded-2xl p-6 bg-surface-2">
                <h3 className="text-sm font-medium mb-6 text-primary">{t('settings.appearance.fontSize')}</h3>
                <div className="flex items-center gap-4 px-2">
                  <span className="text-xs font-medium text-muted cursor-pointer" {...clickable(() => { setFontSize('small'); logSetting('fontSize', 'small'); }, 'A')}>A</span>
                  <div className="flex-1 relative h-2 bg-surface-3 rounded-full flex items-center">
                    <div className="absolute top-0 left-0 h-full bg-accent-500 rounded-full transition-all" style={{ width: fontSize === 'small' ? '0%' : fontSize === 'standard' ? '50%' : '100%' }}></div>
                    
                    <div
                      {...clickable(() => { setFontSize('small'); logSetting('fontSize', 'small'); }, 'small')}
                      className={`absolute left-0 w-4 h-4 rounded-full cursor-pointer -translate-x-1/2 ${fontSize === 'small' ? 'bg-accent-400 ring-4 ring-accent-500/30 shadow-sm' : 'bg-transparent'}`}
                    ></div>
                    <div
                      {...clickable(() => { setFontSize('standard'); logSetting('fontSize', 'standard'); }, 'standard')}
                      className={`absolute left-1/2 w-4 h-4 rounded-full cursor-pointer -translate-x-1/2 ${fontSize === 'standard' ? 'bg-accent-400 ring-4 ring-accent-500/30 shadow-sm' : 'bg-transparent'}`}
                    ></div>
                    <div
                      {...clickable(() => { setFontSize('large'); logSetting('fontSize', 'large'); }, 'large')}
                      className={`absolute left-full w-4 h-4 rounded-full cursor-pointer -translate-x-1/2 ${fontSize === 'large' ? 'bg-accent-400 ring-4 ring-accent-500/30 shadow-sm' : 'bg-transparent'}`}
                    ></div>
                  </div>
                  <span className="text-lg font-medium text-muted cursor-pointer" {...clickable(() => { setFontSize('large'); logSetting('fontSize', 'large'); }, 'A')}>A</span>
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
