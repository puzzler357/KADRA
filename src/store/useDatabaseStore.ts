import { create } from 'zustand';
import * as api from '../data';
import i18n from '../i18n';
import { ReadOnlyError } from '../data/shellDb';
import { notifyOutsideReact } from '../components/Toasts';
import { useLicenseStore } from './useLicenseStore';
import { ENTITIES, ENTITY_BY_TABLE, TABLES } from '../data/entities';
import type {
  Employee, Department, Position, TimesheetRecord, ArchiveRecord, ArchiveFilters, Template,
  Candidate, TimeOffRequest, ChecklistTask, Goal, Review, KbCategory, KbArticle, Movement, AuditEntry, ReportPreset, BackupEntry,
} from '../data/types';

// Ре-экспорт типов: страницы импортируют их из этого модуля.
export type {
  Employee, Department, Position, TimesheetRecord, ArchiveRecord, ArchiveFilters, Template,
  Candidate, TimeOffRequest, ChecklistTask, Goal, Review, KbCategory, KbArticle, Movement, MovementType, AuditEntry, ReportPreset, BackupEntry,
} from '../data/types';
export { TABLES } from '../data/entities';

// У тех, кто уже пользовался приложением, в localStorage лежит слепок стора
// от прежней версии с persist. Он больше не читается и только занимает квоту —
// удаляем один раз при загрузке модуля.
if (typeof window !== 'undefined') {
  try {
    localStorage.removeItem('hr-docs-local-db');
  } catch {
    /* приватный режим или запрет на доступ к хранилищу — не критично */
  }
}

/**
 * Режим «только чтение» по лицензии: правка не начинается вовсе.
 *
 * Это удобство, а не защита — запись отклонит оболочка Tauri
 * (src-tauri/src/db/guard.rs), что бы ни решил интерфейс. Проверка здесь
 * нужна, чтобы оптимистичные обновления стора не показывали правку, которая
 * не сохранится, и чтобы пользователь сразу увидел понятную причину.
 */
function blockedByLicense(): boolean {
  if (!useLicenseStore.getState().isReadOnly()) return false;
  notifyOutsideReact.current?.error(i18n.t('license.readOnlyError'));
  return true;
}

interface DatabaseState {
  employees: Employee[];
  addEmployee: (emp: Omit<Employee, 'id'>) => void;
  updateEmployee: (id: string, emp: Partial<Employee>) => void;
  deleteEmployee: (id: string) => void;
  setEmployees: (emps: Employee[]) => void;
  /** Массовый импорт: пишет строки в БД одной транзакцией и добавляет их в стор. */
  importEmployees: (rows: Omit<Employee, 'id'>[]) => Promise<number>;

  timesheets: TimesheetRecord[];
  addTimesheet: (record: Omit<TimesheetRecord, 'id'>) => void;
  updateTimesheet: (id: string, record: Partial<TimesheetRecord>) => void;
  deleteTimesheet: (id: string) => void;

  archives: ArchiveRecord[];
  /** Значения для фильтров архива, считанные по всей таблице. */
  archiveFacets: { years: number[]; departments: string[] };
  departments: Department[];
  positions: Position[];
  addArchive: (record: Omit<ArchiveRecord, 'id'>) => void;
  deleteArchive: (id: string) => void;
  templates: Template[];
  addTemplate: (template: Omit<Template, 'id'>) => void;
  updateTemplate: (id: string, template: Partial<Template>) => void;
  deleteTemplate: (id: string) => void;
  addDepartment: (dep: Omit<Department, 'id'>) => Promise<void>;
  updateDepartment: (id: string, data: Partial<Department>) => Promise<void>;
  deleteDepartment: (id: string) => Promise<void>;
  // Экраны подбора, отпусков, онбординга, оценки и базы знаний.
  candidates: Candidate[];
  timeOffRequests: TimeOffRequest[];
  checklistTasks: ChecklistTask[];
  goals: Goal[];
  reviews: Review[];
  kbCategories: KbCategory[];
  kbArticles: KbArticle[];
  movements: Movement[];
  auditLog: AuditEntry[];
  reportPresets: ReportPreset[];
  backups: BackupEntry[];

  addPosition: (pos: Omit<Position, 'id'>) => Promise<void>;
  updatePosition: (id: string, data: Partial<Position>) => Promise<void>;
  deletePosition: (id: string) => Promise<void>;
}

// Источник истины — SQLite; стор держит только оперативный кэш.
//
// Раньше он был обёрнут в persist без partialize, то есть все шесть массивов
// сущностей целиком уезжали в localStorage при каждой мутации. При 10 000
// сотрудников и годе табелей это выходило за квоту (~5 МБ) и заставляло
// пересериализовывать стор на каждый клик по ячейке табеля. Вторая копия
// данных вдобавок маскировала дефект импорта Excel: строки «жили» в
// localStorage, хотя в базу не попадали.
//
// Настройки интерфейса persist сохраняет — но это useAppStore, десяток
// скалярных полей, а не таблицы.
interface EntityActions {
  /** Проведение кадровой операции: запись в movements + изменение карточки. */
  applyMovement: (movement: Omit<Movement, 'id' | 'fromPosition' | 'fromDepartment' | 'fromSalary'>) => Promise<void>;
  /** Универсальные операции над таблицами из entities.ts. */
  createIn: <T extends { id: string }>(table: string, data: Omit<T, 'id'> & { id?: string }) => Promise<string>;
  updateIn: (table: string, id: string, patch: Record<string, unknown>) => Promise<void>;
  removeFrom: (table: string, id: string) => Promise<void>;
}

