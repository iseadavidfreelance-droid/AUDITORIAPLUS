/**
 * AUDITORIAPLUS+ - Mission Store (Zustand)
 * Gestión de Estado Global de Auditoría de Inventario Físico
 * Implementación estricta según requerimientos de arquitectura CQRS y Supabase.
 */

import { create } from 'zustand';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { cacheMissionData, getCachedMissionData } from '../lib/db';
import {
  MissionMetrics,
  MissionTask,
  TaskStatus,
  normalizeSku,
} from '../types/audit';

export interface MissionState {
  // 1. Estado del Store requerido
  activeMissionId: string | null;
  activeTask: MissionTask | null;
  tasks: MissionTask[];
  metrics: MissionMetrics;
  isLoading: boolean;
  isOnline: boolean;

  // Propiedades complementarias de UI para máxima interoperabilidad
  activeMission?: MissionMetrics | null;
  searchTerm: string;

  // 2. Métodos e Indexación requeridos
  setActiveTaskBySku: (query: string) => MissionTask | null;
  fetchMissionTasks: (missionId: string) => Promise<MissionTask[]>;
  updateTaskCountLocally: (
    skuCode: string,
    countedQty: number,
    salesQty: number,
    explicitDiscrepancy?: number,
    explicitStatus?: TaskStatus
  ) => void;

  // Acciones complementarias de control
  setActiveMissionId: (missionId: string | null) => void;
  setActiveMission: (mission: MissionMetrics | null) => void;
  setTasks: (tasks: MissionTask[]) => void;
  setMetrics: (metrics: MissionMetrics) => void;
  setIsOnline: (isOnline: boolean) => void;
  setSearchTerm: (term: string) => void;
  clearActiveTask: () => void;
}

const initialMetrics: MissionMetrics = {
  totalSkus: 0,
  pendingSkus: 0,
  countedSkus: 0,
  discrepantSkus: 0,
  reconciledSkus: 0,
  totalCostDiscrepancy: 0,
};

/**
 * Función pura para recalcular métricas agregadas de la misión a partir del listado de tareas
 */
export function calculateMetricsFromTasks(
  tasks: MissionTask[],
  missionId?: string | null
): MissionMetrics {
  const totalSkus = tasks.length;
  let countedSkus = 0;
  let pendingSkus = 0;
  let discrepantSkus = 0;
  let reconciledSkus = 0;
  let totalCostDiscrepancy = 0;

  for (const t of tasks) {
    const counted = t.CountedQuantity !== null && t.CountedQuantity !== undefined;
    if (counted) {
      countedSkus++;
      const disc = Number(t.Discrepancy ?? 0);
      const cost = Number(t.Cost ?? 0);
      totalCostDiscrepancy += disc * cost;

      if (t.Status === 'RECONCILED') {
        reconciledSkus++;
      } else if (t.Status === 'DISCREPANT' || disc !== 0) {
        discrepantSkus++;
      } else if (
        t.Status === 'COMPLETED_MATCH' ||
        t.Status === 'COMPLETED' ||
        disc === 0
      ) {
        reconciledSkus++;
      }
    } else {
      pendingSkus++;
    }
  }

  return {
    totalSkus,
    pendingSkus,
    countedSkus,
    discrepantSkus,
    reconciledSkus,
    totalCostDiscrepancy: Number(totalCostDiscrepancy.toFixed(4)),
    missionId: missionId || undefined,
  };
}

