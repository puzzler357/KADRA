import React from 'react';
import { LicenseBanner } from './LicenseGate';
import { useTranslation } from 'react-i18next';
import {
  Users,
  CalendarDays, 
  Network, 
  FileText, 
  BarChart2, 
  Settings, 
  Menu,
  ArrowLeftRight,
  Calendar,
  LayoutDashboard,
  UserPlus,
  Clock,
  Target,
  BookOpen,
  Archive,
  LogOut
} from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';

export default function Layout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const { sidebarOpen, toggleSidebar, user, requirePassword, logout } = useAppStore();


  // Однопользовательское приложение: все разделы доступны владельцу устройства.
  const navItems = [
    { id: 'dashboard', path: '/dashboard', icon: LayoutDashboard, label: t('nav.dashboard') },
    { id: 'employees', path: '/employees', icon: Users, label: t('nav.employees') },
    { id: 'org_chart', path: '/org-chart', icon: Network, label: t('nav.org_chart') },
    { id: 'movements', path: '/movements', icon: ArrowLeftRight, label: t('nav.movements') },
    { id: 'recruiting', path: '/recruiting', icon: Users, label: t('nav.recruiting') },
    { id: 'timeoff', path: '/timeoff', icon: Clock, label: t('nav.timeoff') },
    { id: 'timesheet', path: '/timesheet', icon: CalendarDays, label: t('nav.timesheet') },
    { id: 'calendar', path: '/calendar', icon: Calendar, label: t('nav.calendar') },
    { id: 'onboarding', path: '/onboarding', icon: UserPlus, label: t('nav.onboarding') },
    { id: 'performance', path: '/performance', icon: Target, label: t('nav.performance') },
    { id: 'knowledge-base', path: '/knowledge-base', icon: BookOpen, label: t('nav.knowledge_base') },
    { id: 'documents', path: '/templates', icon: FileText, label: t('nav.templates') },
    { id: 'generate', path: '/generate', icon: FileText, label: t('nav.generate') },
    { id: 'reports', path: '/reports', icon: BarChart2, label: t('nav.reports') },
    { id: 'archive', path: '/archive', icon: Archive, label: t('nav.archive') },
    { id: 'settings', path: '/settings', icon: Settings, label: t('nav.settings') },
  ];

  const visibleNavItems = navItems;


  const location = useLocation();
  // Вложенные страницы (конструктор шаблона /templates/new) подписываются
  // разделом, из которого открыты, а не общим «KADRA».
  const currentNav = visibleNavItems.find(item => item.path === location.pathname)
    ?? visibleNavItems.find(item => item.path !== '/' && location.pathname.startsWith(`${item.path}/`));
  const title = currentNav ? currentNav.label : t('app_name');

  // При печати оболочка не должна резать документ одной страницей и
  // закрашивать поля листа фоном темы — отсюда print:-классы.
  return (
    <div className="flex h-screen bg-[var(--background)] text-[var(--foreground)] overflow-hidden print:block print:h-auto print:overflow-visible print:bg-white">
      {/* Sidebar */}
      <aside 
        className={`no-print ${
          sidebarOpen ? 'w-64' : 'w-20'
        } flex-shrink-0 transition-all duration-300 ease-in-out bg-[var(--sidebar-bg)] border-r border-[var(--border-color)] flex flex-col`}
      >
        <div className="h-20 flex items-center justify-between px-6">
          {sidebarOpen && (
            <div className="flex items-center">
              <img src="/brand/kadra-logo.png" alt={t('app_name')} className="h-14 w-auto dark:hidden" />
              <img src="/brand/kadra-logo-light.png" alt={t('app_name')} className="h-14 w-auto hidden dark:block" />
            </div>
          )}
          {!sidebarOpen && (
            <img src="/brand/kadra-icon-192.png" alt="KADRA" className="w-9 h-9 rounded-lg mx-auto" />
          )}
        </div>
        
        <nav className="flex-1 py-4 flex flex-col gap-2 px-4 overflow-y-auto">
          {visibleNavItems.map((item) => (
            <NavLink 
              key={item.id}
              to={item.path}
              className={({ isActive }) => `flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left ${isActive ? 'bg-accent-600/10 text-accent-700 dark:text-accent-300 font-medium' : 'hover:bg-surface-hover text-secondary'}`}
            >
              {({ isActive }) => (
                <>
                  <item.icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-accent-700 dark:text-accent-300' : 'text-muted'}`} />
                  {sidebarOpen && <span className="text-sm truncate">{item.label}</span>}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 mt-auto">
          <div className="flex items-center gap-3">
            <img src="/brand/kadra-avatar.png" alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
            {sidebarOpen && (
              <div className="overflow-hidden flex-1">
                <p className="font-medium text-sm text-primary truncate">{user?.name || 'KADRA'}</p>
                <p className="text-xs text-muted truncate">{t('user.owner')}</p>
              </div>
            )}
            {/* Выход имеет смысл, только когда вход защищён паролем: без пароля
                приложение тут же открылось бы снова. */}
            {requirePassword && user && (
              <button
                onClick={logout}
                aria-label={t('user.logout')}
                title={t('user.logout')}
                className="p-2 rounded-xl text-muted hover:text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden print:block print:overflow-visible">
        {/* Topbar */}
        <header className="no-print h-20 flex-shrink-0 flex items-center justify-between px-8">
          <div className="flex items-center gap-4">
            <button onClick={toggleSidebar} aria-label={t('nav.toggleSidebar')} aria-expanded={sidebarOpen} className="p-2 -ml-2 rounded-xl hover:bg-surface-hover text-muted transition-colors">
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-2xl font-bold tracking-tight text-primary">
              {title}
            </h1>
          </div>
        </header>

        {/* Причина режима «только чтение» и предупреждения о сроках лицензии —
            в потоке страницы, чтобы не закрывать ни заголовок, ни кнопки. */}
        <LicenseBanner />

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto px-8 pb-8 print:overflow-visible print:p-0">
          <div className="max-w-7xl mx-auto print:max-w-none">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
