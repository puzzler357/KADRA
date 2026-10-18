import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n from '../i18n';
import { setAuthToken } from '../data';
import { DEFAULT_CURRENCY } from '../lib/money';
import type { CurrencyDecimals, CurrencyPosition, ThousandsSeparator } from '../lib/money';

type Theme = 'light' | 'dark' | 'system';
/** Формат отображения дат: строка шаблона date-fns. */
export type DateFormat = 'dd.MM.yyyy' | 'yyyy-MM-dd' | 'MM/dd/yyyy';
type AccentColor = 'indigo' | 'purple' | 'blue' | 'emerald' | 'rose' | 'amber';
type Density = 'compact' | 'standard' | 'spacious';
type FontSize = 'small' | 'standard' | 'large';

interface User {
  id: string;
  email: string;
  role: Role;
  name: string;
}

interface AppState {
  theme: Theme;
  accentColor: AccentColor;
  density: Density;
  fontSize: FontSize;
  language: string;
  sidebarOpen: boolean;
  user: User | null;
  token: string | null;

  // Формат денежных сумм — «Настройки → Общие».
  currencySymbol: string;
  currencyPosition: CurrencyPosition;
  currencyDecimals: CurrencyDecimals;
  thousandsSeparator: ThousandsSeparator;
  setCurrencySymbol: (symbol: string) => void;
  setCurrencyPosition: (position: CurrencyPosition) => void;
  setCurrencyDecimals: (decimals: CurrencyDecimals) => void;
  setThousandsSeparator: (separator: ThousandsSeparator) => void;

  /** Путь к .docx-бланку для генерации документов (см. scripts/makeDocxTemplate.ts). */
  docxTemplatePath: string;
  setDocxTemplatePath: (path: string) => void;

  // Реквизиты организации и общие параметры.
  orgName: string;
  orgInn: string;
  orgDirector: string;
  dateFormat: DateFormat;
  startScreen: string;
  /** Годовая норма отпуска, календарных дней. */
  annualVacationDays: number;
  setOrgName: (value: string) => void;
  setOrgInn: (value: string) => void;
  setOrgDirector: (value: string) => void;
  setDateFormat: (value: DateFormat) => void;
  setStartScreen: (value: string) => void;
  setAnnualVacationDays: (value: number) => void;

  /**
   * Запрашивать пароль при входе. Источник истины — учётная запись в базе
   * (Настройки → Безопасность); здесь только её отражение на время работы.
   * В localStorage не пишется: иначе очистка данных браузера выключала бы его.
   */
  requirePassword: boolean;
  setRequirePassword: (value: boolean) => void;
  /**
   * Прежние версии хранили запрос пароля в localStorage. При первом запуске
   * новой версии это пожелание один раз переносится в базу (см. App.tsx).
   */
  pendingRequirePasswordSync: boolean;
  clearPendingRequirePasswordSync: () => void;

  // Блокировка по бездействию. 0 — выключена. Работает только когда включён
  // пароль при входе: снимать блокировку всё равно нечем.
  lockTimeoutMinutes: number;
  locked: boolean;
  setLockTimeoutMinutes: (minutes: number) => void;
  lock: () => void;
  unlock: () => void;

  /** Сброс оформления к значениям по умолчанию (тема, акцент, плотность, шрифт). */
  resetAppearance: () => void;
  /** Сброс всех настроек приложения к заводским. Данные не трогает. */
  resetSettings: () => void;
  /**
   * Сброс параметров организации (реквизиты, валюта, формат даты, стартовый
   * экран). Выполняется вместе с полным сбросом данных; оформление и язык —
   * личные предпочтения — остаются.
   */
  resetOrganizationSettings: () => void;
  setTheme: (theme: Theme) => void;
  setAccentColor: (color: AccentColor) => void;
  setDensity: (density: Density) => void;
  setFontSize: (size: FontSize) => void;
  setLanguage: (lang: string) => void;
  toggleSidebar: () => void;
  login: (user: User, token: string) => void;
  logout: () => void;
}

// Приложение однопользовательское: единственная роль — владелец устройства.
export type Role = 'ADMIN';

// Значения по умолчанию вынесены, чтобы сброс настроек и инициализация
// стора не разъезжались.
const APPEARANCE_DEFAULTS = {
  theme: 'dark' as Theme,
  accentColor: 'indigo' as AccentColor,
  density: 'standard' as Density,
  fontSize: 'standard' as FontSize,
};

const ORGANIZATION_DEFAULTS = {
  currencySymbol: DEFAULT_CURRENCY.currencySymbol,
  currencyPosition: DEFAULT_CURRENCY.currencyPosition,
  currencyDecimals: DEFAULT_CURRENCY.currencyDecimals,
  thousandsSeparator: DEFAULT_CURRENCY.thousandsSeparator,
  docxTemplatePath: '/templates/blank.docx',
  orgName: 'KADRA',
  orgInn: '',
  orgDirector: '',
  dateFormat: 'dd.MM.yyyy' as DateFormat,
  startScreen: '/dashboard',
  annualVacationDays: 24,
};

