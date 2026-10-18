import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Cake, Award, Plane } from 'lucide-react';
import {
  addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth,
  isToday, parseISO, startOfDay, startOfMonth, startOfWeek,
} from 'date-fns';
import { useDatabaseStore } from '../store/useDatabaseStore';

type EventKind = 'birthday' | 'anniversary' | 'timeOff';

interface CalendarEvent {
  id: string;
  date: Date;
  kind: EventKind;
  title: string;
  subtitle?: string;
}

/** Безопасный разбор даты из базы: пустые и битые значения просто отбрасываем. */
function toDate(value?: string): Date | null {
  if (!value) return null;
  const parsed = parseISO(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Дата ежегодного события (день рождения, годовщина) в заданном году. */
function inYear(date: Date, year: number): Date {
  return new Date(year, date.getMonth(), date.getDate());
}

const KIND_ICON: Record<EventKind, typeof Cake> = {
  birthday: Cake,
  anniversary: Award,
  timeOff: Plane,
};

const KIND_COLOR: Record<EventKind, string> = {
  birthday: 'text-rose-800 dark:text-rose-300 bg-rose-500/10',
  anniversary: 'text-amber-800 dark:text-amber-300 bg-amber-500/10',
  timeOff: 'text-accent-700 dark:text-accent-300 bg-accent-500/10',
};

export default function CalendarView() {
  const { t } = useTranslation();
  const { employees, timeOffRequests } = useDatabaseStore();

  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  const weekdays = t('calendar.weekdays', { returnObjects: true }) as string[];
  const months = t('timesheet.months', { returnObjects: true }) as string[];

  // Сетка месяца считается по-настоящему: раньше здесь были 31 ячейка,
  // две пустые заглушки в начале и четыре в конце — вне зависимости от месяца.
  const gridDays = useMemo(() => eachDayOfInterval({
    start: startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }),
  }), [cursor]);

  const events = useMemo(() => {
    const result: CalendarEvent[] = [];
    const year = cursor.getFullYear();

    for (const emp of employees) {
      const birth = toDate(emp.birthDate);
      if (birth) {
        result.push({
          id: `b-${emp.id}`,
          date: inYear(birth, year),
          kind: 'birthday',
          title: emp.fullName,
          subtitle: t('calendar.birthday'),
        });
      }

      const hired = toDate(emp.hireDate);
      // Сам день приёма годовщиной не считается — она начинается через год.
      if (hired && hired.getFullYear() < year) {
        result.push({
          id: `a-${emp.id}`,
          date: inYear(hired, year),
          kind: 'anniversary',
          title: emp.fullName,
          subtitle: `${t('calendar.anniversary')} · ${year - hired.getFullYear()}`,
        });
      }
    }

    for (const request of timeOffRequests) {
      if (request.status === 'rejected') continue;
      const from = toDate(request.dateFrom);
      const to = toDate(request.dateTo);
      if (!from || !to || to < from) continue;

      const name = employees.find(e => e.id === request.employeeId)?.fullName ?? '—';
      for (const day of eachDayOfInterval({ start: from, end: to })) {
        result.push({
          id: `t-${request.id}-${format(day, 'yyyy-MM-dd')}`,
          date: day,
          kind: 'timeOff',
          title: name,
          subtitle: t(`timeoff.types.${request.type}`),
        });
      }
    }

    return result;
  }, [employees, timeOffRequests, cursor, t]);

  const eventsOn = (day: Date) => events.filter(e => isSameDay(e.date, day));

  // Ближайшие события — на 60 дней вперёд от сегодняшнего дня, независимо
  // от того, какой месяц открыт в сетке.
  const upcoming = useMemo(() => {
    const today = startOfDay(new Date());
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + 60);

    return events
      .filter(e => e.date >= today && e.date <= horizon)
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(0, 12);
  }, [events]);

  const daysUntil = (date: Date) =>
    Math.round((startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / 86_400_000);

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">{t('nav.calendar')}</h2>
        <div className="flex items-center bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-xl overflow-hidden">
          <button
            onClick={() => setCursor(addMonths(cursor, -1))}
            aria-label={t('timesheet.prevMonth')}
            className="p-2 hover:bg-surface-hover dark:hover:bg-slate-800 transition-colors"
          >
            <ChevronLeft className="w-5 h-5 text-muted" />
          </button>
          <span className="px-6 font-medium text-sm" data-testid="calendar-month">{months[cursor.getMonth()]} {cursor.getFullYear()}</span>
          <button
            onClick={() => setCursor(addMonths(cursor, 1))}
            aria-label={t('timesheet.nextMonth')}
            className="p-2 hover:bg-surface-hover dark:hover:bg-slate-800 transition-colors"
          >
            <ChevronRight className="w-5 h-5 text-muted" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex gap-6 min-h-0">
        <div className="flex-1 bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm flex flex-col overflow-hidden">
          <div className="grid grid-cols-7 border-b border-[var(--border-color)] bg-surface-2 dark:bg-slate-900/50">
            {weekdays.map(day => (
              <div key={day} className="py-3 text-center text-xs font-medium text-muted">
                {day}
              </div>
            ))}
          </div>

          <div className="flex-1 grid grid-cols-7 bg-[var(--border-color)] gap-[1px] overflow-y-auto auto-rows-fr">
            {gridDays.map(day => {
              const dayEvents = eventsOn(day);
              const outside = !isSameMonth(day, cursor);

              return (
                <div
                  key={day.toISOString()}
                  className={`bg-[var(--sidebar-bg)] p-2 min-h-[100px] transition-colors hover:bg-surface-hover dark:hover:bg-slate-900/50 ${isToday(day) ? 'ring-1 ring-inset ring-accent-500' : ''}`}
                >
                  <span className={`text-sm font-medium ${outside ? 'text-faint' : isToday(day) ? 'text-accent-700 dark:text-accent-300' : 'text-secondary'}`}>
                    {day.getDate()}
                  </span>

                  <div className="mt-1 space-y-1">
                    {dayEvents.slice(0, 3).map(event => {
                      const Icon = KIND_ICON[event.kind];
                      return (
                        <div
                          key={event.id}
                          title={`${event.title} — ${event.subtitle ?? ''}`}
                          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] truncate ${KIND_COLOR[event.kind]}`}
                        >
                          <Icon className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{event.title}</span>
                        </div>
                      );
                    })}
                    {dayEvents.length > 3 && (
                      <p className="text-[11px] text-muted pl-1.5">+{dayEvents.length - 3}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="w-80 bg-[var(--sidebar-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm p-6 flex flex-col">
          <h3 className="font-semibold text-lg border-b border-[var(--border-color)] pb-4 mb-4">{t('calendar.upcoming')}</h3>

          {upcoming.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-muted text-sm">
              {t('calendar.noEvents')}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar">
              {upcoming.map(event => {
                const Icon = KIND_ICON[event.kind];
                const days = daysUntil(event.date);
                return (
                  <div key={event.id} className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${KIND_COLOR[event.kind]}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-primary truncate">{event.title}</p>
                      <p className="text-xs text-muted truncate">{event.subtitle}</p>
                      <p className="text-xs text-faint mt-0.5">
                        {format(event.date, 'dd.MM')} · {days === 0 ? t('calendar.today') : t('calendar.inDays', { n: days })}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
