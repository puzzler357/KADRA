/**
 * Лицензия глазами окна: то, что вычислила оболочка Tauri, и ничего больше.
 *
 * Здесь ничего не решается. Режим, который действительно что-то значит,
 * держит охрана базы в Rust (src-tauri/src/db/guard.rs): изменённый бандл,
 * объявивший здесь FULL, всё равно получит отказ на каждую запись. Стор нужен
 * интерфейсу — объяснить состояние и предложить один понятный следующий шаг.
 *
 * Ни одна команда не принимает от окна ни состояния, ни режима, ни путей к
 * файлам: диалоги открытия и сохранения показывает сама оболочка.
 */
import { create } from 'zustand';
import i18n from '../i18n';
import { isTauri } from '../data';

export type LicenseState =
  | 'UNLICENSED' | 'INVALID' | 'MACHINE_MISMATCH' | 'REBIND_REQUIRED' | 'STATE_MISSING'
  | 'VERSION_NOT_COVERED' | 'CLOCK_ROLLBACK' | 'REVOKED' | 'EXPIRED' | 'LEASE_EXPIRED'
  | 'GRACE' | 'ACTIVE'
  /** Браузерный режим для разработки: лицензирование там не действует. */
  | 'WEB';

export type Plan = 'PERPETUAL' | 'ANNUAL' | 'QUARTERLY' | 'MONTHLY';
export type ActivationMode = 'ONLINE' | 'OFFLINE';

export interface LicenseSummary {
  license_id: string;
  customer_name: string;
  edition: string;
  features: string[];
  plan: Plan;
  activation_mode: ActivationMode;
  seats: number;
  activation_id: string;
  device_name: string;
  revision: number;
  issued_at: string;
  paid_until: string | null;
  grace_days: number;
  lease_until: string | null;
  max_version: string | null;
}

export interface LicenseStatus {
  state: LicenseState;
  mode: 'FULL' | 'READ_ONLY';
  reason: string | null;
  license: LicenseSummary | null;
  device_name: string;
  has_device_key: boolean;
  last_check: string | null;
  days_past_paid: number | null;
  grace_days_left: number | null;
  paid_warning_days: number | null;
  lease_warning_days: number | null;
  anomalies: number;
  /** Владелец ещё не создан: в режиме «только чтение» показать нечего. */
  database_empty: boolean;
  /** После проверки через интернет — чем она закончилась. */
  outcome?: { ok: boolean; message: string };
}

const WEB_STATUS: LicenseStatus = {
  state: 'WEB',
  mode: 'FULL',
  reason: null,
  license: null,
  device_name: '',
  has_device_key: false,
  last_check: null,
  days_past_paid: null,
  grace_days_left: null,
  paid_warning_days: null,
  lease_warning_days: null,
  anomalies: 0,
  database_empty: false,
};

async function shell<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    // Команды отвечают отказом в виде фразы, готовой для пользователя.
    throw error instanceof Error ? error : new Error(String(error));
  }
}

interface LicenseStore {
  /** null — оболочка ещё не ответила. */
  status: LicenseStatus | null;
  appVersion: string;
  isReadOnly: () => boolean;

  /** Первая загрузка и подписка на изменения из Rust. Повторный вызов ничего не делает. */
  init: () => Promise<void>;
  load: () => Promise<void>;
  /** «Проверить лицензию»: онлайн-лицензию спрашивает у сервера. */
  refresh: () => Promise<{ ok: boolean; message: string } | undefined>;
  activateOnline: (licenseKey: string) => Promise<void>;
  /** false — диалог выбора файла закрыт без выбора. */
  importFile: () => Promise<boolean>;
  exportRequest: (kind: 'ACTIVATE' | 'REBIND', licenseKey?: string) => Promise<boolean>;
  /** 'online' — место освобождает сервер; 'file' — файл подтверждения для продавца. */
  deactivate: (how: 'online' | 'file') => Promise<boolean>;
}

let initialised = false;

export const useLicenseStore = create<LicenseStore>()((set, get) => ({
  status: isTauri ? null : WEB_STATUS,
  appVersion: '',
  isReadOnly: () => get().status?.mode === 'READ_ONLY',

  init: async () => {
    if (!isTauri || initialised) return;
    initialised = true;

    // Rust сообщает о каждом изменении: истечение, замеченное получасовой
    // проверкой, импорт, отзыв. В событии нет database_empty, поэтому статус
    // перечитывается целиком.
    const { listen } = await import('@tauri-apps/api/event');
    await listen('license://changed', () => {
      get().load().catch((error) => console.error('[License] status', error));
    });

    shell<string>('get_app_version').then((appVersion) => set({ appVersion })).catch(() => undefined);
    await get().load();
  },

  load: async () => {
    if (!isTauri) return;
    set({ status: await shell<LicenseStatus>('license_status') });
  },

  refresh: async () => {
    if (!isTauri) return undefined;
    const next = await shell<LicenseStatus>('license_refresh');
    set({ status: next });
    return next.outcome;
  },

  activateOnline: async (licenseKey) => {
    await shell('license_activate_online', { licenseKey });
    await get().load();
  },

  importFile: async () => {
    const done = await shell<unknown | null>('license_import', { title: i18n.t('license.dialog.openLicense') });
    await get().load();
    return done !== null;
  },

  exportRequest: async (kind, licenseKey) => {
    const done = await shell<unknown | null>('license_export_request', {
      kind,
      licenseKey: licenseKey ?? null,
      title: i18n.t('license.dialog.saveRequest'),
    });
    await get().load();
    return done !== null;
  },

  deactivate: async (how) => {
    const done = await shell<unknown | null>('license_deactivate', {
      online: how === 'online',
      title: i18n.t('license.dialog.saveProof'),
    });
    await get().load();
    return done !== null;
  },
}));
