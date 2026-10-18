import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store/useAppStore';
import * as api from '../data';
import PasswordInput from '../components/PasswordInput';
import { Monitor, Moon, Sun, Lock } from 'lucide-react';

const fieldClass = 'block w-full pl-10 pr-3 py-2 border border-[var(--border-color)] rounded-xl bg-[var(--background)] focus:outline-none focus:ring-2 focus:ring-accent-500 sm:text-sm';

/**
 * Экран входа.
 *
 * Показывается только тогда, когда владелец сам включил запрос пароля при
 * входе. Учётная запись в приложении одна, поэтому спрашивается только
 * пароль: раньше форма требовала ещё и email, и учётная запись, заведённая
 * с одним именем, запиралась насовсем.
 */
export default function Login({ ownerName }: { ownerName?: string | null }) {
  const { t } = useTranslation();
  const { theme, setTheme, login } = useAppStore();

  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Фокус в поле пароля при открытии экрана: вводить больше нечего.
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => { passwordRef.current?.focus(); }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api.login(password);
      login(data.user, data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  const themeButton = (value: 'light' | 'system' | 'dark', title: string, Icon: typeof Sun) => (
    <button
      type="button"
      onClick={() => setTheme(value)}
      aria-label={title}
      title={title}
      className={`p-1.5 rounded-lg transition-colors ${theme === value ? 'bg-surface shadow-sm text-accent-600 dark:text-accent-400' : 'text-muted hover:text-primary'}`}
    >
      <Icon className="w-4 h-4" />
    </button>
  );

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="absolute top-4 right-4 flex items-center p-1 bg-surface-3 rounded-xl border border-[var(--border-color)]">
        {themeButton('light', t('settings.light'), Sun)}
        {themeButton('system', t('settings.system'), Monitor)}
        {themeButton('dark', t('settings.dark'), Moon)}
      </div>

      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <h2 className="mt-6 flex justify-center">
          <img src="/brand/kadra-logo.png" alt={t('app_name')} className="h-24 w-auto dark:hidden" />
          <img src="/brand/kadra-logo-light.png" alt={t('app_name')} className="h-24 w-auto hidden dark:block" />
        </h2>
        <p className="mt-2 text-center text-sm text-muted">{t('login.subtitle')}</p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-[var(--sidebar-bg)] py-8 px-4 shadow-sm border border-[var(--border-color)] sm:rounded-2xl sm:px-10">
          <form className="space-y-6" onSubmit={handleLogin}>
            {ownerName && (
              <p className="text-center text-primary font-medium" data-testid="login-owner">{ownerName}</p>
            )}

            {error && (
              <div role="alert" className="bg-rose-500/10 text-rose-700 dark:text-rose-400 p-3 rounded-xl text-sm text-center">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-secondary">
                {t('login.password')}
              </label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-muted" />
                </div>
                <PasswordInput
                  id="password"
                  name="password"
                  autoComplete="current-password"
                  ref={passwordRef}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={fieldClass}
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={loading}
                className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-xl shadow-sm text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent-500 disabled:opacity-50 transition-colors"
              >
                {loading ? t('common.loading') : t('login.submit')}
              </button>
            </div>

            <p className="text-center text-xs text-muted">{t('login.forgotHint')}</p>
          </form>
        </div>
      </div>
    </div>
  );
}
