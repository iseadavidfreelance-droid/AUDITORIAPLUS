/**
 * AUDITORIAPLUS+ - Tab 3: Reconciliación Bidireccional (Agnóstica)
 * Flujo de Compensación Asíncrona de Inventario (Origen vs Destino)
 * FASE 3: Fetch API en Vivo y Confirmación Humana de Traslados
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  RefreshCw,
  Search,
  Store,
  Layers,
  X,
  ArrowRightLeft
} from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useMissionStore } from '../store/useMissionStore';
import { useDiscrepancyStore } from '../stores/useDiscrepancyStore';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { enqueueOfflineEvent } from '../lib/db';
import { FloorDiscrepancy, VirtualTransfer } from '../types/audit';
import { useAuthStore } from '../stores/useAuthStore';

export const TabFloorReconciliation: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { activeMissionId } = useMissionStore();
  const user = useAuthStore(state => state.user);
  
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
  
  // Estados de carga e interfaz
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isFetchingLive, setIsFetchingLive] = useState<boolean>(false);
  
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'warning' | 'error' } | null>(null);

  // Mantenemos tu fetch original intacto, solo filtramos por PENDING_TRANSFER_APPROVAL para los traslados
  const fetchOpenDiscrepancies = useCallback(async () => {
    if (!activeMissionId || !isSupabaseConfigured) return;

    setIsLoading(true);
    try {
      // 1. Carga de Discrepancias Pendientes
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

      // 2. Carga de Traslados Pendientes de Confirmación Humana (SUGGESTED)
      const { data: transfersData } = await supabase
        .from('Read_Virtual_Transfers')
        .select('*')
        .eq('MissionId', activeMissionId)
        .eq('Status', 'SUGGESTED')
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

  // AL DAR CLIC EN VERIFICAR: Consulta la API en tiempo real
  const handleSelectDiscrepancy = async (disc: FloorDiscrepancy) => {
    setSelectedDiscrepancy(disc);
    setFloorCountedInput('');
    setFloorSystemInput('0'); // Valor por defecto
    setIsFetchingLive(true);

    try {
      const res = await fetch(`http://192.168.15.225:3002/api/inventory?search=${disc.skuCode}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.data) {
          const targetItem = json.data.find((d: any) => d.codigo_deposito === disc.targetDeposit);
          setFloorSystemInput(targetItem ? String(targetItem.stock_quantity) : '0');
        }
      } else {
        // Fallback al valor teórico guardado si falla la API
        setFloorSystemInput(String(disc.targetSystemQuantity || 0));
      }
    } catch (err) {
      console.warn("Fallo API destino:", err);
      setFloorSystemInput(String(disc.targetSystemQuantity || 0));
    } finally {
      setIsFetchingLive(false);
    }
  };

  const currentOriginDisc = Number(selectedDiscrepancy?.originDiscrepancy || 0);
  const warehouseShortfall = Math.abs(currentOriginDisc);
  const floorCounted = parseFloat(floorCountedInput);
  const isFloorCountValid = !isNaN(floorCounted) && floorCounted >= 0;
  const floorSystem = parseFloat(floorSystemInput) || 0;
  const targetDiscrepancyVal = isFloorCountValid ? floorCounted - floorSystem : 0;

  // Lógica Matemática de Interfaz
  let transferQuantity = 0;
  if (currentOriginDisc < 0 && targetDiscrepancyVal > 0) {
    transferQuantity = Math.min(Math.abs(currentOriginDisc), targetDiscrepancyVal);
  } else if (currentOriginDisc > 0 && targetDiscrepancyVal < 0) {
    transferQuantity = Math.min(currentOriginDisc, Math.abs(targetDiscrepancyVal));
  }

  // --- EJECUCIÓN DEL CONTEO (Respetando tu lógica original offline y local) ---
  const handleConfirmReconciliation = async () => {
    if (!selectedDiscrepancy || !activeMissionId || !isFloorCountValid || !user) {
      showToast('Ingrese un conteo válido', 'error');
      return;
    }

    setIsSubmitting(true);
    const discId = selectedDiscrepancy.discrepancyId || '';
    const skuCode = selectedDiscrepancy.skuCode || '';
    const skuDesc = selectedDiscrepancy.skuDescription || '';

    // Tu lógica de objeto virtual para la UI
    let virtualTransfer: VirtualTransfer | undefined;
    if (transferQuantity > 0) {
      virtualTransfer = {
        TransferId: crypto.randomUUID ? crypto.randomUUID() : `trans_${Date.now()}`,
        MissionId: activeMissionId,
        TaskId: selectedDiscrepancy.taskId || '',
        SkuCode: skuCode,
        SkuDescription: skuDesc,
        OriginDeposit: selectedDiscrepancy.originDeposit || '150101',
        DestinationDeposit: selectedDiscrepancy.targetDeposit || '150103',
        TransferredQuantity: transferQuantity,
        CreatedAt: new Date().toISOString(),
        Status: 'SUGGESTED',
      };
    }

    // Payload fusionado: Tu diseño original + Las nuevas variables agnósticas y el userId real
    const payload = {
      discrepancy_id: discId,
      mission_id: activeMissionId,
      sku_code: skuCode,
      sku_description: skuDesc,
      origin_deposit: selectedDiscrepancy.originDeposit || '150101',
      target_deposit: selectedDiscrepancy.targetDeposit || '150103',
      warehouse_discrepancy: currentOriginDisc,
      origin_discrepancy: currentOriginDisc,
      floor_counted_qty: floorCounted,
      target_counted_quantity: floorCounted,
      floor_system_qty: floorSystem,
      target_system_quantity: floorSystem,
      sales_during_audit: 0,
      user_id: user.id
    };

    try {
      if (isOnline && isSupabaseConfigured) {
        const { error } = await supabase.functions.invoke('register-floor-count', { body: payload });
        if (error) {
           await supabase.from('Read_Floor_Discrepancies').update({
              TargetCountedQuantity: floorCounted,
              TargetDiscrepancy: targetDiscrepancyVal,
              Status: transferQuantity > 0 ? 'PENDING_TRANSFER_APPROVAL' : 'RESOLVED',
              UpdatedAt: new Date().toISOString(),
           }).eq('DiscrepancyId', discId);
        }
      } else {
        await enqueueOfflineEvent({ type: 'register-floor-count', missionId: activeMissionId, discrepancyId: discId, payload });
      }

      resolveDiscrepancyLocally(discId, floorCounted, virtualTransfer);
      showToast(transferQuantity > 0 ? `Reconciliado: Traslado sugerido de ${transferQuantity.toFixed(2)} u` : `Conteo registrado sin traslados.`, 'success');
      setSelectedDiscrepancy(null);
      setFloorCountedInput('');
      fetchOpenDiscrepancies();
    } catch (err) {
      showToast('Error al registrar reconciliación', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- CONFIRMACIÓN HUMANA DEL TRASLADO ---
  const handleApproveTransfer = async (transfer: any) => {
    const isConfirmed = window.confirm(`¿ESTÁS SEGURO QUE ESTE TRASLADO SE REALIZÓ EN EL ERP?\n\nSKU: ${transfer.SkuCode}\nCantidad: ${transfer.TransferQuantity || transfer.TransferredQuantity} u\nDe: ${transfer.FromDeposit || transfer.OriginDeposit} -> A: ${transfer.ToDeposit || transfer.DestinationDeposit}`);
    
    if (!isConfirmed) return;

    try {
      await supabase.functions.invoke('confirm-transfer', {
        body: {
          transfer_id: transfer.TransferId || transfer.transferId,
          mission_id: transfer.MissionId || transfer.missionId,
          sku_code: transfer.SkuCode || transfer.skuCode,
          user_id: user?.id
        }
      });
      showToast('Traslado confirmado exitosamente.', 'success');
      await fetchOpenDiscrepancies(); 
    } catch (err) {
      showToast('Error al confirmar el traslado.', 'error');
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
    <div className="space-y-5 max-w-4xl mx-auto w-full pb-8">
      {/* HEADER DE INSTRUCCIONES */}
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
              Los artículos listados abajo presentaron diferencias al auditar en origen. Verifique físicamente el destino para compensar automáticamente. Los traslados generados requerirán confirmación manual del administrador.
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

      {/* FORMULARIO ACTIVO (Si hay un item seleccionado) */}
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
              <h3 className="text-lg sm:text-xl font-black text-white mt-1.5 leading-tight">
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
                CONTADO EN DESTINO ({selectedDiscrepancy.targetDeposit}):
              </label>
              <input type="number" step="any" min="0" value={floorCountedInput} onChange={(e) => setFloorCountedInput(e.target.value)} disabled={isFetchingLive} placeholder="0.00" className="w-full h-16 px-4 bg-slate-950 border-2 border-amber-500 rounded-xl text-white font-mono text-3xl font-black text-center disabled:opacity-50 focus:outline-hidden" autoFocus />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1.5 uppercase tracking-wider flex justify-between">
                <span>TEÓRICO ERP ({selectedDiscrepancy.targetDeposit}):</span>
                {isFetchingLive && <RefreshCw className="w-4 h-4 animate-spin text-blue-400" />}
              </label>
              <div className="w-full h-16 flex items-center justify-center bg-slate-900 border border-slate-700 rounded-xl">
                <span className={`font-mono text-3xl font-black ${isFetchingLive ? 'text-slate-600' : 'text-slate-300'}`}>
                  {isFetchingLive ? '...' : floorSystemInput}
                </span>
              </div>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button onClick={() => setSelectedDiscrepancy(null)} className="btn-collector bg-slate-700 hover:bg-slate-600 text-slate-200 min-h-[52px] px-5 rounded-xl font-bold text-sm">
              Cancelar
            </button>
            <button onClick={handleConfirmReconciliation} disabled={!isFloorCountValid || isSubmitting || isFetchingLive} className="btn-collector flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white min-h-[52px] rounded-xl font-black flex items-center justify-center gap-2 transition active:scale-95">
              {isSubmitting ? <RefreshCw className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />} VALIDAR DESTINO
            </button>
          </div>
        </div>
      )}

      {/* LISTA DE PENDIENTES POR VERIFICAR EN DESTINO */}
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
                        <span className="text-[10px] font-semibold text-slate-400">
                          Origen: {disc.originDeposit} &rarr; Destino: {disc.targetDeposit}
                        </span>
                      </div>
                      <h4 className="text-base font-bold text-white tracking-tight leading-tight">{disc.skuDescription}</h4>
                    </div>

                    <div className="flex items-center gap-3 justify-between sm:justify-end shrink-0">
                      <div className="bg-slate-900 border border-slate-700 px-3 py-2 rounded-xl text-right">
                        <span className="text-[10px] uppercase font-bold text-slate-400 block">
                          {isFaltante ? 'Faltante Origen' : 'Sobrante Origen'}
                        </span>
                        <span className={`text-base font-mono font-black ${isFaltante ? 'text-rose-400' : 'text-blue-400'}`}>
                          {originDisc > 0 ? `+${originDisc.toFixed(2)}` : originDisc.toFixed(2)} u
                        </span>
                      </div>

                      <button onClick={() => handleSelectDiscrepancy(disc as FloorDiscrepancy)} className="btn-collector bg-amber-600 hover:bg-amber-500 text-white min-h-[48px] px-4 rounded-xl font-bold text-xs sm:text-sm flex items-center gap-1.5 shrink-0 shadow-lg shadow-amber-900/20">
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

      {/* NUEVA TABLA: TRASLADOS SUGERIDOS PARA APROBACIÓN MANUAL */}
      <div className="space-y-3 pt-6 border-t border-slate-800">
        <h3 className="text-xs font-black text-blue-400 uppercase tracking-widest flex items-center gap-2">
          <ArrowRightLeft className="w-4 h-4" /> TRASLADOS PENDIENTES DE CONFIRMACIÓN ({virtualTransfers.length})
        </h3>
        
        {virtualTransfers.length === 0 ? (
          <div className="p-6 bg-slate-800/30 border border-slate-700/50 rounded-xl text-center text-slate-500 text-sm">No hay movimientos sugeridos esperando confirmación.</div>
        ) : (
          virtualTransfers.map((tr: any) => (
            <div key={tr.TransferId || tr.transferId} className="bg-blue-950/20 border border-blue-900/50 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <span className="text-[10px] font-black bg-blue-900/50 text-blue-300 px-2 py-0.5 rounded">MOVIMIENTO SUGERIDO PARA CUADRAR</span>
                <h4 className="text-sm font-black text-white mt-1.5 leading-tight">{tr.SkuDescription || tr.skuDescription || 'Producto'}</h4>
                <div className="flex items-center gap-2 mt-2 text-[11px] text-slate-300 font-mono font-bold">
                  <span>Mover {tr.TransferQuantity || tr.TransferredQuantity || tr.transferredQuantity} u</span>
                  <span className="bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">De: {tr.FromDeposit || tr.OriginDeposit || tr.originDeposit}</span>
                  <ArrowRightLeft className="w-3 h-3 text-blue-500" />
                  <span className="bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">A: {tr.ToDeposit || tr.DestinationDeposit || tr.destinationDeposit}</span>
                </div>
              </div>
              <button onClick={() => handleApproveTransfer(tr)} className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-lg font-black text-sm flex items-center justify-center gap-2 active:scale-95 transition shadow-lg shadow-blue-900/40 w-full sm:w-auto shrink-0">
                <CheckCircle2 className="w-4 h-4" /> CONFIRMAR ERP
              </button>
            </div>
          ))
        )}
      </div>

      {/* TOAST FLOTANTE */}
      {toast && (
        <div className={`fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-2xl shadow-2xl text-xs sm:text-sm font-bold flex items-center gap-2.5 max-w-md w-[90%] border backdrop-blur-md animate-slideUp ${toast.type === 'success' ? 'bg-emerald-950/90 border-emerald-500 text-emerald-200' : toast.type === 'warning' ? 'bg-amber-950/90 border-amber-500 text-amber-200' : 'bg-rose-950/90 border-rose-500 text-rose-200'}`}>
          {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
          {toast.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />}
          {toast.type === 'error' && <X className="w-5 h-5 text-rose-400 shrink-0" />}
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
};