interface FetchActions {
  /** Идёт первичная загрузка справочников. */
  loading: boolean;
  /** Текст ошибки загрузки. null — ошибки нет. */
  error: string | null;
  fetchAll: () => Promise<void>;
  fetchTimesheets: (year: number, month: number) => Promise<void>;
  fetchArchives: (filters: ArchiveFilters) => Promise<void>;
  fetchArchiveFacets: () => Promise<void>;
}

export const useDatabaseStore = create<DatabaseState & FetchActions & EntityActions>()(
  (set) => ({
    employees: [],
    departments: [],
    positions: [],
    timesheets: [],
    archives: [],
    archiveFacets: { years: [], departments: [] },
    templates: [],

    candidates: [],
    timeOffRequests: [],
    checklistTasks: [],
    goals: [],
    reviews: [],
    kbCategories: [],
    kbArticles: [],
    movements: [],
    auditLog: [],
    reportPresets: [],
    backups: [],

    loading: false,
    error: null,

    // Справочники грузятся целиком — их размер ограничен штатом и структурой.
    // Табель и архив сюда не входят: они растут линейно по времени, и их
    // запрашивают срезом экраны, которым они нужны.
    fetchAll: async () => {
      set({ loading: true, error: null });
      try {
        const [employees, templates, departments, positions, ...entityRows] = await Promise.all([
          api.listEmployees(),
          api.listTemplates(),
          api.listDepartments(),
          api.listPositions(),
          ...ENTITIES.map((e) => api.listEntity<any>(e.table)),
        ]);

        const entityState: Record<string, unknown> = {};
        ENTITIES.forEach((e, i) => { entityState[e.stateKey] = entityRows[i]; });

        set({ employees, templates, departments, positions, ...entityState, loading: false } as any);
      } catch (e) {
        // Раньше ошибка молча уходила в консоль, и пользователь видел пустые
        // экраны без объяснения, почему они пустые.
        console.error('Failed to fetch initial data', e);
        set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },

    // Одна пара операций на все семь таблиц: расписывать 28 почти одинаковых
    // действий значило бы копировать один и тот же код с шансом разойтись.
    createIn: async (table, data) => {
      const entity = ENTITY_BY_TABLE.get(table);
      if (!entity) throw new Error(`Неизвестная таблица: ${table}`);
      // Журнал событий интерфейса (смена оформления и т.п.) в режиме
      // «только чтение» просто не пишется: тема меняется, а запись о ней —
      // не повод для сообщения об ошибке.
      if (table === TABLES.auditLog && useLicenseStore.getState().isReadOnly()) return '';
      if (blockedByLicense()) throw new ReadOnlyError();
      const { id } = await api.createEntity(table, data);
      set((state) => ({
        [entity.stateKey]: [...(state as any)[entity.stateKey], { ...data, id }],
      }) as any);
      return id;
    },

    updateIn: async (table, id, patch) => {
      if (blockedByLicense()) return;
      const entity = ENTITY_BY_TABLE.get(table);
      if (!entity) throw new Error(`Неизвестная таблица: ${table}`);
      // Сначала стор, потом БД: перетаскивание карточки и галочки в чек-листе
      // должны отзываться мгновенно.
      set((state) => ({
        [entity.stateKey]: (state as any)[entity.stateKey].map((row: any) => (row.id === id ? { ...row, ...patch } : row)),
      }) as any);
      await api.updateEntity(table, id, patch);
    },

    removeFrom: async (table, id) => {
      if (blockedByLicense()) return;
      const entity = ENTITY_BY_TABLE.get(table);
      if (!entity) throw new Error(`Неизвестная таблица: ${table}`);
      set((state) => ({
        [entity.stateKey]: (state as any)[entity.stateKey].filter((row: any) => row.id !== id),
      }) as any);
      await api.deleteEntity(table, id);
    },

    applyMovement: async (movement) => {
      if (blockedByLicense()) throw new ReadOnlyError();
      const { movement: saved, employeePatch } = await api.applyMovement(movement);
      set((state) => ({
        movements: [saved, ...state.movements],
        employees: state.employees.map((e) => (e.id === movement.employeeId ? { ...e, ...employeePatch } : e)),
      }));
    },

    fetchTimesheets: async (year, month) => {
      try {
        set({ timesheets: await api.listTimesheets(year, month) });
      } catch (e) {
        console.error('Failed to fetch timesheets', e);
      }
    },

    fetchArchives: async (filters) => {
      try {
        set({ archives: await api.listArchives(filters) });
      } catch (e) {
        console.error('Failed to fetch archives', e);
      }
    },

    fetchArchiveFacets: async () => {
      try {
        set({ archiveFacets: await api.listArchiveFacets() });
      } catch (e) {
        console.error('Failed to fetch archive facets', e);
      }
    },

    addEmployee: async (emp) => {
      if (blockedByLicense()) return;
      const { id } = await api.createEmployee(emp);
      set((state) => ({ employees: [...state.employees, { id, ...emp }] }));
    },
    updateEmployee: async (id, updated) => {
      if (blockedByLicense()) return;
      set((state) => ({ employees: state.employees.map((e) => (e.id === id ? { ...e, ...updated } : e)) }));
      await api.updateEmployee(id, updated);
    },
    deleteEmployee: async (id) => {
      if (blockedByLicense()) return;
      set((state) => ({ employees: state.employees.filter((e) => e.id !== id) }));
      await api.deleteEmployee(id);
    },
    setEmployees: (emps) => {
      set({ employees: emps });
    },
    importEmployees: async (rows) => {
      if (blockedByLicense()) throw new ReadOnlyError();
      if (rows.length === 0) return 0;
      // Сначала БД, потом стор: раньше импорт менял только стейт, и данные
      // исчезали при первом же fetchAll().
      const { ids } = await api.createEmployeesBulk(rows);
      const created = rows.map((row, i) => ({ ...row, id: ids[i] }));
      set((state) => ({ employees: [...state.employees, ...created] }));
      return created.length;
    },

    addDepartment: async (dep) => {
      if (blockedByLicense()) return;
      try {
        const { id } = await api.createDepartment(dep);
        set((s) => ({ departments: [...s.departments, { ...dep, id }] }));
      } catch (e) { console.error(e); }
    },
    updateDepartment: async (id, data) => {
      if (blockedByLicense()) return;
      try {
        await api.updateDepartment(id, data);
        set((s) => ({ departments: s.departments.map((d) => (d.id === id ? { ...d, ...data } : d)) }));
      } catch (e) { console.error(e); }
    },
    deleteDepartment: async (id) => {
      if (blockedByLicense()) return;
      try {
        await api.deleteDepartment(id);
        set((s) => ({ departments: s.departments.filter((d) => d.id !== id) }));
      } catch (e) { console.error(e); }
    },
    addPosition: async (pos) => {
      if (blockedByLicense()) return;
      try {
        const { id } = await api.createPosition(pos);
        set((s) => ({ positions: [...s.positions, { ...pos, id }] }));
      } catch (e) { console.error(e); }
    },
    updatePosition: async (id, data) => {
      if (blockedByLicense()) return;
      try {
        await api.updatePosition(id, data);
        set((s) => ({ positions: s.positions.map((p) => (p.id === id ? { ...p, ...data } : p)) }));
      } catch (e) { console.error(e); }
    },
    deletePosition: async (id) => {
      if (blockedByLicense()) return;
      try {
        await api.deletePosition(id);
        set((s) => ({ positions: s.positions.filter((p) => p.id !== id) }));
      } catch (e) { console.error(e); }
    },

    addTimesheet: async (record) => {
      if (blockedByLicense()) return;
      const { id } = await api.createTimesheet(record);
      set((state) => ({ timesheets: [...state.timesheets, { id, ...record }] }));
    },
    updateTimesheet: async (id, updated) => {
      if (blockedByLicense()) return;
      set((state) => ({ timesheets: state.timesheets.map((t) => (t.id === id ? { ...t, ...updated } : t)) }));
      await api.updateTimesheet(id, updated);
    },
    deleteTimesheet: async (id) => {
      if (blockedByLicense()) return;
      set((state) => ({ timesheets: state.timesheets.filter((t) => t.id !== id) }));
      await api.deleteTimesheet(id);
    },

    addArchive: async (record) => {
      if (blockedByLicense()) return;
      const { id } = await api.createArchive(record);
      set((state) => ({ archives: [...state.archives, { id, ...record }] }));
    },
    deleteArchive: async (id) => {
      if (blockedByLicense()) return;
      set((state) => ({ archives: state.archives.filter((a) => a.id !== id) }));
      await api.deleteArchive(id);
    },

    addTemplate: async (template) => {
      if (blockedByLicense()) return;
      const { id } = await api.createTemplate(template);
      set((state) => ({ templates: [...state.templates, { id, ...template }] }));
    },
    updateTemplate: async (id, updated) => {
      if (blockedByLicense()) return;
      set((state) => ({ templates: state.templates.map((t) => (t.id === id ? { ...t, ...updated } : t)) }));
      await api.updateTemplate(id, updated);
    },
    deleteTemplate: async (id) => {
      if (blockedByLicense()) return;
      set((state) => ({ templates: state.templates.filter((t) => t.id !== id) }));
      await api.deleteTemplate(id);
    },
  }),
);
