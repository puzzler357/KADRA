/**
 * Человекочитаемые названия для журнала аудита.
 *
 * В базе действия и сущности лежат техническими строками («owner_create»,
 * «time_off_requests»): по ним удобно фильтровать и невозможно читать.
 * Перевод живёт здесь, а не в разметке, потому что журнал показывают два
 * экрана — «Настройки» и сводка на главной, — и расходиться им незачем.
 *
 * Незнакомое действие показывается как есть: новая запись в журнале лучше
 * пустого места, даже если названия для неё ещё не придумали.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const auditActionLabel = (t: Translate, action: string): string =>
  t(`settings.audit.actions.${action}`, { defaultValue: action });

export const auditEntityLabel = (t: Translate, entity: string): string =>
  t(`settings.audit.entities.${entity}`, { defaultValue: entity });

/** Ключи настроек оформления — остальные относятся к общим настройкам. */
const APPEARANCE_KEYS = new Set(['theme', 'accentColor', 'density', 'fontSize']);

/**
 * Сущность записи журнала для изменённой настройки. Раньше любое изменение
 * подписывалось «Оформление» — даже название организации.
 */
export const auditEntityOfSetting = (key: string): string =>
  APPEARANCE_KEYS.has(key) || key === 'reset' ? 'appearance' : 'settings';
