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

  // --- NUEVAS VARIABLES FASE 2: ENRIQUECEDOR API ---
  isEnriching: boolean;
  enrichProgress: { current: number; total: number };
  runMissionEnrichment: (missionId: string, depositCode: string) => Promise<void>;

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

  // --- ESTADOS INICIALES FASE 2 ---
  isEnriching: false,
  enrichProgress: { current: 0, total: 0 },

  // --- MOTOR ENRIQUECEDOR (COMPONENTE A) ---
  runMissionEnrichment: async (missionId: string, depositCode: string) => {
    set({ isEnriching: true, enrichProgress: { current: 0, total: 0 } });
    
    try {
      const { data: tasksToEnrich, error } = await supabase
        .from('Read_Mission_Tasks')
        .select('*')
        .eq('MissionId', missionId);

      if (error || !tasksToEnrich) throw error;

      set({ enrichProgress: { current: 0, total: tasksToEnrich.length } });
      let currentVal = 0;

      for (const task of tasksToEnrich) {
        try {
          const sku = task.SkuCode;
          const res = await fetch(`https://192.168.15.225:3002/api/inventory?search=${sku}`);
          
          if (res.ok) {
            const json = await res.json();

            if (json.success && json.data && json.data.length > 0) {
              const apiItem = json.data.find((d: any) => d.codigo_deposito === depositCode) || json.data[0];

              const precioFinalAPI = apiItem.precio_final || 0;
              const precioRedondeado = Number(Number(precioFinalAPI).toFixed(2));
              
              let extractedBarcodes: string[] = [];
              
              if (Array.isArray(apiItem.codigos_barras)) {
                extractedBarcodes = [...extractedBarcodes, ...apiItem.codigos_barras];
              } else if (typeof apiItem.codigos_barras === 'string') {
                extractedBarcodes = [...extractedBarcodes, ...apiItem.codigos_barras.split(',')];
              }

              const possibleKeys = ['codigo_barras', 'codigo_barra', 'cod_barras', 'barcode', 'ean', 'upc'];
              possibleKeys.forEach(key => {
                if (apiItem[key]) {
                  if (typeof apiItem[key] === 'string') {
                    extractedBarcodes = [...extractedBarcodes, ...apiItem[key].split(',')];
                  } else if (Array.isArray(apiItem[key])) {
                    extractedBarcodes = [...extractedBarcodes, ...apiItem[key]];
                  }
                }
              });

              if (apiItem.product_code) extractedBarcodes.push(String(apiItem.product_code));
              if (sku) extractedBarcodes.push(String(sku));

              const cleanBarcodes = Array.from(
                new Set(
                  extractedBarcodes
                    .map(b => String(b).trim())
                    .filter(b => b !== '' && b !== 'null' && b !== 'undefined')
                )
              );

              // 🛡️ BLINDAJE CONTRA EL "SILENT DROP" DE SUPABASE
              // Garantizamos que nunca enviemos un arreglo vacío y lo convertimos a string JSON puro
              const barcodesPayload = cleanBarcodes.length > 0 ? cleanBarcodes : [sku];

              const { error: updateErr } = await supabase
                .from('Read_Mission_Tasks')
                .update({
                  Cost: precioRedondeado,
                  Barcodes: JSON.stringify(barcodesPayload) // <--- TRUCO MAGISTRAL AQUÍ
                })
                .eq('TaskId', task.TaskId);

              if (updateErr) {
                console.error(`[Supabase] Error guardando SKU ${sku}:`, updateErr);
              } else {
                console.log(`[Éxito] SKU ${sku} guardado. Costo: $${precioRedondeado} | Barras:`, barcodesPayload);
              }
            }
          }
        } catch (err) {
          console.warn(`[API] Error enriqueciendo SKU ${task.SkuCode}:`, err);
        }

        currentVal++;
        set({ enrichProgress: { current: currentVal, total: tasksToEnrich.length } });
        await new Promise(resolve => setTimeout(resolve, 400));
      }

      get().fetchMissionTasks(missionId);

    } catch (error) {
      console.error("Fallo general en el enriquecimiento:", error);
    } finally {
      set({ isEnriching: false });
    }
  },

  /**
   * 2. setActiveTaskBySku(query: string)
   */
  setActiveTaskBySku: (query: string): MissionTask | null => {
    if (!query || !query.trim()) {
      set({ activeTask: null, searchTerm: '' });
      return null;
    }

    const trimmed = query.trim();
    const isShortNumeric = /^\d{1,5}$/.test(trimmed);
    const normalizedSku = isShortNumeric ? trimmed.padStart(6, '0') : trimmed;

    const { tasks } = get();

    let foundTask = tasks.find((task) => {
      const code = (task.SkuCode || task.skuCode || '').trim();
      return code === normalizedSku || code === trimmed;
    });

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
   */
  fetchMissionTasks: async (missionId: string): Promise<MissionTask[]> => {
    if (!missionId) return [];

    set({ isLoading: true, activeMissionId: missionId });

    try {
      let loadedTasks: MissionTask[] = [];

      if (get().isOnline && isSupabaseConfigured) {
        const { data, error } = await supabase
          .from('Read_Mission_Tasks')
          .select('*')
          .eq('MissionId', missionId)
          .order('SkuCode', { ascending: true });

        if (error) {
          console.warn('[useMissionStore] Error al consultar Read_Mission_Tasks:', error);
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

          const calculatedMetrics = calculateMetricsFromTasks(loadedTasks, missionId);
          await cacheMissionData(missionId, {
            metrics: calculatedMetrics,
            tasks: loadedTasks,
          }).catch((err) => {
            console.warn('[useMissionStore] No se pudo cachear en IndexedDB:', err);
          });
        }
      } else {
        const cached = await getCachedMissionData(missionId);
        if (cached && cached.tasks) {
          loadedTasks = cached.tasks;
        }
      }

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