import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

/**
 * Тосты и подтверждения вместо alert()/confirm().
 *
 * Системные диалоги блокируют весь интерфейс, не переводятся, не оформляются
 * и в Tauri выглядят чужеродно. Здесь свои — без внешних зависимостей.
 *
 * confirm() возвращает промис: вызывающий код остаётся линейным, как с
 * системным диалогом, и переписывать логику под колбэки не приходится.
 */

type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ConfirmRequest {
  message: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

interface NotifyApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  confirm: (message: string, options?: { danger?: boolean }) => Promise<boolean>;
}

const NotifyContext = createContext<NotifyApi | null>(null);

/**
 * Тот же API для кода вне React — сторов. Нужен, например, чтобы сказать
 * пользователю, почему правка не сохранилась в режиме «только чтение».
 */
export const notifyOutsideReact: { current: NotifyApi | null } = { current: null };

const KIND_STYLE: Record<ToastKind, { icon: typeof Info; className: string }> = {
  success: { icon: CheckCircle2, className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  error: { icon: AlertTriangle, className: 'border-rose-500/30 bg-rose-500/10 text-rose-400' },
  info: { icon: Info, className: 'border-line bg-surface-3 text-secondary' },
};

const AUTO_HIDE_MS = 5000;

export function NotifyProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const nextId = useRef(1);
  const confirmButton = useRef<HTMLButtonElement>(null);

  // Фокус ставится после появления диалога, а не атрибутом autoFocus:
  // атрибут срабатывает и там, где диалога нет, и мешает экранным читалкам.
  useEffect(() => {
    if (request) confirmButton.current?.focus();
  }, [request]);

  const remove = useCallback((id: number) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setToasts(prev => [...prev, { id, kind, message }]);
    // Ошибки исчезают так же, как остальное: висящее сообщение о давно
    // закрытой проблеме мешает не меньше, чем пропущенное.
    setTimeout(() => remove(id), AUTO_HIDE_MS);
  }, [remove]);

  const api = useMemo<NotifyApi>(() => ({
    success: (message) => push('success', message),
    error: (message) => push('error', message),
    info: (message) => push('info', message),
    confirm: (message, options) => new Promise<boolean>((resolve) => {
      setRequest({ message, danger: options?.danger ?? false, resolve });
    }),
  }), [push]);

  const answer = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };

  useEffect(() => {
    notifyOutsideReact.current = api;
    return () => {
      if (notifyOutsideReact.current === api) notifyOutsideReact.current = null;
    };
  }, [api]);

  return (
    <NotifyContext.Provider value={api}>
      {children}

      {request && (
        <div
          className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-4"
          role="alertdialog"
          aria-modal="true"
          aria-label={request.message}
        >
          <div className="bg-surface border border-line rounded-2xl w-full max-w-md overflow-hidden shadow-2xl">
            <div className="p-6">
              <p className="text-primary">{request.message}</p>
            </div>
            <div className="flex gap-3 p-4 border-t border-line bg-surface-2">
              <button
                onClick={() => answer(false)}
                className="flex-1 bg-surface-3 hover:bg-surface-hover text-primary px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                ref={confirmButton}
                onClick={() => answer(true)}
                className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors text-white ${
                  request.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-accent-500 hover:bg-accent-600'
                }`}
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-6 right-6 z-[210] flex flex-col gap-3 w-80 max-w-[calc(100vw-3rem)]">
        {toasts.map(toast => {
          const { icon: Icon, className } = KIND_STYLE[toast.kind];
          return (
            <div
              key={toast.id}
              role="status"
              className={`flex items-start gap-3 border rounded-xl px-4 py-3 shadow-lg backdrop-blur-sm ${className}`}
            >
              <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p className="flex-1 text-sm text-primary">{toast.message}</p>
              <button
                onClick={() => remove(toast.id)}
                aria-label={t('common.close')}
                className="text-muted hover:text-primary transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </NotifyContext.Provider>
  );
}

/** Тосты и подтверждения. Бросает, если вызван вне NotifyProvider. */
export function useNotify(): NotifyApi {
  const api = useContext(NotifyContext);
  if (!api) throw new Error('useNotify вызван вне NotifyProvider');
  return api;
}
