/**
 * Экран активации и баннеры лицензии (LICENSING.md 8.2, 9.2).
 *
 * Пока владелец не создан и лицензия не действует, приложению нечего
 * показать — экран активации занимает всё окно. Когда данные есть,
 * приложение открыто для просмотра, а баннер называет причину и одно
 * действие, которое её устраняет. В обоих случаях это объяснение, а не
 * защита: записи отклоняет оболочка, что бы ни нарисовал этот компонент.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useLicenseStore } from '../store/useLicenseStore';
import type { LicenseState, LicenseStatus } from '../store/useLicenseStore';
import { useNotify } from './Toasts';

type Action = 'activate' | 'import' | 'rebind' | 'refresh' | null;

/** Единственное действие, которое выводит из каждого состояния офлайн-лицензию. */
const ACTION: Record<LicenseState, Action> = {
  UNLICENSED: 'activate',
  INVALID: 'activate',
  MACHINE_MISMATCH: 'activate',
  REBIND_REQUIRED: 'rebind',
  STATE_MISSING: 'rebind',
  VERSION_NOT_COVERED: null,
  CLOCK_ROLLBACK: 'refresh',
  REVOKED: 'import',
  EXPIRED: 'import',
  LEASE_EXPIRED: 'import',
  GRACE: 'import',
  ACTIVE: null,
  WEB: null,
};

/**
 * Онлайн-лицензия выходит из большинства состояний через сервер: оплатили,
 * вернулась сеть, переустановили Windows — «Проверить лицензию» получит
 * новый файл (повторную привязку того же компьютера сервер делает сам, 7.1).
 */
export function actionFor(status: LicenseStatus): Action {
  const online = status.license?.activation_mode === 'ONLINE';
  const serverFixes: LicenseState[] = [
    'EXPIRED', 'LEASE_EXPIRED', 'STATE_MISSING', 'CLOCK_ROLLBACK', 'REVOKED', 'GRACE', 'REBIND_REQUIRED',
  ];
  return online && serverFixes.includes(status.state) ? 'refresh' : ACTION[status.state];
}

const primaryButton =
  'bg-accent-500 hover:bg-accent-600 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-50';
const secondaryButton =
  'bg-surface-3 hover:bg-surface-hover border border-line text-secondary px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-50';