const SETTINGS_DEFAULTS = {
  ...ORGANIZATION_DEFAULTS,
  language: 'ru',
  sidebarOpen: true,
  lockTimeoutMinutes: 15,
};

// ---- Сессия ----
//
// Вошедший владелец и состояние блокировки хранятся в sessionStorage: они
// переживают перезагрузку страницы (F5), но не закрытие окна. Раньше сессия
// лежала в localStorage вместе с настройками и жила вечно — запрос пароля
// при запуске не появлялся никогда.
const SESSION_KEY = 'kadra-session';

interface SessionState {
  user: User | null;
  token: string | null;
  locked: boolean;
}

function readSession(): SessionState {
  try {
    const raw = typeof window !== 'undefined' ? window.sessionStorage.getItem(SESSION_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SessionState>;
      return { user: parsed.user ?? null, token: parsed.token ?? null, locked: Boolean(parsed.locked) };
    }
  } catch {
    /* хранилище недоступно — начинаем без сессии */
  }
  return { user: null, token: null, locked: false };
}

function writeSession(session: SessionState): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* приватный режим или запрет на хранилище — сессия живёт в памяти */
  }
}

const initialSession = readSession();
setAuthToken(initialSession.token);

// «Системная» тема следит за настройкой ОС на лету, а не только при выборе.
// Объявлено до создания стора: persist восстанавливает состояние синхронно,
// прямо в create(), и onRehydrateStorage уже вызывает applyTheme. Объявление
// ниже давало ReferenceError — восстановление обрывалось, и при запуске не
// применялись ни язык, ни акцент, ни плотность.
let systemThemeQuery: MediaQueryList | null = null;
const onSystemThemeChange = () => {
  if (useAppStore.getState().theme === 'system') applyTheme('system');
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      ...APPEARANCE_DEFAULTS,
      language: 'ru',
      sidebarOpen: true,
      user: initialSession.user,
      token: initialSession.token,

      currencySymbol: DEFAULT_CURRENCY.currencySymbol,
      currencyPosition: DEFAULT_CURRENCY.currencyPosition,
      currencyDecimals: DEFAULT_CURRENCY.currencyDecimals,
      thousandsSeparator: DEFAULT_CURRENCY.thousandsSeparator,
      setCurrencySymbol: (currencySymbol) => set({ currencySymbol }),
      setCurrencyPosition: (currencyPosition) => set({ currencyPosition }),
      setCurrencyDecimals: (currencyDecimals) => set({ currencyDecimals }),
      setThousandsSeparator: (thousandsSeparator) => set({ thousandsSeparator }),

      docxTemplatePath: ORGANIZATION_DEFAULTS.docxTemplatePath,
      setDocxTemplatePath: (docxTemplatePath) => set({ docxTemplatePath }),

      orgName: ORGANIZATION_DEFAULTS.orgName,
      orgInn: '',
      orgDirector: '',
      dateFormat: ORGANIZATION_DEFAULTS.dateFormat,
      startScreen: ORGANIZATION_DEFAULTS.startScreen,
      annualVacationDays: ORGANIZATION_DEFAULTS.annualVacationDays,
      setOrgName: (orgName) => set({ orgName }),
      setOrgInn: (orgInn) => set({ orgInn }),
      setOrgDirector: (orgDirector) => set({ orgDirector }),
      setDateFormat: (dateFormat) => set({ dateFormat }),
      setStartScreen: (startScreen) => set({ startScreen }),
      setAnnualVacationDays: (annualVacationDays) =>
        set({ annualVacationDays: Math.max(0, Math.min(366, Math.round(annualVacationDays) || 0)) }),

      requirePassword: false,
      // Выключение пароля заодно снимает блокировку: иначе владелец остался бы
      // заперт на экране, который больше нечем открыть.
      setRequirePassword: (requirePassword) =>
        set(requirePassword ? { requirePassword } : { requirePassword, locked: false }),
      pendingRequirePasswordSync: false,
      clearPendingRequirePasswordSync: () => set({ pendingRequirePasswordSync: false }),

      lockTimeoutMinutes: 15,
      locked: initialSession.locked,
      setLockTimeoutMinutes: (lockTimeoutMinutes) => set({ lockTimeoutMinutes }),
      lock: () => set({ locked: true }),
      unlock: () => set({ locked: false }),

      resetAppearance: () => {
        set(APPEARANCE_DEFAULTS);
        applyTheme(APPEARANCE_DEFAULTS.theme);
        applyAccentColor(APPEARANCE_DEFAULTS.accentColor);
        applyDensity(APPEARANCE_DEFAULTS.density);
        applyFontSize(APPEARANCE_DEFAULTS.fontSize);
      },

      resetSettings: () => {
        // Сессия, блокировка и запрос пароля сюда не входят: сброс настроек не
        // должен ни разлогинивать владельца, ни менять защиту входа.
        set({ ...APPEARANCE_DEFAULTS, ...SETTINGS_DEFAULTS });
        applyTheme(APPEARANCE_DEFAULTS.theme);
        applyAccentColor(APPEARANCE_DEFAULTS.accentColor);
        applyDensity(APPEARANCE_DEFAULTS.density);
        applyFontSize(APPEARANCE_DEFAULTS.fontSize);
        i18n.changeLanguage(SETTINGS_DEFAULTS.language);
      },

      resetOrganizationSettings: () => set({ ...ORGANIZATION_DEFAULTS }),

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      setAccentColor: (accentColor) => {
        set({ accentColor });
        applyAccentColor(accentColor);
      },
      setDensity: (density) => {
        set({ density });
        applyDensity(density);
      },
      setFontSize: (fontSize) => {
        set({ fontSize });
        applyFontSize(fontSize);
      },
      setLanguage: (language) => {
        set({ language });
        i18n.changeLanguage(language);
      },
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      login: (user, token) => set({ user, token, locked: false }),
      logout: () => set({ user: null, token: null, locked: false }),
    }),
    {
      name: 'hr-docs-app-storage',
      version: 1,
      // Сессия и запрос пароля в localStorage не пишутся: первая живёт в
      // sessionStorage, второй — в базе.
      partialize: (state) => {
        const { user: _user, token: _token, locked: _locked, requirePassword: _require, ...rest } = state;
        return rest;
      },
      // Версия 0 хранила в localStorage вошедшего пользователя, токен,
      // блокировку и запрос пароля. Первые три выбрасываем, пожелание
      // запрашивать пароль переносим в базу при первом запуске.
      migrate: (persisted, version) => {
        const state = { ...(persisted as Record<string, unknown>) };
        if (version < 1) {
          if (state.requirePassword === true) state.pendingRequirePasswordSync = true;
          delete state.user;
          delete state.token;
          delete state.locked;
          delete state.requirePassword;
        }
        return state as unknown as AppState;
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.theme);
          applyAccentColor(state.accentColor);
          applyDensity(state.density);
          applyFontSize(state.fontSize);
          i18n.changeLanguage(state.language);
        }
      },
    }
  )
);

