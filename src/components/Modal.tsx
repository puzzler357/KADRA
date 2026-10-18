import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Кнопки внизу окна. */
  footer?: ReactNode;
  /** Ширина: md — форма, lg — таблица, xl — сравнение. */
  size?: 'md' | 'lg' | 'xl';
}

const WIDTH = { md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-4xl' };

/**
 * Модальное окно.
 *
 * Раньше каждая страница рисовала своё окно из div'ов: без роли dialog, без
 * закрытия по Escape и без переноса фокуса — с клавиатуры и экранной читалкой
 * ими было не пользоваться. Здесь одно окно на всех.
 */
export default function Modal({ title, onClose, children, footer, size = 'md' }: ModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Фокус — на первое поле окна, если оно есть, иначе на само окно.
    const first = panel.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-modal-close])');
    (first ?? panel.current)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    // Щелчок по затемнению закрывает окно; с клавиатуры то же делает Esc.
    <div role="presentation" className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl w-full ${WIDTH[size]} max-h-[85vh] flex flex-col shadow-xl focus:outline-none`}
      >
        <div className="flex justify-between items-center gap-4 px-6 pt-6 pb-4">
          <h3 id={titleId} className="text-xl font-bold text-primary">{title}</h3>
          <button
            type="button"
            data-modal-close
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 rounded-lg text-muted hover:text-primary hover:bg-surface-hover transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 pb-6 overflow-y-auto custom-scrollbar">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-[var(--border-color)] flex justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Поле формы с подписью и сообщением об ошибке под ним. */
export function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string | null; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1 text-secondary">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-muted mt-1">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="text-rose-600 dark:text-rose-400 text-xs mt-1">{error}</p>}
    </div>
  );
}

export const inputClass = 'w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm text-primary focus:outline-none focus:ring-2 focus:ring-accent-500 aria-[invalid=true]:border-rose-500';
export const primaryButton = 'bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors';
export const secondaryButton = 'border border-[var(--border-color)] hover:bg-surface-hover text-secondary px-4 py-2 rounded-xl text-sm font-medium transition-colors';
export const dangerButton = 'border border-rose-500/30 text-rose-700 dark:text-rose-400 hover:bg-rose-500/10 px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-50';
