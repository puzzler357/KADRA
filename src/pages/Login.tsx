import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/useAppStore';
import * as api from '../data';
import PasswordInput from '../components/PasswordInput';
import { Monitor, Moon, Sun, Lock, Mail, User } from 'lucide-react';

const fieldClass = 'block w-full pl-10 pr-3 py-2 border border-[var(--border-color)] rounded-xl bg-[var(--background)] focus:outline-none focus:ring-2 focus:ring-accent-500 sm:text-sm';

export default function Login() {
  const { t } = useTranslation();
  const { theme, setTheme, login } = useAppStore();

  // Пока владельца нет, вход показывать не из чего: приложение поставляется
  // без пароля по умолчанию, и первый экран — создание учётной записи.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.authStatus()
      .then(status => setNeedsSetup(status.needsSetup))
      // Если статус не получен, показываем обычный вход: он хотя бы сообщит
      // внятную ошибку, а экран настройки при существующем владельце — нет.
      .catch(() => setNeedsSetup(false));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.login(email, password);
      login(data.user, data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError(t('login.passwordShort'));
      return;
    }
    if (password !== repeat) {
      setError(t('login.passwordMismatch'));
      return;
    }

    setLoading(true);
    try {
      const data = await api.setupOwner(name, email, password);
      login(data.user, data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="absolute top-4 right-4 flex items-center p-1 bg-surface-3 dark:bg-slate-800 rounded-xl border border-[var(--border-color)]">
        <button
          onClick={() => setTheme('light')}
          className={`p-1.5 rounded-lg transition-colors ${theme === 'light' ? 'bg-white dark:bg-slate-700 shadow-sm text-accent-600 dark:text-accent-400' : 'text-muted hover:text-primary dark:hover:text-slate-300'}`}
          title={t('settings.light')}
        >
          <Sun className="w-4 h-4" />
        </button>
        <button
          onClick={() => setTheme('system')}
          className={`p-1.5 rounded-lg transition-colors ${theme === 'system' ? 'bg-white dark:bg-slate-700 shadow-sm text-accent-600 dark:text-accent-400' : 'text-muted hover:text-primary dark:hover:text-slate-300'}`}
          title={t('settings.system')}
        >
          <Monitor className="w-4 h-4" />
        </button>
        <button
          onClick={() => setTheme('dark')}
          className={`p-1.5 rounded-lg transition-colors ${theme === 'dark' ? 'bg-white dark:bg-slate-700 shadow-sm text-accent-600 dark:text-accent-400' : 'text-muted hover:text-primary dark:hover:text-slate-300'}`}
          title={t('settings.dark')}
        >
          <Moon className="w-4 h-4" />
        </button>
      </div>

      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <h2 className="mt-6 flex justify-center">
          <img src="/brand/kadra-logo.png" alt={t('app_name')} className="h-24 w-auto dark:hidden" />
          <img src="/brand/kadra-logo-light.png" alt={t('app_name')} className="h-24 w-auto hidden dark:block" />
        </h2>
        <p className="mt-2 text-center text-sm text-muted">
          {needsSetup ? t('login.setupSubtitle') : t('login.subtitle')}
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-[var(--sidebar-bg)] py-8 px-4 shadow-sm border border-[var(--border-color)] sm:rounded-2xl sm:px-10">
          {needsSetup === null ? (
            <p className="text-center text-sm text-muted py-6">{t('common.loading')}</p>
          ) : (
            <form className="space-y-6" onSubmit={needsSetup ? handleSetup : handleLogin}>
              {needsSetup && (
                <h3 className="text-lg font-semibold text-primary text-center">{t('login.setupTitle')}</h3>
              )}

              {error && (
                <div className="bg-rose-50 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400 p-3 rounded-xl text-sm text-center">
                  {error}
                </div>
              )}

              {needsSetup && (
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-secondary dark:text-slate-300">
                    {t('login.ownerName')}
                  </label>
                  <div className="mt-1 relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <User className="h-5 w-5 text-muted" />
                    </div>
                    <input
                      id="name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className={fieldClass}
                    />
                  </div>
                </div>
              )}

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-secondary dark:text-slate-300">
                  Email
                </label>
                <div className="mt-1 relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Mail className="h-5 w-5 text-muted" />
                  </div>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={fieldClass}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-secondary dark:text-slate-300">
                  {needsSetup ? t('login.newPassword') : t('login.password')}
                </label>
                <div className="mt-1 relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Lock className="h-5 w-5 text-muted" />
                  </div>
                  <PasswordInput
                    id="password"
                    name="password"
                    autoComplete={needsSetup ? 'new-password' : 'current-password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={fieldClass}
                  />
                </div>
              </div>

              {needsSetup && (
                <div>
                  <label htmlFor="repeat" className="block text-sm font-medium text-secondary dark:text-slate-300">
                    {t('login.repeatPassword')}
                  </label>
                  <div className="mt-1 relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Lock className="h-5 w-5 text-muted" />
                    </div>
                    <PasswordInput
                      id="repeat"
                      autoComplete="new-password"
                      required
                      value={repeat}
                      onChange={(e) => setRepeat(e.target.value)}
                      className={fieldClass}
                    />
                  </div>
                </div>
              )}

              <div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-xl shadow-sm text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent-500 disabled:opacity-50 transition-colors"
                >
                  {loading ? t('common.loading') : needsSetup ? t('login.create') : t('login.submit')}
                </button>
              </div>

              {/* Подсказка с учётными данными раньше висела на боевом экране входа.
                  Теперь её нет вовсе: подставлять нечего, пароль задаёт владелец. */}
              {import.meta.env.DEV && !needsSetup && (
                <p className="text-center text-xs text-muted mt-4">{t('login.devHint')}</p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