/** Действия лицензии с тостами об итоге — общие для экрана, баннера и настроек. */
export function useLicenseActions() {
  const { t } = useTranslation();
  const notify = useNotify();
  const store = useLicenseStore();
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<boolean | void>, success: string) => {
    setBusy(true);
    try {
      // false — диалог закрыли без выбора файла: сообщать не о чем.
      if ((await work()) !== false) notify.success(t(success));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    importFile: () => run(store.importFile, 'license.msg.imported'),
    activateOnline: (key: string) => run(() => store.activateOnline(key), 'license.msg.activated'),
    requestActivation: (key: string) => run(() => store.exportRequest('ACTIVATE', key), 'license.msg.requestSaved'),
    requestRebind: () => run(() => store.exportRequest('REBIND'), 'license.msg.requestSaved'),
    deactivate: (how: 'online' | 'file') =>
      run(() => store.deactivate(how), how === 'online' ? 'license.msg.deactivatedOnline' : 'license.msg.deactivated'),
    refresh: async () => {
      setBusy(true);
      try {
        const outcome = await store.refresh();
        if (!outcome) notify.success(t('license.msg.checked'));
        else if (outcome.ok) notify.success(outcome.message);
        else notify.error(outcome.message);
      } catch (error) {
        notify.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
  };
}

/** Ввод ключа, онлайн-активация и обмен файлами (5.1). */
export function ActivationPanel({ status }: { status: LicenseStatus }) {
  const { t } = useTranslation();
  const actions = useLicenseActions();
  const [licenseKey, setLicenseKey] = useState('');
  const hasKey = licenseKey.trim().length > 0;

  return (
    <div className="space-y-5">
      {status.state !== 'UNLICENSED' && (
        <p className="text-sm text-rose-500">{t(`license.state.${status.state}`)}</p>
      )}

      <div className="space-y-2">
        <label htmlFor="license-key" className="block text-sm font-medium text-secondary">
          {t('license.activate.key')}
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            id="license-key"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder="KDR-XXXXX-XXXXX-XXXXX-XXXXX"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 min-w-0 bg-input border border-line rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-500"
          />
          <button
            className={`${primaryButton} whitespace-nowrap`}
            disabled={actions.busy || !hasKey}
            onClick={() => actions.activateOnline(licenseKey)}
          >
            {t('license.action.activateOnline')}
          </button>
        </div>
      </div>

      <div className="text-xs uppercase tracking-wide text-muted pt-2">{t('license.activate.offlineTitle')}</div>
      <ol className="space-y-4 text-sm text-secondary">
        <li>
          <div className="font-medium text-primary mb-2">{t('license.activate.step1')}</div>
          <button
            className={secondaryButton}
            disabled={actions.busy || !hasKey}
            onClick={() => actions.requestActivation(licenseKey)}
          >
            {t('license.action.createRequest')}
          </button>
        </li>
        <li>
          <div className="font-medium text-primary">{t('license.activate.step2')}</div>
        </li>
        <li>
          <div className="font-medium text-primary mb-2">{t('license.activate.step3')}</div>
          <button className={secondaryButton} disabled={actions.busy} onClick={actions.importFile}>
            {t('license.action.import')}
          </button>
        </li>
      </ol>

      <p className="text-xs text-muted">
        {t('license.device')}: {status.device_name}
      </p>
    </div>
  );
}

/** Модальное окно в стиле остальных окон приложения. */
export function LicenseModal({
  open,
  title,
  description,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/50 z-[160] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="bg-surface border border-line rounded-2xl w-full max-w-lg overflow-hidden max-h-[85vh] flex flex-col shadow-2xl">
        <div className="flex justify-between items-start gap-4 p-6 border-b border-line">
          <div>
            <h3 className="text-lg font-semibold text-primary">{title}</h3>
            {description && <p className="text-sm text-muted mt-1">{description}</p>}
          </div>
          <button onClick={onClose} aria-label={t('license.action.close')} className="text-muted hover:text-primary transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function ActivationScreen({ status }: { status: LicenseStatus }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] flex items-center justify-center p-6">
      <div className="w-full max-w-lg bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-primary mb-2 flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-accent-500" />
          {t('license.activate.title')}
        </h1>
        <p className="text-sm text-muted mb-6">{t('license.activate.subtitle')}</p>
        <ActivationPanel status={status} />
      </div>
    </div>
  );
}

function bannerText(status: LicenseStatus, t: (key: string, options?: Record<string, unknown>) => string) {
  if (status.state === 'GRACE') {
    return t('license.banner.grace', { past: status.days_past_paid ?? 0, left: status.grace_days_left ?? 0 });
  }
  if (status.mode === 'READ_ONLY') {
    return `${t(`license.state.${status.state}`)} ${t('license.banner.readOnly')}`;
  }
  if (status.lease_warning_days !== null) return t('license.banner.leaseSoon', { days: status.lease_warning_days });
  if (status.paid_warning_days !== null) return t('license.banner.paidSoon', { days: status.paid_warning_days });
  return null;
}

function Banner({ status }: { status: LicenseStatus }) {
  const { t } = useTranslation();
  const actions = useLicenseActions();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);

  const text = bannerText(status, t);
  const blocking = status.mode === 'READ_ONLY';
  // Предупреждение можно убрать; сообщение о режиме «только чтение» — нет.
  if (!text || (!blocking && dismissed === text)) return null;

  const action: Action = blocking || status.state === 'GRACE'
    ? actionFor(status)
    : status.license?.activation_mode === 'ONLINE' ? 'refresh' : 'import';
  const button = {
    activate: { label: 'license.action.activate', onClick: () => setActivating(true) },
    import: { label: 'license.action.import', onClick: actions.importFile },
    rebind: { label: 'license.action.createRequest', onClick: actions.requestRebind },
    refresh: { label: 'license.action.check', onClick: actions.refresh },
  }[action ?? 'refresh'];
  const Icon = blocking ? ShieldAlert : Clock;

  return (
    <>
      <div
        role={blocking ? 'alert' : 'status'}
        className={`no-print mx-8 mb-4 flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${
          blocking ? 'border-rose-500/30 bg-rose-500/10' : 'border-amber-500/30 bg-amber-500/10'
        }`}
      >
        <Icon className={`w-5 h-5 shrink-0 ${blocking ? 'text-rose-500' : 'text-amber-500'}`} />
        <span className="flex-1 text-primary">{text}</span>
        {action && (
          <button
            className={`${blocking ? primaryButton : secondaryButton} !py-1.5 whitespace-nowrap`}
            disabled={actions.busy}
            onClick={button.onClick}
          >
            {t(button.label)}
          </button>
        )}
        {status.state === 'CLOCK_ROLLBACK' && (
          <button className={`${secondaryButton} !py-1.5 whitespace-nowrap`} disabled={actions.busy} onClick={actions.importFile}>
            {t('license.action.import')}
          </button>
        )}
        {!blocking && (
          <button
            aria-label={t('license.action.close')}
            onClick={() => setDismissed(text)}
            className="text-muted hover:text-primary"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <LicenseModal
        open={activating}
        onClose={() => setActivating(false)}
        title={t('license.activate.title')}
        description={t('license.activate.subtitle')}
      >
        <ActivationPanel status={status} />
      </LicenseModal>
    </>
  );
}

export default function LicenseGate({ children }: { children: ReactNode }) {
  const { status, init } = useLicenseStore();

  useEffect(() => {
    init().catch((error) => console.error('[License] init', error));
  }, [init]);

  // Пока оболочка не ответила, не показываем ничего: иначе на долю секунды
  // мелькнул бы экран создания владельца, который активация тут же заменит.
  if (!status) return <div className="min-h-screen bg-[var(--background)]" />;
  // Браузерный режим для разработки: добавлять нечего.
  if (status.state === 'WEB') return <>{children}</>;

  if (status.mode === 'READ_ONLY' && status.database_empty) {
    return <ActivationScreen status={status} />;
  }

  return <>{children}</>;
}

/** Баннер лицензии для разметки приложения (Layout). */
export function LicenseBanner() {
  const status = useLicenseStore((state) => state.status);
  if (!status || status.state === 'WEB') return null;
  return <Banner status={status} />;
}
