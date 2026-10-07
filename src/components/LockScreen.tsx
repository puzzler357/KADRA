import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import * as api from '../data';
import PasswordInput from './PasswordInput';
import { useAppStore } from '../store/useAppStore';

/**
 * Экран блокировки по бездействию.
 *
 * Раскрывается поверх приложения и снимается только вводом пароля владельца —
 * проверка идёт тем же путём, что и вход, поэтому подобрать её на клиенте
 * нечем. Состояние блокировки персистится, так что перезагрузка страницы
 * не является способом её обойти.
 */
export default function LockScreen() {
  const { t } = useTranslation();
  const { user, unlock } = useAppStore();

  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    setError('');
    setLoading(true);
    try {
      await api.login(user.email, password);
      setPassword('');
      unlock();
    } catch {
      setError(t('login.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-[var(--background)] flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        <div className="w-16 h-16 rounded-2xl bg-surface-3 text-accent-400 flex items-center justify-center mx-auto mb-6">
          <Lock className="w-8 h-8" />
        </div>

        <h1 className="text-xl font-semibold text-primary">{t('settings.security.lockedTitle')}</h1>
        <p className="text-sm text-muted mt-2">{t('settings.security.lockedHint')}</p>
        {user && <p className="text-sm text-secondary mt-4 font-medium">{user.name}</p>}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {error && (
            <div className="bg-rose-50 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400 p-3 rounded-xl text-sm">
              {error}
            </div>
          )}

          <PasswordInput
            ref={inputRef}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2.5 border border-[var(--border-color)] rounded-xl bg-[var(--sidebar-bg)] text-center focus:outline-none focus:ring-2 focus:ring-accent-500 text-sm"
          />

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-xl text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 transition-colors"
          >
            {loading ? t('common.loading') : t('settings.security.unlock')}
          </button>
        </form>
      </div>
    </div>
  );
}
