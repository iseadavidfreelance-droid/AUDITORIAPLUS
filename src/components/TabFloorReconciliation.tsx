/**
 * AUDITORIAPLUS+ - Tab 3: Reconciliación Bidireccional (Agnóstica)
 * Flujo de Compensación Asíncrona de Inventario (Origen vs Destino)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  Layers,
  Sparkles,
  X
} from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useMissionStore } from '../store/useMissionStore';
import { useDiscrepancyStore } from '../stores/useDiscrepancyStore';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { enqueueOfflineEvent } from '../lib/db';
import { FloorDiscrepancy, VirtualTransfer } from '../types/audit';

export const TabFloorReconciliation: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { activeMissionId } = useMissionStore();
  const {
    pendingFloorDiscrepancies,
    virtualTransfers,
    setPendingDiscrepancies,
    resolveDiscrepancyLocally,
    setVirtualTransfers,
  } = useDiscrepancyStore();

  const [selectedDiscrepancy, setSelectedDiscrepancy] = useState<FloorDiscrepancy | null>(null);
  const [floorCountedInput, setFloorCountedInput] = useState<string>('');
  const [floorSystemInput, setFloorSystemInput] = useState<string>('0');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'warning' | 'error' } | null>(null);

  const fetchOpenDiscrepancies = useCallback(async () => {
    if (!activeMissionId || !isSupabaseConfigured) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('Read_Floor_Discrepancies')
        .select('*')
        .eq('MissionId', activeMissionId)
        .or('Status.eq.OPEN,Status.eq.PENDING_TARGET_COUNT,Status.eq.PENDING_FLOOR_COUNT')
        .order('CreatedAt', { ascending: false });

      if (error) {
        console.warn('[TabFloorReconciliation] Error BD:', error);
      } else if (data) {
        const mappedDiscrepancies: FloorDiscrepancy[] = data.map((d) => {
          const originDisc = Number(d.OriginDiscrepancy ?? d.originDiscrepancy ?? d.WarehouseDiscrepancy ?? 0);
          
          return {
            discrepancyId: d.DiscrepancyId || d.discrepancyId,
            taskId: d.TaskId || d.taskId || '',
            missionId: d.MissionId || d.missionId || activeMissionId,
            skuCode: d.SkuCode || d.skuCode || '',
            skuDescription: d.SkuDescription || d.skuDescription || 'Artículo',
            originDeposit: d.OriginDeposit || d.originDeposit || '150101',
            targetDeposit: d.TargetDeposit || d.targetDeposit || d.FloorDeposit || '150103',
            originDiscrepancy: originDisc,
            targetSystemQuantity: Number(d.TargetSystemQuantity ?? d.targetSystemQuantity ?? d.FloorSystemQuantity ?? 0),
            targetCountedQuantity: d.TargetCountedQuantity ?? d.targetCountedQuantity ?? null,
            targetDiscrepancy: d.TargetDiscrepancy ?? d.targetDiscrepancy ?? null,
            status: d.Status || 'OPEN',
            resolvedAt: d.ResolvedAt || null,
          };
        });
        setPendingDiscrepancies(mappedDiscrepancies as any);
      }

      const { data: transfersData } = await supabase
        .from('Read_Virtual_Transfers')
        .select('*')
        .eq('MissionId', activeMissionId)
        .order('CreatedAt', { ascending: false });

      if (transfersData) {
        setVirtualTransfers(transfersData as VirtualTransfer[]);
      }
    } catch (err) {
      console.error('[TabFloorReconciliation] Fallo sincronización:', err);
    } finally {
      setIsLoading(false);
    }
  }, [activeMissionId, setPendingDiscrepancies, setVirtualTransfers]);

  useEffect(() => {
    fetchOpenDiscrepancies();
  }, [fetchOpenDiscrepancies]);

  const handleSelectDiscrepancy = (disc: FloorDiscrepancy) => {
    setSelectedDiscrepancy(disc);
    setFloorCountedInput('');
    setFloorSystemInput(String(disc.targetSystemQuantity || 0));
  };

  const currentOriginDisc = Number(selectedDiscrepancy?.originDiscrepancy || 0);
  const warehouseShortfall = Math.abs(currentOriginDisc);
  const floorCounted = parseFloat(floorCountedInput);
  const isFloorCountValid = !isNaN(floorCounted) && floorCounted >= 0;
  const floorSystem = parseFloat(floorSystemInput) || 0;
  const targetDiscrepancyVal = isFloorCountValid ? floorCounted - floorSystem : 0;

  const transferQuantity = isFloorCountValid ? Math.min(warehouseShortfall, floorCounted) : 0;
  const willCompensateFull = isFloorCountValid && transferQuantity >= warehouseShortfall;

  const handleConfirmReconciliation = async () => {
    if (!selectedDiscrepancy || !activeMissionId || !isFloorCountValid) {
      showToast('Ingrese un conteo válido', 'error');
      return;
    }

    setIsSubmitting(true);
    const discId = selectedDiscrepancy.discrepancyId || '';
    const skuCode = selectedDiscrepancy.skuCode || '';
    const skuDesc = selectedDiscrepancy.skuDescription || '';

    let virtualTransfer: VirtualTransfer | undefined;
    if (transferQuantity > 0) {
      virtualTransfer = {
        TransferId: crypto.randomUUID ? crypto.randomUUID() : `trans_${Date.now()}`,
        MissionId: activeMissionId,
        TaskId: selectedDiscrepancy.taskId || '',
        SkuCode: skuCode,
        SkuDescription: skuDesc,
        OriginDeposit: '150103',
        DestinationDeposit: '150104',
        TransferredQuantity: transferQuantity,
        CreatedAt: new Date().toISOString(),
        Status: 'SUGGESTED',
      };
    }

    const payload = {
      discrepancy_id: discId,
      mission_id: activeMissionId,
      sku_code: skuCode,
      sku_description: skuDesc,
      origin_deposit: selectedDiscrepancy.originDeposit || '150101',
      warehouse_discrepancy: selectedDiscrepancy.originDiscrepancy,
      floor_counted_qty: floorCounted,
      floor_system_qty: floorSystem,
      sales_during_audit: 0,
    };

    try {
      if (isOnline && isSupabaseConfigured) {
        const { error } = await supabase.functions.invoke('register-floor-count', { body: payload });
        
        if (error) {
           await supabase.from('Read_Floor_Discrepancies').update({
              TargetCountedQuantity: floorCounted,
              TargetDiscrepancy: targetDiscrepancyVal,
              Status: 'RESOLVED',
              ResolvedAt: new Date().toISOString(),
              UpdatedAt: new Date().toISOString(),
            }).eq('DiscrepancyId', discId);
        }
      } else {
        await enqueueOfflineEvent({ type: 'register-floor-count', missionId: activeMissionId, discrepancyId: discId, payload });
      }

      resolveDiscrepancyLocally(discId, floorCounted, virtualTransfer);
      showToast(transferQuantity > 0 ? `Reconciliado: Traslado de ${transferQuantity.toFixed(2)} u` : `Conteo registrado.`, 'success');
      setSelectedDiscrepancy(null);
      setFloorCountedInput('');
      fetchOpenDiscrepancies();
    } catch (err) {
      showToast('Error al registrar reconciliación', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const showToast = (text: string, type: 'success' | 'warning' | 'error') => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 4000);
  };

  const filteredDiscrepancies = pendingFloorDiscrepancies.filter((d) => {
    const q = filterQuery.toLowerCase().trim();
    if (!q) return true;
    return (d.skuCode || '').toLowerCase().includes(q) || (d.skuDescription || '').toLowerCase().includes(q);
  });

  return (
    <div className="space-y-5 max-w-4xl mx-auto w-full">
      <div className="bg-amber-950/40 border-2 border-amber-600/50 rounded-2xl p-4 sm:p-5 shadow-xl text-amber-200">
        <div className="flex items-start gap-3">
          <div className="p-2.5 bg-amber-500/20 rounded-xl text-amber-400 shrink-0">
            <Store className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base sm:text-lg font-black text-amber-300 tracking-tight flex items-center gap-2">
              <span>Reconciliación Asíncrona: Validación de Destino</span>
            </h2>
            <p className="text-xs sm:text-sm text-amber-200/90 leading-relaxed">
              Los artículos listados abajo presentaron diferencias al auditar en origen. Verifique físicamente el destino para compensar automáticamente.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center justify-between">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Filtrar por SKU o descripción..."
            className="w-full h-11 pl-10 pr-3 bg-slate-900 border border-slate-700 rounded-xl text-white font-mono text-sm focus:border-amber-500 focus:outline-hidden"
          />
        </div>
        <button onClick={fetchOpenDiscrepancies} disabled={isLoading} className="btn-collector bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 min-h-[44px] border border-slate-700">
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-amber-400' : ''}`} />
          <span>Refrescar Lista</span>
        </button>
      </div>

      {selectedDiscrepancy && (
        <div className="bg-slate-800/95 border-2 border-amber-500 rounded-2xl p-4 sm:p-6 shadow-2xl space-y-4 animate-fadeIn">
          <div className="flex items-start justify-between pb-3 border-b border-slate-700">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-black bg-amber-950 text-amber-400 px-2.5 py-0.5 rounded border border-amber-800">
                  SKU: {selectedDiscrepancy.skuCode}
                </span>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${currentOriginDisc < 0 ? 'text-rose-400 bg-rose-950/60 border-rose-800' : 'text-blue-400 bg-blue-950/60 border-blue-800'}`}>
                  {currentOriginDisc < 0 ? 'Faltante Origen' : 'Sobrante Origen'}: {currentOriginDisc > 0 ? `+${currentOriginDisc.toFixed(2)}` : currentOriginDisc.toFixed(2)} u
                </span>
              </div>
              <h3 className="text-lg sm:text-xl font-black text-white mt-1.5">
                {selectedDiscrepancy.skuDescription}
              </h3>
            </div>
            <button onClick={() => setSelectedDiscrepancy(null)} className="p-1.5 bg-slate-700/60 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-amber-300 mb-1.5 uppercase tracking-wider">
                CANTIDAD CONTADA FÍSICAMENTE EN DESTINO:
              </label>
              <input type="number" step="any" min="0" value={floorCountedInput} onChange={(e) => setFloorCountedInput(e.target.value)} placeholder="0.00" className="w-full h-16 px-4 bg-slate-950 border-2 border-amber-500 rounded-xl text-white font-mono text-3xl font-black text-center focus:outline-hidden" autoFocus />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1.5 uppercase tracking-wider">
                TEÓRICO EN SISTEMA DESTINO (ERP):
              </label>
              <input type="number" step="any" min="0" value={floorSystemInput} onChange={(e) => setFloorSystemInput(e.target.value)} placeholder="0.00" className="w-full h-16 px-4 bg-slate-900 border border-slate-700 rounded-xl text-slate-300 font-mono text-2xl font-bold text-center focus:outline-hidden" />
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={() => setSelectedDiscrepancy(null)} className="btn-collector bg-slate-700 hover:bg-slate-600 text-slate-200 min-h-[52px] px-5 rounded-xl font-bold text-sm">
              Cancelar
            </button>
            <button onClick={handleConfirmReconciliation} disabled={!isFloorCountValid || isSubmitting} className="btn-collector flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white min-h-[52px] rounded-xl font-black flex items-center justify-center gap-2">
              <CheckCircle2 className="w-5 h-5" /> CONFIRMAR RECONCILIACIÓN
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs sm:text-sm font-black text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <Layers className="w-4 h-4 text-amber-400" />
            <span>Pendientes por Verificar ({filteredDiscrepancies.length})</span>
          </h3>
        </div>

        {filteredDiscrepancies.length === 0 ? (
          <div className="bg-slate-800/40 border-2 border-dashed border-slate-700 rounded-2xl p-10 text-center text-slate-400 space-y-2">
            <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-400" />
            <p className="text-base font-bold text-slate-200">No hay discrepancias pendientes</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredDiscrepancies.map((disc) => {
              const originDisc = Number(disc.originDiscrepancy || 0);
              const isFaltante = originDisc < 0;
              const isSelected = disc.discrepancyId === selectedDiscrepancy?.discrepancyId;

              return (
                <div key={disc.discrepancyId} className={`bg-slate-800 border-2 rounded-2xl p-4 shadow-md transition ${isSelected ? 'border-amber-500 bg-slate-800/95 ring-2 ring-amber-500/20' : 'border-slate-700'}`}>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-mono font-bold bg-amber-950 text-amber-400 px-2.5 py-0.5 rounded border border-amber-800">
                          SKU: {disc.skuCode}
                        </span>
                        <span className="text-[11px] font-semibold text-slate-400">
                          Origen: {disc.originDeposit} &rarr; Destino: {disc.targetDeposit}
                        </span>
                      </div>
                      <h4 className="text-base font-bold text-white tracking-tight">{disc.skuDescription}</h4>
                    </div>

                    <div className="flex items-center gap-3 justify-between sm:justify-end">
                      <div className="bg-slate-900 border border-slate-700 px-3 py-2 rounded-xl text-right">
                        <span className="text-[10px] uppercase font-bold text-slate-400 block">
                          {isFaltante ? 'Faltante Origen' : 'Sobrante Origen'}
                        </span>
                        <span className={`text-base font-mono font-black ${isFaltante ? 'text-rose-400' : 'text-blue-400'}`}>
                          {originDisc > 0 ? `+${originDisc.toFixed(2)}` : originDisc.toFixed(2)} u
                        </span>
                      </div>

                      <button onClick={() => handleSelectDiscrepancy(disc as FloorDiscrepancy)} className="btn-collector bg-amber-600 hover:bg-amber-500 text-white min-h-[48px] px-4 rounded-xl font-bold text-xs sm:text-sm flex items-center gap-1.5 shrink-0">
                        <span>Verificar</span>
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};