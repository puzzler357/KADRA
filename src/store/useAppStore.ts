import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n from '../i18n';
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

  // Реквизиты организации и общие параметры. Раньше поля были нарисованы,
  // но никуда не сохранялись, а название организации жило хардкодом в шаблонах.
  orgName: string;
  orgInn: string;
  orgDirector: string;
  dateFormat: DateFormat;
  startScreen: string;
  setOrgName: (value: string) => void;
  setOrgInn: (value: string) => void;
  setOrgDirector: (value: string) => void;
  setDateFormat: (value: DateFormat) => void;
  setStartScreen: (value: string) => void;

  // Пароль при входе. Выключен по умолчанию: приложение однопользовательское
  // и лежит на устройстве владельца, поэтому гонять его через форму входа при
  // каждом запуске незачем. Включается в «Настройки → Безопасность».
  requirePassword: boolean;
  setRequirePassword: (value: boolean) => void;

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

// Значения по умолчанию вынесены, чтобы сброс настроек иинициализация
// стора не разъезжались.
const APPEARANCE_DEFAULTS = {
  theme: 'dark' as Theme,
  accentColor: 'indigo' as AccentColor,
  density: 'standard' as Density,
  fontSize: 'standard' as FontSize,
};

const SETTINGS_DEFAULTS = {
  language: 'ru',
  sidebarOpen: true,
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
  requirePassword: false,
  lockTimeoutMinutes: 15,
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: 'dark',
      accentColor: 'indigo',
      density: 'standard',
      fontSize: 'standard',
      language: 'ru',
      sidebarOpen: true,
      user: null,
      token: null,

      currencySymbol: DEFAULT_CURRENCY.currencySymbol,
      currencyPosition: DEFAULT_CURRENCY.currencyPosition,
      currencyDecimals: DEFAULT_CURRENCY.currencyDecimals,
      thousandsSeparator: DEFAULT_CURRENCY.thousandsSeparator,
      setCurrencySymbol: (currencySymbol) => set({ currencySymbol }),
      setCurrencyPosition: (currencyPosition) => set({ currencyPosition }),
      setCurrencyDecimals: (currencyDecimals) => set({ currencyDecimals }),
      setThousandsSeparator: (thousandsSeparator) => set({ thousandsSeparator }),

      docxTemplatePath: '/templates/blank.docx',
      setDocxTemplatePath: (docxTemplatePath) => set({ docxTemplatePath }),

      orgName: 'KADRA',
      orgInn: '',
      orgDirector: '',
      dateFormat: 'dd.MM.yyyy',
      startScreen: '/dashboard',
      setOrgName: (orgName) => set({ orgName }),
      setOrgInn: (orgInn) => set({ orgInn }),
      setOrgDirector: (orgDirector) => set({ orgDirector }),
      setDateFormat: (dateFormat) => set({ dateFormat }),
      setStartScreen: (startScreen) => set({ startScreen }),

      requirePassword: false,
      // Выключение пароля заодно снимает блокировку: иначе владелец остался бы
      // заперт на экране, который больше нечем открыть.
      setRequirePassword: (requirePassword) =>
        set(requirePassword ? { requirePassword } : { requirePassword, locked: false }),

      lockTimeoutMinutes: 15,
      // Состояние блокировки персистится намеренно: перезагрузка страницы не
      // должна быть способом обойти её.
      locked: false,
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
        // Сессия и блокировка сюда не входят: сброс настроек не должен
        // ни разлогинивать владельца, ни снимать блокировку.
        set({ ...APPEARANCE_DEFAULTS, ...SETTINGS_DEFAULTS });
        applyTheme(APPEARANCE_DEFAULTS.theme);
        applyAccentColor(APPEARANCE_DEFAULTS.accentColor);
        applyDensity(APPEARANCE_DEFAULTS.density);
        applyFontSize(APPEARANCE_DEFAULTS.fontSize);
        i18n.changeLanguage(SETTINGS_DEFAULTS.language);
      },
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
      login: (user, token) => set({ user, token }),
      logout: () => set({ user: null, token: null, locked: false }),
    }),
    {
      name: 'hr-docs-app-storage',
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Блокировка, сохранённая с прошлого запуска, не должна пережить
          // выключение пароля: снимать её было бы нечем.
          if (!state.requirePassword && state.locked) state.locked = false;
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

function applyTheme(theme: Theme) {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme === 'system') {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
    root.classList.add(systemTheme);
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
