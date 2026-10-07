import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';

// События, которые считаем признаком присутствия человека. passive — чтобы
// слушатели не мешали прокрутке.
const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  'mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll',
];

/**
 * Блокировка приложения после простоя.
 *
 * Таймер перезапускается на любом признаке активности и на возвращении
 * вкладки из фона. Нулевой порог выключает блокировку — так настроено
 * в «Настройки → Безопасность».
 */
export function useIdleLock() {
  const lockTimeoutMinutes = useAppStore((s) => s.lockTimeoutMinutes);
  const locked = useAppStore((s) => s.locked);
  const user = useAppStore((s) => s.user);
  const requirePassword = useAppStore((s) => s.requirePassword);
  const lock = useAppStore((s) => s.lock);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Блокировать нечего, пока никто не вошёл; уже заблокированное приложение
    // таймер не трогает. С выключенным паролем блокировки нет вовсе: экран
    // снимается только паролем владельца.
    if (!user || locked || !requirePassword || lockTimeoutMinutes <= 0) return;

    const timeoutMs = lockTimeoutMinutes * 60_000;

    const restart = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(lock, timeoutMs);
    };

    restart();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, restart, { passive: true });
    }

    // Возврат вкладки из фона — тоже активность: иначе таймер, поставленный
    // до сворачивания, сработал бы сразу после переключения обратно.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') restart();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, restart);
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [user, locked, requirePassword, lockTimeoutMinutes, lock]);
}
