/**
 * «Настройки → Лицензия» (LICENSING.md 9.2): что сказано в лицензии, в каком
 * она состоянии, и четыре действия — проверить, импортировать файл, создать
 * файл запроса, деактивировать компьютер.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDown, FileUp, KeyRound, LogOut, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { format } from 'date-fns';
import { useLicenseStore } from '../store/useLicenseStore';
import { useAppStore } from '../store/useAppStore';
import { ActivationPanel, LicenseModal, useLicenseActions } from './LicenseGate';

/** Даты в лицензии хранятся в UTC, показываются в местном времени и в формате из «Общих настроек». */
const formatWith = (pattern: string) => (value: string | null | undefined, fallback: string) =>
  value ? format(new Date(value), pattern) : fallback;

const button =
  'inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-50';
const secondary = `${button} bg-surface-3 hover:bg-surface-hover border border-line text-secondary`;
const primary = `${button} bg-accent-500 hover:bg-accent-600 text-white`;
const danger = `${button} bg-rose-500/10 text-rose-500 border border-rose-500/20 hover:bg-rose-500/20`;

export default function LicenseSettings() {
  const { t } = useTranslation();
  const { status, appVersion } = useLicenseStore();
  const dateFormat = useAppStore((state) => state.dateFormat);
  const formatDate = formatWith(dateFormat);
  const formatDateTime = formatWith(`${dateFormat} HH:mm`);
  const actions = useLicenseActions();
  const [activating, setActivating] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  if (!status) {
    return <p className="text-sm text-muted">{t('license.loading')}</p>;
  }

  const header = (
    <div className="mb-6">
      <h3 className="text-xl font-bold mb-1">{t('license.title')}</h3>
      <p className="text-sm text-muted">{t('license.subtitle')}</p>
    </div>
  );

  if (status.state === 'WEB') {
    return (
      <div className="max-w-3xl">
        {header}
        <div className="bg-surface-2 border border-line rounded-2xl p-6 text-sm text-secondary">{t('license.webOnly')}</div>
      </div>
    );
  }

  const license = status.license;
  const online = license?.activation_mode === 'ONLINE';
  const never = t('license.never');
  const healthy = status.mode === 'FULL';

  const rows: [string, string][] = license
    ? [
        [t('license.field.customer'), license.customer_name],
        [t('license.field.number'), license.license_id],
        [t('license.field.plan'), `${t(`license.plan.${license.plan}`)} · ${t(`license.mode.${license.activation_mode}`)}`],
        [t('license.field.computer'), `${license.device_name} (${license.activation_id})`],
        [t('license.field.paidUntil'), formatDate(license.paid_until, t('license.perpetual'))],
        [t('license.field.leaseUntil'), formatDate(license.lease_until, never)],
        [t('license.field.maxVersion'), license.max_version ?? t('license.anyVersion')],
        [t('license.field.lastCheck'), formatDateTime(status.last_check, never)],
        [t('license.field.appVersion'), appVersion || never],
      ]
    : [
        [t('license.field.computer'), status.device_name],
        [t('license.field.appVersion'), appVersion || never],
      ];

  return (
    <div className="max-w-3xl">
      {header}

      <div className="bg-surface-2 border border-line rounded-2xl p-6 space-y-6">
        <div
          className={`flex items-start gap-3 px-4 py-3 rounded-xl text-sm border ${
            healthy
              ? 'border-emerald-500/30 bg-emerald-500/10 text-primary'
              : 'border-rose-500/30 bg-rose-500/10 text-rose-500'
          }`}
        >
          {healthy ? (
            <ShieldCheck className="w-5 h-5 shrink-0 text-emerald-500" />
          ) : (
            <ShieldAlert className="w-5 h-5 shrink-0" />
          )}
          <div>
            <span className="font-medium">{t(`license.state.${status.state}`)}</span>
            {!healthy && <span> {t('license.banner.readOnly')}</span>}
          </div>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 text-sm">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted mb-0.5">{label}</dt>
              <dd className="text-primary font-medium break-all">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-wrap gap-3 pt-2 border-t border-line">
          <button className={`${secondary} mt-4`} disabled={actions.busy} onClick={actions.refresh}>
            <RefreshCw className="w-4 h-4" /> {t('license.action.check')}
          </button>
          <button className={`${primary} mt-4`} disabled={actions.busy} onClick={actions.importFile}>
            <FileUp className="w-4 h-4" /> {t('license.action.import')}
          </button>
          {license ? (
            <button className={`${secondary} mt-4`} disabled={actions.busy} onClick={actions.requestRebind}>
              <FileDown className="w-4 h-4" /> {t('license.action.createRequest')}
            </button>
          ) : (
            <button className={`${secondary} mt-4`} disabled={actions.busy} onClick={() => setActivating(true)}>
              <KeyRound className="w-4 h-4" /> {t('license.action.activate')}
            </button>
          )}
          {license && status.has_device_key && (
            <button className={`${danger} mt-4`} disabled={actions.busy} onClick={() => setConfirmDeactivate(true)}>
              <LogOut className="w-4 h-4" /> {t('license.action.deactivate')}
            </button>
          )}
        </div>
      </div>

      <LicenseModal
        open={activating}
        onClose={() => setActivating(false)}
        title={t('license.activate.title')}
        description={t('license.activate.subtitle')}
      >
        <ActivationPanel status={status} />
      </LicenseModal>

      <LicenseModal
        open={confirmDeactivate}
        onClose={() => setConfirmDeactivate(false)}
        title={t('license.deactivate.title')}
        description={t(online ? 'license.deactivate.descOnline' : 'license.deactivate.desc')}
      >
        <div className="flex flex-wrap justify-end gap-3">
          <button className={secondary} onClick={() => setConfirmDeactivate(false)}>
            {t('license.action.cancel')}
          </button>
          <button
            className={online ? secondary : danger}
            disabled={actions.busy}
            onClick={() => {
              setConfirmDeactivate(false);
              void actions.deactivate('file');
            }}
          >
            {t('license.action.deactivateFile')}
          </button>
          {online && (
            <button
              className={danger}
              disabled={actions.busy}
              onClick={() => {
                setConfirmDeactivate(false);
                void actions.deactivate('online');
              }}
            >
              {t('license.action.deactivateOnline')}
            </button>
          )}
        </div>
      </LicenseModal>
    </div>
  );
}
