import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Mail, Briefcase, Key, Calendar as CalendarIcon, CheckSquare, History, User } from 'lucide-react';
import EmployeeForm from '../components/EmployeeForm';
import { useNotify } from '../components/Toasts';
import * as api from '../data';
import { useMoney } from '../lib/money';
import { useAppStore } from '../store/useAppStore';
import { useDatabaseStore } from '../store/useDatabaseStore';
import type { Employee } from '../store/useDatabaseStore';

/**
 * Профиль владельца.
 *
 * Вкладки «Расчётные листки» и «Техника» убраны: за ними не стояло никаких
 * данных — только выдуманные строки в коде. Оставлены те разделы, которым
 * есть чем наполниться: отсутствия, задачи адаптации и кадровая история.
 */
export default function Profile() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const money = useMoney();

  const { user, theme, setTheme, language, setLanguage, orgName, login } = useAppStore();
  const notify = useNotify();
  const { employees, timeOffRequests, checklistTasks, movements, updateEmployee } = useDatabaseStore();

  const [activeTab, setActiveTab] = useState('overview');
  const [isEditOpen, setIsEditOpen] = useState(false);

  // Учётной записи может не быть вовсе: приложение открывается и без неё.
  // Здесь её заводят и правят — больше нигде этого сделать нельзя.
  const [accountName, setAccountName] = useState(user?.name ?? '');
  const [accountEmail, setAccountEmail] = useState(user?.email ?? '');
  const [accountBusy, setAccountBusy] = useState(false);

  // Владелец приезжает асинхронно: на первом рендере он ещё пуст, и поля
  // надо заполнить, когда он появится.
  useEffect(() => {
    setAccountName(user?.name ?? '');
    setAccountEmail(user?.email ?? '');
  }, [user?.name, user?.email]);

  const saveAccount = async () => {
    const name = accountName.trim();
    const email = accountEmail.trim();
    if (!name && !email) {
      notify.error(t('profile.account.needName'));
      return;
    }

    setAccountBusy(true);
    try {
      const data = await api.saveOwner(name, email);
      const created = !user;
      login(data.user, data.token);
      notify.success(created ? t('profile.account.created') : t('profile.account.saved'));
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t('profile.account.error'));
    } finally {
      setAccountBusy(false);
    }
  };

  // Учётная запись владельца и карточка сотрудника — разные сущности.
  // Связываем их по имени: другого общего ключа в схеме нет.
  const card = useMemo(
    () => employees.find(e => e.fullName === user?.name),
    [employees, user?.name],
  );

  const myTimeOff = useMemo(
    () => (card ? timeOffRequests.filter(r => r.employeeId === card.id) : []),
    [timeOffRequests, card],
  );
  const myTasks = useMemo(
    () => (card ? checklistTasks.filter(task => task.employeeId === card.id) : []),
    [checklistTasks, card],
  );
  const myHistory = useMemo(
    () => (card ? movements.filter(m => m.employeeId === card.id) : []),
    [movements, card],
  );

  const tabs = [
    { id: 'overview', label: t('profile.tabs.overview'), icon: User },
    { id: 'timeoff', label: t('profile.tabs.timeoff'), icon: CalendarIcon },
    { id: 'tasks', label: t('profile.tabs.tasks'), icon: CheckSquare },
    { id: 'history', label: t('profile.history'), icon: History },
  ];

  const handleEdit = (data: Omit<Employee, 'id'>) => {
    if (card) updateEmployee(card.id, data);
    setIsEditOpen(false);
  };

  const statusLabel = (status: string) =>
    status === 'approved' ? t('timeoff.status.approved')
      : status === 'rejected' ? t('timeoff.status.rejected')
        : t('timeoff.status.pending');

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight text-primary">{t('profile.title')}</h2>

      <div className="bg-surface border border-line rounded-2xl shadow-sm overflow-hidden">
        <div className="h-32 bg-gradient-to-r from-accent-500 to-purple-600" />
        <div className="px-8 pb-8">
          <div className="relative flex justify-between items-end -mt-12 mb-6">
            <div className="w-24 h-24 rounded-2xl bg-surface border-4 border-line flex items-center justify-center text-3xl font-bold text-accent-400 shadow-sm">
              {user?.name?.[0] || 'U'}
            </div>
            <button
              onClick={() => setIsEditOpen(true)}
              disabled={!card}
              className="bg-surface border border-line hover:bg-surface-hover disabled:opacity-50 text-secondary px-4 py-2 rounded-xl font-medium transition-colors shadow-sm mb-2"
              title={card ? undefined : t('profile.noCard')}
            >
              {t('profile.editProfile')}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            <div className="space-y-6">
              <div>
                <h3 className="text-xl font-semibold text-primary">{user?.name || t('user.owner')}</h3>
                <p className="text-muted">{card ? card.position : t('user.owner')}</p>
              </div>
              <div className="space-y-4">
                <div className="flex items-center gap-3 text-sm">
                  <Mail className="w-5 h-5 text-muted" />
                  <span className="font-medium text-primary">{user?.email || '—'}</span>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Briefcase className="w-5 h-5 text-muted" />
                  {/* Название организации — из настроек, а не из строки в коде. */}
                  <span className="font-medium text-muted">{card ? `${orgName} · ${card.department}` : orgName}</span>
                </div>
                {card?.salary != null && card.salary > 0 && (
                  <div className="flex items-center gap-3 text-sm">
                    <span className="w-5 text-center text-muted">₮</span>
                    <span className="font-medium text-secondary tabular-nums">{money.format(card.salary)}</span>
                  </div>
                )}
              </div>

              {!card && (
                <p className="text-xs text-muted border border-dashed border-line rounded-xl p-3">
                  {t('profile.noCard')}
                </p>
              )}
            </div>

            <div className="space-y-6 border-t md:border-t-0 md:border-l border-line pt-6 md:pt-0 md:pl-8">
              <div className="space-y-3">
                <h3 className="font-semibold flex items-center gap-2 text-primary">
                  <User className="w-4 h-4 text-accent-500" />
                  {t('profile.account.title')}
                </h3>
                <p className="text-xs text-muted">
                  {user ? t('profile.account.hintSome') : t('profile.account.hintNone')}
                </p>

                <div>
                  <label htmlFor="owner-name" className="block text-xs text-muted mb-2">
                    {t('profile.account.name')}
                  </label>
                  <input
                    id="owner-name"
                    type="text"
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    className="w-full bg-app border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-primary"
                  />
                </div>

                <div>
                  <label htmlFor="owner-email" className="block text-xs text-muted mb-2">
                    {t('profile.account.email')}
                  </label>
                  <input
                    id="owner-email"
                    type="email"
                    value={accountEmail}
                    onChange={(e) => setAccountEmail(e.target.value)}
                    className="w-full bg-app border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-primary"
                  />
                </div>

                <button
                  onClick={saveAccount}
                  disabled={accountBusy}
                  className="bg-accent-500 hover:bg-accent-600 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
                >
                  {user ? t('profile.account.save') : t('profile.account.create')}
                </button>
              </div>

              <h3 className="font-semibold flex items-center gap-2 text-primary pt-4 border-t border-line">
                <Key className="w-4 h-4 text-accent-500" />
                {t('profile.security')}
              </h3>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-sm text-primary">{t('profile.password')}</p>
                </div>
                {/* Смена пароля живёт в настройках — ведём туда, а не рисуем
                    вторую форму для того же действия. */}
                <button
                  onClick={() => navigate('/settings')}
                  className="text-sm font-medium text-accent-400 hover:text-accent-300"
                >
                  {t('profile.change')}
                </button>
              </div>

              <div className="pt-4 border-t border-line space-y-4">
                <h3 className="font-semibold text-primary text-sm">{t('profile.preferences')}</h3>

                <div>
                  <label className="block text-xs text-muted mb-2">{t('settings.language')}</label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="w-full bg-app border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-primary"
                  >
                    <option value="ru">Русский</option>
                    <option value="en">English</option>
                    <option value="tk">Türkmençe</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-muted mb-2">{t('settings.theme')}</label>
                  <select
                    value={theme}
                    onChange={(e) => setTheme(e.target.value as any)}
                    className="w-full bg-app border border-line rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 text-primary"
                  >
                    <option value="light">{t('settings.light')}</option>
                    <option value="dark">{t('settings.dark')}</option>
                    <option value="system">{t('settings.system')}</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 border-t border-line pt-8">
            <div className="flex border-b border-line mb-6 overflow-x-auto">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors flex items-center gap-2 ${activeTab === tab.id ? 'border-accent-500 text-accent-400' : 'border-transparent text-muted hover:text-secondary'}`}
                >
                  <tab.icon className="w-4 h-4" /> {tab.label}
                </button>
              ))}
            </div>

            {activeTab === 'overview' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-surface-2 p-5 rounded-xl border border-line">
                  <h4 className="font-medium text-primary mb-2">{t('employees.form.hireDate')}</h4>
                  <p className="text-2xl font-semibold text-primary">{card?.hireDate ?? '—'}</p>
                </div>
                <div className="bg-surface-2 p-5 rounded-xl border border-line">
                  <h4 className="font-medium text-primary mb-2">{t('employees.col.status')}</h4>
                  <p className="text-2xl font-semibold text-primary">
                    {card
                      ? card.status === 'active' ? t('employees.status.active')
                        : card.status === 'probation' ? t('employees.status.probation')
                          : card.status === 'dismissed' ? t('employees.status.dismissed')
                            : t('employees.status.onLeave')
                      : '—'}
                  </p>
                </div>
              </div>
            )}

            {activeTab === 'timeoff' && (
              <div className="space-y-3">
                {myTimeOff.map(request => (
                  <div key={request.id} className="flex items-center justify-between p-4 bg-surface-2 border border-line rounded-xl">
                    <div>
                      <p className="font-medium text-primary">{t(`timeoff.types.${request.type}`)}</p>
                      <p className="text-sm text-muted">{request.dateFrom} — {request.dateTo}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-secondary">{request.days} {t('timeoff.daysUnit')}</p>
                      <p className="text-xs text-muted">{statusLabel(request.status)}</p>
                    </div>
                  </div>
                ))}
                {myTimeOff.length === 0 && (
                  <p className="text-sm text-muted text-center py-8">{t('profile.noTimeOff')}</p>
                )}
              </div>
            )}

            {activeTab === 'tasks' && (
              <div className="space-y-3">
                {myTasks.map(task => (
                  <div key={task.id} className="flex items-center gap-4 p-4 bg-surface-2 border border-line rounded-xl">
                    <div className={`w-5 h-5 rounded border flex items-center justify-center ${task.done ? 'bg-accent-500 border-accent-500 text-white' : 'border-strong'}`}>
                      {task.done && <CheckSquare className="w-4 h-4" />}
                    </div>
                    <div className="flex-1">
                      <p className={`font-medium ${task.done ? 'text-muted line-through' : 'text-primary'}`}>{task.title}</p>
                      {task.assignee && <p className="text-xs text-muted mt-1">{task.assignee}</p>}
                    </div>
                  </div>
                ))}
                {myTasks.length === 0 && (
                  <p className="text-sm text-muted text-center py-8">{t('profile.noTasks')}</p>
                )}
              </div>
            )}

            {activeTab === 'history' && (
              <div className="space-y-3">
                {myHistory.map(m => (
                  <div key={m.id} className="flex items-center justify-between p-4 bg-surface-2 border border-line rounded-xl">
                    <div>
                      <p className="font-medium text-primary">
                        {m.type === 'hire' ? t('movements.hire') : m.type === 'transfer' ? t('movements.transfer') : t('movements.dismissal')}
                      </p>
                      {m.toPosition && <p className="text-sm text-muted">{m.toPosition}</p>}
                    </div>
                    <span className="text-sm text-muted">{m.date}</span>
                  </div>
                ))}
                {myHistory.length === 0 && (
                  <p className="text-sm text-muted text-center py-8">{t('profile.noHistory')}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {isEditOpen && card && (
        <EmployeeForm
          initialData={card}
          onClose={() => setIsEditOpen(false)}
          onSubmit={handleEdit}
        />
      )}
    </div>
  );
}
