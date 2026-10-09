import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Users, FileText, Network, BarChart as BarChartIcon, Gift } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useDatabaseStore } from '../store/useDatabaseStore';
import { useMoney } from '../lib/money';
import { payrollTotal } from '../lib/payroll';
import { positionStats, staffingSummary } from '../lib/staffing';
import { auditActionLabel, auditEntityLabel, auditTime } from '../lib/audit';
import { CardsSkeleton } from '../components/States';
import { clickable } from '../lib/a11y';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#3b82f6', '#ec4899'];

export default function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { employees, positions, departments, auditLog, loading } = useDatabaseStore();
  const templateCount = useDatabaseStore(s => s.templates.length);
  const money = useMoney();

  const birthdaysToday = useMemo(() => {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentDay = today.getDate();
    
    return employees.filter(emp => {
      if (!emp.birthDate) return false;
      const [, month, day] = emp.birthDate.split('-');
      return parseInt(month, 10) === currentMonth && parseInt(day, 10) === currentDay;
    });
  }, [employees]);

  // Расчёт вынесен в src/lib/payroll.ts и покрыт тестами. Заодно убрана
  // подстановка 85 000 каждому сотруднику без оклада: это были выдуманные
  // деньги в отчётной цифре.
  const totalFOT = useMemo(() => payrollTotal(employees), [employees]);

  // Вакансии считаются по штатному расписанию — тем же кодом, что и сводка
  // в «Штатном расписании». Раньше здесь стояла формула-заглушка
  // max(N + 4, 10) − N, дававшая 4 при любом штате от шести человек.
  const vacancies = useMemo(
    () => staffingSummary(positionStats(positions, employees, departments)).vacant,
    [positions, employees, departments],
  );

  // Недавние события — последние записи журнала аудита. Раньше здесь висели
  // две неизменные строки про «Смирнову А.», не связанные ни с чем.
  const recentEvents = useMemo(
    () => [...auditLog].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 6),
    [auditLog],
  );

  const departmentData = useMemo(() => {
    const counts: Record<string, number> = {};
    employees.forEach(emp => {
      counts[emp.department] = (counts[emp.department] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [employees]);

  // Пока справочники не пришли, показываем скелет: пустые плитки с нулями
  // выглядят как ответ, хотя ответа ещё нет.
  if (loading && employees.length === 0) {
    return (
      <div className="space-y-6">
        <CardsSkeleton count={4} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div
          {...clickable(() => navigate('/employees'))}
          className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm cursor-pointer hover:border-accent-500/50 hover:shadow-md transition-all"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-muted">{t('nav.employees')}</h3>
            <Users className="w-5 h-5 text-accent-500" />
          </div>
          <p className="text-3xl font-semibold tabular-nums text-primary dark:text-primary">{employees.length}</p>
          <p className="text-sm text-emerald-600 mt-2">{t('dashboard.totalInBase')}</p>
        </div>
        
        <div
          {...clickable(() => navigate('/org-chart'))}
          className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm cursor-pointer hover:border-accent-500/50 hover:shadow-md transition-all"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-muted">{t('dashboard.vacancies')}</h3>
            <Network className="w-5 h-5 text-amber-500" />
          </div>
          <p className="text-3xl font-semibold tabular-nums text-primary dark:text-primary">{vacancies}</p>
          <p className="text-sm text-amber-600 mt-2">{t('dashboard.needsAttention')}</p>
        </div>
        
        <div
          {...clickable(() => navigate('/templates'))}
          className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm cursor-pointer hover:border-accent-500/50 hover:shadow-md transition-all"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-muted">{t('nav.templates')}</h3>
            <FileText className="w-5 h-5 text-emerald-500" />
          </div>
          <p className="text-3xl font-semibold tabular-nums text-primary dark:text-primary">{templateCount}</p>
          <p className="text-sm text-muted mt-2">{t('dashboard.activeTemplates')}</p>
        </div>

        <div
          {...clickable(() => navigate('/reports'))}
          className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm cursor-pointer hover:border-accent-500/50 hover:shadow-md transition-all"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-muted">{t('dashboard.payroll')}</h3>
            <BarChartIcon className="w-5 h-5 text-rose-500" />
          </div>
          <p className="text-3xl font-semibold tabular-nums text-primary dark:text-primary">{money.format(totalFOT, { compact: true })}</p>
          <p className="text-sm text-muted mt-2">{t('dashboard.perMonth')}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm min-h-[300px]">
          <h3 className="text-lg font-semibold mb-4">{t('dashboard.recentEvents')}</h3>
          <div className="space-y-4">
            {recentEvents.map(event => (
              <div key={event.id} className="flex gap-4">
                <div className="w-2 h-2 mt-2 rounded-full bg-accent-500 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="font-medium text-sm text-primary dark:text-slate-100">
                    {auditActionLabel(t, event.action)}
                  </p>
                  <p className="text-sm text-muted truncate" title={event.diff || undefined}>
                    {auditEntityLabel(t, event.entity)}{event.diff ? ' · ' + event.diff : ''}
                  </p>
                  <p className="text-xs text-muted mt-1 tabular-nums">{auditTime(event.ts)}</p>
                </div>
              </div>
            ))}
            {recentEvents.length === 0 && (
              <p className="text-sm text-muted">{t('dashboard.noEvents')}</p>
            )}
          </div>
        </div>
        <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm min-h-[300px]">
          <div className="flex items-center gap-2 mb-4">
            <Gift className="w-5 h-5 text-rose-500" />
            <h3 className="text-lg font-semibold">{t('dashboard.birthdaysToday')}</h3>
          </div>
          {birthdaysToday.length > 0 ? (
            <div className="space-y-4">
              {birthdaysToday.map(emp => (
                <div key={emp.id} className="flex items-center gap-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20">
                  <div className="w-10 h-10 rounded-full bg-rose-500/20 text-rose-500 flex items-center justify-center font-bold text-lg">
                    {emp.fullName.charAt(0)}
                  </div>
                  <div>
                    <p className="font-medium text-primary dark:text-slate-100">{emp.fullName}</p>
                    <p className="text-sm text-muted">{emp.position}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-40 text-muted">
              <Gift className="w-8 h-8 mb-2 opacity-20" />
              <p className="text-sm">{t('dashboard.noBirthdays')}</p>
            </div>
          )}
        </div>
        <div className="bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm min-h-[300px] flex flex-col">
          <h3 className="text-lg font-semibold mb-4">{t('dashboard.employeesByDept')}</h3>
          <div className="flex-1 min-h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={departmentData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-color)" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12 }} />
                <Tooltip 
                  cursor={{ fill: 'var(--border-color)', opacity: 0.4 }}
                  contentStyle={{ borderRadius: '12px', border: '1px solid var(--border-color)', backgroundColor: 'var(--sidebar-bg)', color: 'var(--foreground)' }}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {departmentData.map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
