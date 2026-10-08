<p align="center"><img src="assets/brand/kadra-logo.png" alt="KADRA — учёт кадров" width="480"></p>

# KADRA

Локальная HR-система: учёт сотрудников, оргструктура, табель, кадровые документы и отчётность.
Работает в двух режимах — как настольное приложение (Tauri, Windows) и как веб-приложение с
локальным Express-бэкендом. Данные всегда хранятся локально в SQLite, без внешних сервисов;
в сеть настольная сборка обращается только к серверу лицензий, и то необязательно.

## Стек

| Слой | Технологии |
|---|---|
| Фронтенд | React 19, Vite 6, TypeScript, Tailwind CSS 4, React Router 7 |
| Состояние и данные | Zustand-стор (`src/store`), TanStack Table, React Hook Form + Zod |
| Настольное приложение | Tauri 2; база и лицензирование на Rust (`rusqlite`, `ed25519-dalek`, `reqwest`) |
| Веб-режим | Express 4 + better-sqlite3, JWT, bcryptjs |
| Документы | docxtemplater + PizZip (DOCX), ExcelJS (XLSX), html2pdf.js (PDF) |
| Интерфейс | i18next: русский (по умолчанию), английский, туркменский |
| Тесты | Vitest (API), Playwright (e2e) |

## Архитектура доступа к данным

Единая точка входа — [src/data/index.ts](src/data/index.ts). Она определяет среду выполнения и
выбирает бэкенд:

- **В Tauri** (`__TAURI_INTERNALS__` в `window`) вызовы идут в локальную SQLite через
  [src/data/tauriDb.ts](src/data/tauriDb.ts) и команды оболочки `db_*`
  ([src/data/shellDb.ts](src/data/shellDb.ts)). Соединение держит Rust
  ([src-tauri/src/db](src-tauri/src/db)): он применяет миграции и посев при открытии базы и
  отклоняет запись, пока лицензия не действует.
- **В браузере** те же вызовы уходят по HTTP на `/api/*` к Express-серверу [server.ts](server.ts),
  который работает с той же схемой через [src/db/sqlite.ts](src/db/sqlite.ts).

Благодаря этому страницы не знают, в каком режиме они запущены, а бизнес-логика не дублируется.
Схема описана один раз ([src/data/schema.ts](src/data/schema.ts),
[src/data/entities.ts](src/data/entities.ts)); для оболочки она собирается в
`src-tauri/schema.json` командой `npm run schema:export` — после любой правки схемы или посева.

## Лицензирование

Настольная сборка работает полностью только с действующей лицензией — модель перенесена из
проекта GAS. Без лицензии приложение открывается в режиме «только чтение» (просмотр, отчёты,
экспорт, резервная копия), а на пустой установке показывает экран активации. Активация —
онлайн по ключу `KDR-XXXXX-XXXXX-XXXXX-XXXXX` или офлайн обменом файлами; состояние и действия —
«Настройки → Лицензия». В веб-режиме лицензирование не действует.

- Проверка — [src-tauri/src/license](src-tauri/src/license), правила и ТЗ — [LICENSING.md](LICENSING.md).
- Сторона продавца — [license-server](license-server) (сервер и панель License Manager) и
  `tools/kdr-license` (то же из консоли); руководство — [license-server/SellerManual.md](license-server/SellerManual.md).

**Разработка.** `npm run tauri:dev` доверяет отладочному ключу и ходит к серверу лицензий на
`http://127.0.0.1:8787/v1`. Поднять его: `cd license-server`, `npm install`,
`npm run admin:dev -- add owner` (один раз), `npm run dev`. Выпустить отладочную лицензию без
сервера: `node tools/kdr-license <команда> --dev`.

**Релиз.** `npm run tauri:build` требует две вещи, иначе сборка остановится:

1. релизный ключ подписи — `node tools/kdr-license keygen --kid kdr-2026-1` (открытая половина
   попадёт в `src-tauri/license-keys.json` — её коммитят; закрытая останется в
   `~/.kdr-license/keys` — две резервные копии на разных носителях обязательны);
2. адрес сервера — `LICENSE_SERVER_URL=https://license.<домен>/v1`
   (PowerShell: `$env:LICENSE_SERVER_URL="https://license.<домен>/v1"`).

## Целевая среда

Приложение **только для настольного компьютера**: опорное разрешение 1280×800,
минимальное окно 1024×700 (задано в [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)).
Мобильной и планшетной вёрстки нет и не планируется — это решение заказчика,
зафиксированное в [TZ_AUDIT.md](TZ_AUDIT.md). Утилиты `md:`/`lg:` в разметке
остались: при сужении окна они отрабатывают корректно и ничему не мешают.

Целевая ОС — Windows 10/11 x64, сборка выпускает инсталляторы NSIS и MSI.

## Быстрый старт

