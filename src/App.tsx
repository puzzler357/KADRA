/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';

// Экраны грузятся по требованию. Пока все девятнадцать собирались в один
// файл вместе с ExcelJS, SheetJS, Recharts и TipTap, приложение при каждом
// запуске разбирало ~4,5 МБ кода, прежде чем отправить первый запрос к базе.
// Теперь на старте — оболочка и открытый экран, остальное подтягивается при
// переходе (файлы лежат локально, это миллисекунды).
const pages = {
  Dashboard: () => import('./pages/Dashboard'),
  Employees: () => import('./pages/Employees'),
  OrgChart: () => import('./pages/OrgChart'),
  Movements: () => import('./pages/Movements'),
  Templates: () => import('./pages/Templates'),
  TemplateBuilder: () => import('./pages/TemplateBuilder'),
  DocumentGenerator: () => import('./pages/DocumentGenerator'),
  Reports: () => import('./pages/Reports'),
  Timesheet: () => import('./pages/Timesheet'),
  CalendarView: () => import('./pages/CalendarView'),
  Settings: () => import('./pages/Settings'),
  Profile: () => import('./pages/Profile'),
  Recruiting: () => import('./pages/Recruiting'),
  TimeOff: () => import('./pages/TimeOff'),
  Onboarding: () => import('./pages/Onboarding'),
  Performance: () => import('./pages/Performance'),
  KnowledgeBase: () => import('./pages/KnowledgeBase'),
  Archive: () => import('./pages/Archive'),
};

const Dashboard = lazy(pages.Dashboard);
const Employees = lazy(pages.Employees);
const OrgChart = lazy(pages.OrgChart);
const Movements = lazy(pages.Movements);
const Templates = lazy(pages.Templates);
const TemplateBuilder = lazy(pages.TemplateBuilder);
const DocumentGenerator = lazy(pages.DocumentGenerator);
const Reports = lazy(pages.Reports);
const Timesheet = lazy(pages.Timesheet);
const CalendarView = lazy(pages.CalendarView);
const Settings = lazy(pages.Settings);
const Profile = lazy(pages.Profile);
const Recruiting = lazy(pages.Recruiting);
const TimeOff = lazy(pages.TimeOff);
const Onboarding = lazy(pages.Onboarding);
const Performance = lazy(pages.Performance);
const KnowledgeBase = lazy(pages.KnowledgeBase);
const Archive = lazy(pages.Archive);

/**
 * Подгружает остальные экраны, когда стартовый уже на месте и браузеру
 * нечем заняться. Иначе первый переход на каждый экран ждал бы его файл —
 * лишние 50–130 мс. По одному экрану за раз, чтобы не занять поток надолго
 * и не помешать пользователю, если он уже что-то делает. Тяжёлые библиотеки
 * выгрузок (ExcelJS, SheetJS, html2pdf, docxtemplater) сюда не входят: они
 * нужны редко и грузятся в момент выгрузки.
 */
function prefetchPages() {
  const idle = (cb: () => void) =>
    typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(cb, { timeout: 2000 }) : setTimeout(cb, 200);
  const queue = Object.values(pages);
  const next = () => {
    const load = queue.shift();
    if (!load) return;
    load().catch(() => undefined).finally(() => idle(next));
  };
  // Секунда форы стартовому экрану: на 10 000 сотрудников его первая
  // отрисовка ещё идёт, когда данные уже пришли, и разбор соседних экранов
  // в это время её бы задержал.
  setTimeout(() => idle(next), 1000);
}

import LockScreen from './components/LockScreen';
import { ErrorState } from './components/States';
import * as api from './data';
import { useIdleLock } from './lib/useIdleLock';
import { useAppStore } from './store/useAppStore';
import { useDatabaseStore } from './store/useDatabaseStore';

export default function App() {
  const { user, startScreen, locked, requirePassword, login } = useAppStore();
  const { fetchAll, error } = useDatabaseStore();

  // Проверка владельца не мгновенная — это запрос к базе.
  const [ownerChecked, setOwnerChecked] = useState(false);

  useIdleLock();

  // Пароль при входе выключен — подставляем владельца сами. Учётная запись
  // в приложении одна, и запрашивать её пароль при каждом запуске незачем;
  // кому нужен экран входа, включает его в «Настройки → Безопасность».
  useEffect(() => {
    if (user || requirePassword) return;

    let cancelled = false;
    api.currentOwner()
      // null — учётной записи нет вовсе. Это рабочее состояние: приложение
      // открывается и без неё, а заводят её в профиле, если понадобилась.
      .then((owner) => { if (!cancelled && owner) login(owner.user, owner.token); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setOwnerChecked(true); });

    return () => { cancelled = true; };
  }, [user, requirePassword, login]);

  // Данные грузим, как только стало понятно, под кем работаем. Ждать user
  // нельзя: без учётной записи он так и останется пустым, а приложение
  // должно работать.
  const ready = Boolean(user) || ownerChecked;
  useEffect(() => {
    if (ready) {
      // Остальные экраны — после стартовых данных, а не наперегонки с ними.
      void fetchAll().then(prefetchPages);
    }
  }, [ready, fetchAll]);

  // Экран входа — только если владелец сам включил запрос пароля. Включить
  // его можно, лишь задав пароль, так что учётная запись к этому моменту
  // точно есть.
  if (requirePassword && !user) {
    return <Login />;
  }

  // Пока проверка владельца не отработала, рисовать нечего: имя в шапке
  // мигнуло бы.
  if (!ready) {
    return <div className="min-h-screen bg-[var(--background)]" />;
  }

  // Блокировка закрывает приложение целиком: данные не должны оставаться
  // на экране, пока владелец отошёл. Без пароля при входе снимать её нечем,
  // поэтому и ставить незачем.
  if (locked && requirePassword) {
    return <LockScreen />;
  }

  // Ошибка загрузки перекрывает приложение: показывать пустые экраны и
  // молчать о причине — худший из вариантов.
  if (error) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <ErrorState message={error} onRetry={() => { void fetchAll(); }} />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Layout>
        {/* Заглушка на время подгрузки экрана — пустая: файл приходит с
            локального диска быстрее, чем стоило бы мигать скелетоном. */}
        <Suspense fallback={<div className="min-h-[50vh]" />}>
        <Routes>
          {/* Стартовый экран настраивается в «Настройки → Общие». */}
          <Route path="/" element={<Navigate to={startScreen || '/dashboard'} replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/employees" element={<Employees />} />
          <Route path="/org-chart" element={<OrgChart />} />
          <Route path="/movements" element={<Movements />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/templates/new" element={<TemplateBuilder />} />
          <Route path="/generate" element={<DocumentGenerator />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/timesheet" element={<Timesheet />} />
          <Route path="/calendar" element={<CalendarView />} />
          <Route path="/recruiting" element={<Recruiting />} />
          <Route path="/timeoff" element={<TimeOff />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/performance" element={<Performance />} />
          <Route path="/knowledge-base" element={<KnowledgeBase />} />
          <Route path="/archive" element={<Archive />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/profile" element={<Profile />} />
        </Routes>
        </Suspense>
      </Layout>
    </BrowserRouter>
  );
}
