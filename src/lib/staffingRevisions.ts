/**
 * Редакции штатного расписания.
 *
 * Редакция — снимок подразделений и должностей на дату вступления в силу.
 * Раньше кнопка «Новая редакция» ничего не делала: история изменений штата
 * нигде не сохранялась, и сравнить «как было» с «как стало» было не с чем.
 */
import type { Department, Position } from '../data/types';
import { staffingFund } from './staffing';

export interface StaffingSnapshot {
  departments: { id: string; name: string; parentId: string | null }[];
  positions: { id: string; departmentId: string; title: string; maxCount: number; salary: number }[];
}

export function makeSnapshot(departments: Department[], positions: Position[]): StaffingSnapshot {
  return {
    departments: departments.map((d) => ({ id: d.id, name: d.name, parentId: d.parentId ?? null })),
    positions: positions.map((p) => ({
      id: p.id, departmentId: p.departmentId, title: p.title,
      maxCount: Number(p.maxCount) || 0, salary: Number(p.salary) || 0,
    })),
  };
}

/** Разбор сохранённого снимка. Испорченная строка — пустая редакция, а не падение экрана. */
export function parseSnapshot(raw: string | null | undefined): StaffingSnapshot {
  try {
    const value = JSON.parse(raw || '{}');
    return {
      departments: Array.isArray(value.departments) ? value.departments : [],
      positions: Array.isArray(value.positions) ? value.positions : [],
    };
  } catch {
    return { departments: [], positions: [] };
  }
}

export type DiffStatus = 'added' | 'removed' | 'changed' | 'same';

export interface PositionDiff {
  key: string;
  department: string;
  title: string;
  beforeUnits: number | null;
  afterUnits: number | null;
  beforeSalary: number | null;
  afterSalary: number | null;
  status: DiffStatus;
}

export interface SnapshotTotals {
  departments: number;
  positions: number;
  units: number;
  fund: number;
}

export const snapshotTotals = (s: StaffingSnapshot): SnapshotTotals => ({
  departments: s.departments.length,
  positions: s.positions.length,
  units: s.positions.reduce((sum, p) => sum + (Number(p.maxCount) || 0), 0),
  fund: staffingFund(s.positions),
});

/**
 * Сравнение двух снимков по должностям. Должность узнаётся по
 * идентификатору: переименованная или перенесённая должность — это
 * «изменена», а не «удалена и добавлена».
 */
export function compareSnapshots(before: StaffingSnapshot, after: StaffingSnapshot): PositionDiff[] {
  const depName = (s: StaffingSnapshot, id: string) => s.departments.find((d) => d.id === id)?.name ?? '—';
  const beforeById = new Map(before.positions.map((p) => [p.id, p]));
  const afterById = new Map(after.positions.map((p) => [p.id, p]));
  const rows: PositionDiff[] = [];

  for (const p of after.positions) {
    const old = beforeById.get(p.id);
    const department = depName(after, p.departmentId);
    if (!old) {
      rows.push({ key: p.id, department, title: p.title, beforeUnits: null, afterUnits: p.maxCount, beforeSalary: null, afterSalary: p.salary, status: 'added' });
      continue;
    }
    const same = old.maxCount === p.maxCount && old.salary === p.salary && old.title === p.title
      && depName(before, old.departmentId) === department;
    rows.push({
      key: p.id, department, title: p.title,
      beforeUnits: old.maxCount, afterUnits: p.maxCount, beforeSalary: old.salary, afterSalary: p.salary,
      status: same ? 'same' : 'changed',
    });
  }
  for (const p of before.positions) {
    if (afterById.has(p.id)) continue;
    rows.push({
      key: p.id, department: depName(before, p.departmentId), title: p.title,
      beforeUnits: p.maxCount, afterUnits: null, beforeSalary: p.salary, afterSalary: null, status: 'removed',
    });
  }

  const order: Record<DiffStatus, number> = { changed: 0, added: 1, removed: 2, same: 3 };
  return rows.sort((a, b) => order[a.status] - order[b.status]
    || a.department.localeCompare(b.department, 'ru') || a.title.localeCompare(b.title, 'ru'));
}
