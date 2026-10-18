/**
 * Даты и время на экранах.
 *
 * В базе даты лежат строками ГГГГ-ММ-ДД, а моменты событий (журнал, копии) —
 * в ISO с часовым поясом UTC. Раньше и то и другое показывалось как есть:
 * формат даты из «Настроек» ни на что не влиял, а время в журнале отставало
 * от местного на разницу поясов (в Ашхабаде — на пять часов, и ночные события
 * попадали на вчерашнее число). Здесь одно место, где это превращается в
 * строку для человека.
 */
import { useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { DateFormat } from '../store/useAppStore';

const pad = (n: number) => String(n).padStart(2, '0');

/** Местная дата в виде ГГГГ-ММ-ДД. toISOString() дал бы дату по UTC. */
export function localDateISO(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Метка для имени файла по местному времени: 2026-10-17-14-30-05. */
export function fileStamp(date: Date = new Date()): string {
  return `${localDateISO(date)}-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function applyFormat(y: number, m: number, d: number, format: DateFormat): string {
  if (format === 'yyyy-MM-dd') return `${y}-${pad(m)}-${pad(d)}`;
  if (format === 'MM/dd/yyyy') return `${pad(m)}/${pad(d)}/${y}`;
  return `${pad(d)}.${pad(m)}.${y}`;
}

/** Дата ГГГГ-ММ-ДД в выбранном формате. Пустое — «—», непонятное — как есть. */
export function formatDate(value: string | null | undefined, format: DateFormat): string {
  if (!value) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return applyFormat(Number(match[1]), Number(match[2]), Number(match[3]), format);
}

/** Момент события (ISO, UTC) — местные дата и время. */
export function formatDateTime(value: string | null | undefined, format: DateFormat, withSeconds = false): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}${withSeconds ? `:${pad(date.getSeconds())}` : ''}`;
  return `${applyFormat(date.getFullYear(), date.getMonth() + 1, date.getDate(), format)} ${time}`;
}

/** Местная дата события — для фильтров «с даты». */
export function localDateOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : localDateISO(date);
}

/** Хук для экранов: форматтеры подписаны на настройку формата даты. */
export function useDates() {
  const dateFormat = useAppStore((s) => s.dateFormat);
  return useMemo(() => ({
    format: dateFormat,
    date: (value: string | null | undefined) => formatDate(value, dateFormat),
    dateTime: (value: string | null | undefined, withSeconds = false) => formatDateTime(value, dateFormat, withSeconds),
  }), [dateFormat]);
}
