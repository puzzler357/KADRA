import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';

type Props = Omit<React.ComponentProps<'input'>, 'type'>;

/**
 * Поле пароля с кнопкой «показать».
 *
 * Пароль набирается вслепую, а узнать об опечатке можно только по отказу —
 * на экране блокировки и при сбросе к заводским настройкам это особенно
 * обидно. Кнопка переключает `type` того же поля, так что менеджеры паролей
 * и автозаполнение продолжают видеть обычный `input[type=password]`.
 *
 * Принимает те же атрибуты, что и `input`, кроме `type`: оформление приходит
 * с места вызова, компонент добавляет к нему только отступ под кнопку.
 */
export default function PasswordInput({ className = '', ref, ...props }: Props) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const inner = useRef<HTMLInputElement | null>(null);

  // Своя ссылка нужна для возврата фокуса, внешняя — вызывающему экрану
  // (на экране блокировки поле получает фокус при открытии).
  const keepRef = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  const toggle = () => {
    setShown((value) => !value);
    // Клик по кнопке уводит фокус из поля. Возвращаем его после перерисовки,
    // когда тип поля уже сменился, вместе с кареткой в конец — иначе набор
    // продолжится не там, где прервался.
    requestAnimationFrame(() => {
      const el = inner.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const label = shown ? t('common.hidePassword') : t('common.showPassword');

  return (
    <div className="relative">
      <input
        {...props}
        ref={keepRef}
        type={shown ? 'text' : 'password'}
        // Правый отступ с места вызова заменяем своим: под кнопкой текст
        // не должен проходить.
        className={`${className.replace(/\bpr-[\d.]+\b/g, '')} pr-11`}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        title={label}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary transition-colors"
      >
        {shown ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}
