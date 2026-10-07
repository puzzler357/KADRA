// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

/**
 * Конфигурация ESLint.
 *
 * Правила подобраны так, чтобы находить настоящие ошибки, а не спорить о
 * форматировании: за отступы и кавычки отвечает Prettier. Проверка типов
 * остаётся за tsc — дублировать её линтером незачем.
 */
export default tseslint.config(
  {
    // license-server и tools — отдельные подпроекты на Node со своими
    // tsconfig и проверками; корневой линтер их не касается.
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/**',
      'public/**',
      'tests/.tmp/**',
      'license-server/**',
      'tools/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // Неиспользуемое ловит tsc с noUnusedLocals; здесь правило только
      // мешало бы, дублируя сообщения.
      '@typescript-eslint/no-unused-vars': 'off',

      // any в проекте есть — в основном на границе с драйвером SQLite и в
      // обобщённом CRUD. Предупреждение, а не ошибка: чинить их стоит по
      // ходу дела, а не одним махом, ломая рабочий код.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Пустой catch используется намеренно: например, когда localStorage
      // недоступен в приватном режиме. Такие блоки снабжены комментарием.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    // Тесты и скрипты — среда Node, там свои вольности допустимы.
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'server.ts', '*.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
