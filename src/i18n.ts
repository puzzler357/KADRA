import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { en } from './locales/en';
import { ru } from './locales/ru';
import { tk } from './locales/tk';

// Initialize i18next
i18n
  .use(initReactI18next)
  .init({
    resources: {
      en,
      ru,
      tk
    },
    lng: 'ru', // default language
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false, // react already safes from xss
    },
  });

// Атрибут lang у страницы следует за языком интерфейса: от него зависят
// переносы, проверка орфографии и экранные читалки.
const syncDocumentLanguage = (lng: string) => {
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
};
syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

export default i18n;