// Сессия — в sessionStorage, токен — в слой данных: веб-сервер с включённым
// паролем отдаёт данные только по нему.
useAppStore.subscribe((state, previous) => {
  if (state.user === previous.user && state.token === previous.token && state.locked === previous.locked) return;
  writeSession({ user: state.user, token: state.token, locked: state.locked });
  if (state.token !== previous.token) setAuthToken(state.token);
});


function applyTheme(theme: Theme) {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  if (!systemThemeQuery && typeof window.matchMedia === 'function') {
    systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    systemThemeQuery.addEventListener?.('change', onSystemThemeChange);
  }
  if (theme === 'system') {
    root.classList.add(systemThemeQuery?.matches ? 'dark' : 'light');
    return;
  }
  root.classList.add(theme);
}

function applyAccentColor(color: AccentColor) {
  const root = window.document.documentElement;
  root.classList.remove('theme-indigo', 'theme-purple', 'theme-blue', 'theme-emerald', 'theme-rose', 'theme-amber');
  root.classList.add(`theme-${color}`);
}

function applyDensity(density: Density) {
  const root = window.document.documentElement;
  root.classList.remove('density-compact', 'density-standard', 'density-spacious');
  root.classList.add(`density-${density}`);
}

function applyFontSize(size: FontSize) {
  const root = window.document.documentElement;
  root.classList.remove('text-size-small', 'text-size-standard', 'text-size-large');
  root.classList.add(`text-size-${size}`);
}


if (typeof window !== 'undefined') {
  try {
    const storedStr = localStorage.getItem('hr-docs-app-storage');
    if (storedStr) {
      const stored = JSON.parse(storedStr);
      if (stored && stored.state) {
        if (stored.state.theme) applyTheme(stored.state.theme);
        if (stored.state.accentColor) applyAccentColor(stored.state.accentColor);
        if (stored.state.density) applyDensity(stored.state.density);
        if (stored.state.fontSize) applyFontSize(stored.state.fontSize);
      }
    } else {
      applyTheme('dark');
      applyAccentColor('indigo');
      applyDensity('standard');
      applyFontSize('standard');
    }
  } catch (e) {
    console.error('Failed to restore settings', e);
  }
}