**Требования:** Node.js 18+. Для сборки настольного приложения дополнительно — Rust и
[системные зависимости Tauri](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run dev          # веб-режим: Express + Vite на http://localhost:3000
# или
npm run tauri:dev    # настольное приложение
```

При первом запуске база создаётся и наполняется демонстрационными данными, а приложение
показывает экран первичной настройки: владелец задаёт имя и email. Учётной записи по
умолчанию нет — пароль, зашитый в поставку, знали бы все.

Пароль на этом экране необязателен. Приложение однопользовательское и лежит на
устройстве владельца, поэтому по умолчанию оно открывается сразу и пароля не просит
вовсе. Задать его можно когда угодно в «Настройки → Пароль» — поле текущего пароля
появится только после того, как первый будет задан (не короче 8 символов).

Пока пароля нет, запрашивать при входе нечего: тумблер «Настройки → Безопасность →
Запрашивать пароль при входе» недоступен, а вместе с ним и блокировка по бездействию —
снимать её было бы нечем. Очистка модулей и сброс к заводским настройкам тоже
подтверждаются паролем только тогда, когда он задан; без него остаются подтверждение
в интерфейсе и контрольная фраза для сброса.

> Сбросить владельца можно только вместе с базой: удалите файл `local-hr-docs.db`,
> и при следующем запуске экран первичной настройки появится снова.

Переменные окружения необязательны — см. [.env.example](.env.example). Локальные значения
кладите в `.env.local`, он читается на старте сервера и приоритетнее `.env`; файлы `.env*`
в git не попадают. Настраиваются секрет JWT (`JWT_SECRET`), порт (`PORT`) и путь к базе
(`DB_PATH`).

## Структура проекта

```
src/
  pages/         19 страниц: Dashboard, Employees, OrgChart, Timesheet, Templates,
                 DocumentGenerator, Reports, Recruiting, Onboarding, Performance,
                 TimeOff, Movements, Archive, KnowledgeBase, CalendarView, Settings, …
  components/    Layout и формы сотрудника
  data/          слой доступа к данным (Tauri ↔ REST) и типы
  db/            схема SQLite и сид
  lib/           генерация DOCX / XLSX, утилиты
  locales/       ru, en, tk
  store/         клиентское состояние
server.ts        Express REST API для веб-режима
src-tauri/       Rust: база и охрана записи (src/db), лицензирование (src/license), конфиг, иконки
license-server/  сервер лицензий и панель License Manager — отдельный подпроект
tools/           консольные утилиты (kdr-license: выпуск лицензий без сервера)
tests/api/       Vitest: REST API
tests/e2e/       Playwright: сценарии в браузере
```

`license-server/` и `tools/` — самостоятельные подпроекты на Node со своими
`package.json`, `tsconfig.json` и проверками; корневые `lint`, `lint:eslint` и
Prettier их не затрагивают. Подробности — в
[license-server/README.md](license-server/README.md).

## Скрипты

| Команда | Что делает |
|---|---|
| `npm run dev` | Express + отдача клиента, порт 3000 |
| `npm run dev:client` | Только Vite dev-сервер (порт 5173) |
| `npm run build` | Сборка клиента (Vite) и сервера (esbuild → `dist/server.cjs`) |
| `npm start` | Запуск собранного сервера |
| `npm run tauri:dev` | Настольное приложение в режиме разработки |
| `npm run tauri:build` | Сборка инсталлятора (NSIS, MSI) |
| `npm run lint` | Проверка типов `tsc --noEmit`, включая тесты |
| `npm run schema:export` | Пересобирает `src-tauri/schema.json` (миграции и посев для оболочки Tauri) из `src/data` |
| `npm run make:docx` | Пересобирает бланк `public/templates/blank.docx` из разметки в `scripts/makeDocxTemplate.ts` |
| `npm run seed:load` | Наполняет базу боевым объёмом (10 000 сотрудников и год табеля) для замеров производительности. Флаги: `--employees=N`, `--year=YYYY`, `--no-timesheets`, `--db=путь` |

## Проверка (тесты)

Всё проверяется одной командой:

```bash
npm run verify
```

Она последовательно прогоняет типы → сборку → API-тесты → e2e-обход всех страниц.

Отдельные шаги:

| Команда | Что проверяет |
|---|---|
| `npm run lint` | Типы TypeScript (`tsc --noEmit`), включая тесты |
| `npm run build` | Сборку клиента и сервера |
| `npm test` | Vitest: REST API — авторизация, смена пароля, CRUD сотрудников, оргструктуры, шаблонов, табеля, архива |
| `npm run test:watch` | То же в режиме watch |
| `npm run test:e2e` | Playwright: логин, обход всех 18 страниц + навигация по меню, отлов ошибок консоли и неуспешных запросов |
| `npm run test:e2e:ui` | Playwright в интерактивном режиме |

E2E поднимают отдельный сервер на изолированной базе, поэтому рабочие данные не затрагиваются.

Сторона Rust (база, охрана записи, лицензирование) проверяется отдельно, своим тулчейном:

```bash
cd src-tauri
cargo test --lib                    # 75 тестов: приёмочные проверки LICENSING.md с подменой времени и железа
cargo test --lib -- --ignored e2e   # сквозные: против утилиты kdr-license и настоящего сервера (нужен Node 22.18+)
```

Сервер лицензий — `npm test` в `license-server` (55 тестов).

## Документация

| Файл | Содержание |
|---|---|
| [TZ.md](TZ.md) | Техническое задание |
| [TZ_AUDIT.md](TZ_AUDIT.md) | Сверка реализации с ТЗ |
| [AUDIT_REPORT.md](AUDIT_REPORT.md) | Отчёт по аудиту кода |
| [TEST_SCENARIO.md](TEST_SCENARIO.md) | Ручные тестовые сценарии |
| [BUILD_PROMPT.md](BUILD_PROMPT.md), [BUILD_PROMPT.v2.md](BUILD_PROMPT.v2.md) | Постановка для генерации приложения |
| [LICENSING.md](LICENSING.md) | ТЗ на лицензирование: тарифы, форматы, протокол, состояния, реализация, приёмочные тесты |
| [license-server/README.md](license-server/README.md) | Сервер лицензий: установка, настройка, webhook оплаты |
| [license-server/SellerManual.md](license-server/SellerManual.md) | Руководство продавца: продажа, активация, продление, переносы |
