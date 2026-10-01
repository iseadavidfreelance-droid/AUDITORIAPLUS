/**
 * AUDITORIAPLUS+ - Discrepancy Store (Zustand)
 * Gestión de Discrepancias en Piso de Venta (150103) y Traslados Virtuales (150104)
 */

import { create } from 'zustand';
import { FloorDiscrepancy, VirtualTransfer } from '../types/audit';

interface DiscrepancyState {
  pendingFloorDiscrepancies: FloorDiscrepancy[];
  virtualTransfers: VirtualTransfer[];
  isLoading: boolean;

  setPendingDiscrepancies: (discrepancies: FloorDiscrepancy[]) => void;
  addDiscrepancy: (discrepancy: FloorDiscrepancy) => void;
  resolveDiscrepancyLocally: (
    discrepancyId: string,
    floorQty: number,
    transfer?: VirtualTransfer
  ) => void;
  setVirtualTransfers: (transfers: VirtualTransfer[]) => void;
}

export const useDiscrepancyStore = create<DiscrepancyState>((set) => ({
  pendingFloorDiscrepancies: [],
  virtualTransfers: [],
  isLoading: false,

  setPendingDiscrepancies: (discrepancies) =>
    set({ pendingFloorDiscrepancies: discrepancies }),

  addDiscrepancy: (discrepancy) =>
    set((state) => ({
      pendingFloorDiscrepancies: [
        discrepancy,
        ...state.pendingFloorDiscrepancies.filter(
          (d) =>
            (d.DiscrepancyId || d.discrepancyId) !==
            (discrepancy.DiscrepancyId || discrepancy.discrepancyId)
        ),
      ],
    })),

  resolveDiscrepancyLocally: (discrepancyId, _floorQty, transfer) => {
    set((state) => ({
      pendingFloorDiscrepancies: state.pendingFloorDiscrepancies.filter(
        (d) => (d.DiscrepancyId || d.discrepancyId) !== discrepancyId
      ),
      virtualTransfers: transfer
        ? [transfer, ...state.virtualTransfers]
        : state.virtualTransfers,
    }));
  },

  setVirtualTransfers: (transfers) => set({ virtualTransfers: transfers }),
}));
