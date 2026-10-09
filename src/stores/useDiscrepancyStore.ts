import { create } from 'zustand';
import { FloorDiscrepancy, VirtualTransfer } from '../types/audit';
import { supabase } from '../lib/supabase';

interface DiscrepancyState {
  pendingFloorDiscrepancies: FloorDiscrepancy[];
  virtualTransfers: VirtualTransfer[];
  isLoading: boolean;
  
  // Setters
  setPendingDiscrepancies: (discrepancies: FloorDiscrepancy[]) => void;
  setVirtualTransfers: (transfers: VirtualTransfer[]) => void; // <-- FUNCIÓN FALTANTE INYECTADA
  
  // Actions
  addDiscrepancy: (item: FloorDiscrepancy) => void;
  resolveDiscrepancyLocally: (discrepancyId: string, targetQty: number, transfer?: VirtualTransfer) => void;
  fetchPendingDiscrepancies: (missionId: string) => Promise<void>;
  clearStore: () => void;
}

export const useDiscrepancyStore = create<DiscrepancyState>((set) => ({
  pendingFloorDiscrepancies: [],
  virtualTransfers: [],
  isLoading: false,

  setPendingDiscrepancies: (discrepancies) => set({ pendingFloorDiscrepancies: discrepancies }),

  // La función que evitaba que los componentes renderizaran tras dar F5
  setVirtualTransfers: (transfers) => set({ virtualTransfers: transfers }),

  // Actualización optimista cuando se escanea
  addDiscrepancy: (item) => set((state) => {
    // Evitar duplicados visuales
    const filtered = state.pendingFloorDiscrepancies.filter(d => d.skuCode !== item.skuCode);
    return { pendingFloorDiscrepancies: [...filtered, item] };
  }),

  // Resolución local cuando se cuenta en piso (Reforzada contra fantasmas)
  resolveDiscrepancyLocally: (discrepancyId, targetQty, transfer) => {
    set((state) => ({
      pendingFloorDiscrepancies: state.pendingFloorDiscrepancies.filter(
        d => d.discrepancyId !== discrepancyId && (d as any).DiscrepancyId !== discrepancyId
      ),
      virtualTransfers: transfer ? [transfer, ...state.virtualTransfers] : state.virtualTransfers
    }));
  },

  // Sincronización con la Base de Datos (Tu lógica intacta)
  fetchPendingDiscrepancies: async (missionId) => {
    set({ isLoading: true });
    try {
      const { data, error } = await supabase
        .from('Read_Floor_Discrepancies')
        .select('*')
        .eq('MissionId', missionId)
        .eq('Status', 'PENDING_TARGET_COUNT'); // <-- El nuevo estado agnóstico

      if (!error && data) {
        // Traductor: De Columnas Supabase a Variables React
        const mappedData: FloorDiscrepancy[] = data.map(item => ({
          discrepancyId: item.DiscrepancyId,
          missionId: item.MissionId,
          taskId: item.TaskId || '', 
          skuCode: item.SkuCode,
          skuDescription: item.SkuDescription,
          originDeposit: item.OriginDeposit as any,
          targetDeposit: item.TargetDeposit as any,
          originDiscrepancy: item.OriginDiscrepancy, // <-- El nuevo nombre de columna
          targetSystemQuantity: item.TargetSystemQuantity,
          targetCountedQuantity: item.TargetCountedQuantity,
          targetDiscrepancy: item.TargetDiscrepancy,
          status: item.Status as any,
          resolvedAt: null
        }));
        set({ pendingFloorDiscrepancies: mappedData });
      } else if (error) {
        console.error("Error leyendo discrepancias de BD:", error.message);
      }
    } catch (err) {
      console.error("Fallo de red al buscar discrepancias:", err);
    } finally {
      set({ isLoading: false });
    }
  },

  // Limpiador para cambios de sesión o de misión
  clearStore: () => set({ pendingFloorDiscrepancies: [], virtualTransfers: [], isLoading: false })
}));