export const useMissionStore = create<MissionState>((set, get) => ({
  // 1. Estado inicial
  activeMissionId: null,
  activeTask: null,
  tasks: [],
  metrics: { ...initialMetrics },
  isLoading: false,
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  activeMission: null,
  searchTerm: '',

  /**
   * 2. setActiveTaskBySku(query: string)
   * - Regla LPAD: Si `query` es numérico corto (entre 1 y 5 dígitos, ej: ^\d{1,5}$),
   *   rellena automáticamente con ceros a la izquierda hasta 6 dígitos (ej: '123' -> '000123').
   * - Búsqueda estricta: Coincidencia exacta primero por `SkuCode` y luego en el arreglo `barcodes`.
   * - Asigna la tarea encontrada a `activeTask`.
   */
  setActiveTaskBySku: (query: string): MissionTask | null => {
    if (!query || !query.trim()) {
      set({ activeTask: null, searchTerm: '' });
      return null;
    }

    const trimmed = query.trim();
    // Regla LPAD a 6 dígitos si es numérico corto (1 a 5 dígitos)
    const isShortNumeric = /^\d{1,5}$/.test(trimmed);
    const normalizedSku = isShortNumeric ? trimmed.padStart(6, '0') : trimmed;

    const { tasks } = get();

    // 1. Búsqueda exacta primero por SkuCode (con query normalizado o crudo)
    let foundTask = tasks.find((task) => {
      const code = (task.SkuCode || task.skuCode || '').trim();
      return code === normalizedSku || code === trimmed;
    });

    // 2. Si no se encontró por SkuCode, buscar en el arreglo Barcodes
    if (!foundTask) {
      foundTask = tasks.find((task) => {
        const barcodes = task.Barcodes || task.barcodes || [];
        return (
          barcodes.includes(normalizedSku) ||
          barcodes.includes(trimmed)
        );
      });
    }

    const result = foundTask || null;
    set({
      activeTask: result,
      searchTerm: query,
    });

    return result;
  },

  /**
   * 3. fetchMissionTasks(missionId: string)
   * - Carga desde Supabase (Read_Mission_Tasks) las tareas de la misión activa.
   * - Si está offline o falla la red, recurre a IndexedDB (AuditDB / missions_cache).
   * - Recalcula métricas en tiempo real y actualiza estado.
   */
  fetchMissionTasks: async (missionId: string): Promise<MissionTask[]> => {
    if (!missionId) return [];

    set({ isLoading: true, activeMissionId: missionId });

    try {
      let loadedTasks: MissionTask[] = [];

      // Intento de lectura desde Supabase si está disponible y configurado
      if (get().isOnline && isSupabaseConfigured) {
        const { data, error } = await supabase
          .from('Read_Mission_Tasks')
          .select('*')
          .eq('MissionId', missionId)
          .order('SkuCode', { ascending: true });

        if (error) {
          console.warn('[useMissionStore] Error al consultar Read_Mission_Tasks de Supabase:', error);
          throw error;
        }

        if (data && Array.isArray(data)) {
          loadedTasks = data.map((row) => {
            let barcodesArr: string[] = [];
            if (Array.isArray(row.Barcodes)) {
              barcodesArr = row.Barcodes;
            } else if (typeof row.Barcodes === 'string') {
              try {
                barcodesArr = JSON.parse(row.Barcodes);
              } catch {
                barcodesArr = [row.Barcodes];
              }
            }

            const counted = row.CountedQuantity !== null && row.CountedQuantity !== undefined
              ? Number(row.CountedQuantity)
              : null;

            return {
              TaskId: row.TaskId || row.taskId,
              MissionId: row.MissionId || row.missionId || missionId,
              DepositCode: row.DepositCode || row.depositCode || '150101',
              SkuCode: row.SkuCode || row.skuCode || '',
              SkuDescription: row.SkuDescription || row.skuDescription || '',
              Barcodes: barcodesArr,
              Cost: Number(row.Cost || row.cost || 0),
              SystemQuantity: Number(row.SystemQuantity || row.systemQuantity || 0),
              SalesDuringAudit: Number(row.SalesDuringAudit || row.salesDuringAudit || 0),
              CountedQuantity: counted,
              Discrepancy: Number(row.Discrepancy || row.discrepancy || 0),
              Status: (row.Status || row.status || 'PENDING') as TaskStatus,
              CreatedAt: row.CreatedAt || row.createdAt || new Date().toISOString(),
              UpdatedAt: row.UpdatedAt || row.updatedAt || new Date().toISOString(),
              // Mapeo camelCase
              taskId: row.TaskId || row.taskId,
              missionId: row.MissionId || row.missionId || missionId,
              depositCode: row.DepositCode || row.depositCode || '150101',
              skuCode: row.SkuCode || row.skuCode || '',
              skuDescription: row.SkuDescription || row.skuDescription || '',
              barcodes: barcodesArr,
              cost: Number(row.Cost || row.cost || 0),
              systemQuantity: Number(row.SystemQuantity || row.systemQuantity || 0),
              salesDuringAudit: Number(row.SalesDuringAudit || row.salesDuringAudit || 0),
              countedQuantity: counted,
              discrepancy: Number(row.Discrepancy || row.discrepancy || 0),
              status: (row.Status || row.status || 'PENDING') as TaskStatus,
            };
          });

          // Guardar en caché local IndexedDB para acceso sin conexión
          const calculatedMetrics = calculateMetricsFromTasks(loadedTasks, missionId);
          await cacheMissionData(missionId, {
            metrics: calculatedMetrics,
            tasks: loadedTasks,
          }).catch((err) => {
            console.warn('[useMissionStore] No se pudo cachear en IndexedDB:', err);
          });
        }
      } else {
        // Modo Offline: recuperar desde caché local IndexedDB
        const cached = await getCachedMissionData(missionId);
        if (cached && cached.tasks) {
          loadedTasks = cached.tasks;
        }
      }

      // Recalcular métricas consolidadas
      const newMetrics = calculateMetricsFromTasks(loadedTasks, missionId);

      set({
        tasks: loadedTasks,
        metrics: newMetrics,
        isLoading: false,
        activeMission: {
          ...newMetrics,
          missionId,
          name: `Misión ${missionId.slice(0, 8)}`,
        },
      });

      return loadedTasks;
    } catch (err) {
      console.warn('[useMissionStore] Fallback a caché IndexedDB por error:', err);
      // Fallback a caché local ante error de red
      const cached = await getCachedMissionData(missionId).catch(() => null);
      if (cached && cached.tasks) {
        const fallbackMetrics = calculateMetricsFromTasks(cached.tasks, missionId);
        set({
          tasks: cached.tasks,
          metrics: fallbackMetrics,
          isLoading: false,
          activeMission: {
            ...fallbackMetrics,
            missionId,
          },
        });
        return cached.tasks;
      }

      set({ isLoading: false });
      return [];
    }
  },

  /**
   * 4. updateTaskCountLocally(skuCode, countedQty, salesQty)
   * - Actualiza localmente el estado de la tarea en caliente mientras se confirma en backend.
   * - Aplica la ecuación: Discrepancy = CountedQuantity - (SystemQuantity - SalesDuringAudit).
   * - Asigna estado: COMPLETED_MATCH si discrepancy === 0, sino DISCREPANT.
   * - Recalcula métricas: totalSkus, countedSkus, pendingSkus, discrepantSkus, reconciledSkus.
   */
  updateTaskCountLocally: (
    skuCode: string,
    countedQty: number,
    salesQty: number,
    explicitDiscrepancy?: number,
    explicitStatus?: TaskStatus
  ) => {
    const trimmed = skuCode.trim();
    const normalizedSku = normalizeSku(trimmed);

    set((state) => {
      let updatedActiveTask = state.activeTask;

      const updatedTasks = state.tasks.map((task) => {
        const code = (task.SkuCode || task.skuCode || '').trim();
        const matches =
          code === normalizedSku ||
          code === trimmed ||
          (task.Barcodes || task.barcodes || []).includes(normalizedSku) ||
          (task.Barcodes || task.barcodes || []).includes(trimmed);

        if (!matches) return task;

        const systemQty = Number(task.SystemQuantity ?? task.systemQuantity ?? 0);
        const adjustedTheoretical = systemQty - salesQty;
        const discrepancy =
          explicitDiscrepancy !== undefined
            ? explicitDiscrepancy
            : Number((countedQty - adjustedTheoretical).toFixed(2));

        const status: TaskStatus =
          explicitStatus || (discrepancy === 0 ? 'COMPLETED_MATCH' : 'DISCREPANT');

        const updated: MissionTask = {
          ...task,
          CountedQuantity: countedQty,
          countedQuantity: countedQty,
          SalesDuringAudit: salesQty,
          salesDuringAudit: salesQty,
          Discrepancy: discrepancy,
          discrepancy: discrepancy,
          Status: status,
          status: status,
          UpdatedAt: new Date().toISOString(),
        };

        if (
          state.activeTask &&
          ((state.activeTask.SkuCode || state.activeTask.skuCode) === code ||
            (state.activeTask.TaskId || state.activeTask.taskId) === (task.TaskId || task.taskId))
        ) {
          updatedActiveTask = updated;
        }

        return updated;
      });

      // Recalcular métricas
      const newMetrics = calculateMetricsFromTasks(updatedTasks, state.activeMissionId);

      return {
        tasks: updatedTasks,
        activeTask: updatedActiveTask,
        metrics: newMetrics,
        activeMission: state.activeMission
          ? {
              ...state.activeMission,
              ...newMetrics,
            }
          : {
              ...newMetrics,
              missionId: state.activeMissionId || undefined,
            },
      };
    });
  },

  // Acciones adicionales de conveniencia
  setActiveMissionId: (missionId) => set({ activeMissionId: missionId }),

  setActiveMission: (mission) =>
    set({
      activeMission: mission,
      activeMissionId: mission?.missionId || null,
      metrics: mission
        ? {
            totalSkus: mission.totalSkus,
            pendingSkus: mission.pendingSkus,
            countedSkus: mission.countedSkus,
            discrepantSkus: mission.discrepantSkus,
            reconciledSkus: mission.reconciledSkus,
            totalCostDiscrepancy: mission.totalCostDiscrepancy,
            missionId: mission.missionId,
          }
        : { ...initialMetrics },
    }),

  setTasks: (taskList) => {
    set((state) => {
      const newMetrics = calculateMetricsFromTasks(taskList, state.activeMissionId);
      return {
        tasks: taskList,
        metrics: newMetrics,
        activeMission: state.activeMission
          ? { ...state.activeMission, ...newMetrics }
          : { ...newMetrics, missionId: state.activeMissionId || undefined },
      };
    });
  },

  setMetrics: (metrics) => set({ metrics }),

  setIsOnline: (isOnline) => set({ isOnline }),

  setSearchTerm: (term) => set({ searchTerm: term }),

  clearActiveTask: () => set({ activeTask: null, searchTerm: '' }),
}));
