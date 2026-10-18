import type { Department, Employee, Position } from '../data/types';

/**
 * Занятость штатных единиц.
 *
 * Логика лежала внутри OrgChart и Reports в двух слегка разных вариантах —
 * разойтись им было нечем помешать. Здесь она одна.
 */

export interface PositionStat {
  positionId: string;
  title: string;
  department: string;
  /** Штатных единиц по расписанию. */
  total: number;
  occupied: number;
  vacant: number;
  /** Занято сверх штата: людей на должности больше, чем единиц. */
  over: number;
  salary: number;
}

/**
 * Занято ли место: сотрудник занимает должность, если совпадают и название
 * должности, и подразделение — в том числе при просмотре «по всей
 * организации». Раньше там подразделение не сверялось, и одноимённые
 * должности разных отделов («Бухгалтер» в двух местах) засчитывали друг
 * другу чужих людей.
 */
export function positionStats(
  positions: Position[],
  employees: Employee[],
  departments: Department[],
  scopeDepartmentId?: string | null,
): PositionStat[] {
  const departmentName = (id: string) => departments.find(d => d.id === id)?.name ?? '';
  const scoped = scopeDepartmentId
    ? positions.filter(p => p.departmentId === scopeDepartmentId)
    : positions;

  return scoped.map((position) => {
    const depName = departmentName(position.departmentId);
    const occupied = employees.filter((employee) =>
      employee.position === position.title
      && employee.department === depName
      // Уволенные штатную единицу не занимают.
      && employee.status !== 'dismissed',
    ).length;

    return {
      positionId: position.id,
      title: position.title,
      department: depName,
      total: position.maxCount,
      occupied,
      vacant: Math.max(0, position.maxCount - occupied),
      over: Math.max(0, occupied - position.maxCount),
      salary: position.salary,
    };
  }).sort((a, b) => b.total - a.total || a.title.localeCompare(b.title, 'ru'));
}

export interface StaffingSummary {
  total: number;
  occupied: number;
  /** Свободные единицы — сумма по должностям. */
  vacant: number;
  /** Люди сверх штата — сумма по должностям. */
  over: number;
}

/**
 * Сводка по должностям. Вакансии и перекомплект считаются по каждой
 * должности отдельно: лишний бухгалтер не закрывает вакансию инженера.
 * Раньше бралось «всего минус занято», и перекомплект в одном месте молча
 * съедал вакансии в другом.
 */
export function staffingSummary(stats: PositionStat[]): StaffingSummary {
  return stats.reduce<StaffingSummary>((sum, s) => ({
    total: sum.total + s.total,
    occupied: sum.occupied + s.occupied,
    vacant: sum.vacant + s.vacant,
    over: sum.over + s.over,
  }), { total: 0, occupied: 0, vacant: 0, over: 0 });
}

/** Месячный фонд по штатному расписанию: единицы × оклад. */
export function staffingFund(positions: Pick<Position, 'maxCount' | 'salary'>[]): number {
  return positions.reduce((sum, p) => sum + (Number(p.maxCount) || 0) * (Number(p.salary) || 0), 0);
}
