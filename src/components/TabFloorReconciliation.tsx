/**
 * AUDITORIAPLUS+ - Tab 3: Reconciliación en Piso de Venta (150103) -> Tránsito (150104)
 * Flujo de Compensación Asíncrona de Inventario Faltante en Almacén vs Piso
 * Cero datos mock - Conexión directa a Read_Floor_Discrepancies y Edge Function register-floor-count.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Package,
  RotateCcw,
  RefreshCw,
  Search,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Warehouse,
  Store,
  Layers,
  Sparkles,
  WifiOff,
  Check,
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

  // Estados locales
  const [selectedDiscrepancy, setSelectedDiscrepancy] = useState<FloorDiscrepancy | null>(null);
  const [floorCountedInput, setFloorCountedInput] = useState<string>('');
  const [floorSystemInput, setFloorSystemInput] = useState<string>('0');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'warning' | 'error' } | null>(null);

  // 1. Cargar Discrepancias Abiertas desde Supabase (Read_Floor_Discrepancies)
  const fetchOpenDiscrepancies = useCallback(async () => {
    if (!activeMissionId || !isSupabaseConfigured) return;

    setIsLoading(true);
    try {
      // Consultar discrepancias abiertas o pendientes en piso de la misión activa
      const { data, error } = await supabase
        .from('Read_Floor_Discrepancies')
        .select('*')
        .eq('MissionId', activeMissionId)
        .or('Status.eq.OPEN,Status.eq.PENDING_FLOOR_COUNT')
        .order('CreatedAt', { ascending: false });

      if (error) {
        console.warn('[TabFloorReconciliation] Error al obtener Read_Floor_Discrepancies:', error);
      } else if (data) {
        const mappedDiscrepancies: FloorDiscrepancy[] = data.map((d) => ({
          DiscrepancyId: d.DiscrepancyId || d.discrepancyId,
          TaskId: d.TaskId || d.taskId || '',
          MissionId: d.MissionId || d.missionId || activeMissionId,
          SkuCode: d.SkuCode || d.skuCode || '',
          SkuDescription: d.SkuDescription || d.skuDescription || 'Artículo de inventario',
          MissingQuantity: Number(d.WarehouseDiscrepancy ?? d.MissingQuantity ?? 0),
          OriginDeposit: d.OriginDeposit || '150101',
          FloorDeposit: d.FloorDeposit || '150103',
          WarehouseDiscrepancy: Number(d.WarehouseDiscrepancy ?? d.MissingQuantity ?? 0),
          FloorSystemQuantity: Number(d.FloorSystemQuantity ?? 0),
          FloorCountedQuantity: d.FloorCountedQuantity !== null ? Number(d.FloorCountedQuantity) : null,
          FloorDiscrepancy: d.FloorDiscrepancy !== null ? Number(d.FloorDiscrepancy) : null,
          Status: d.Status || 'OPEN',
          ResolvedAt: d.ResolvedAt || null,
          CreatedAt: d.CreatedAt || new Date().toISOString(),
          UpdatedAt: d.UpdatedAt || new Date().toISOString(),
        }));

        setPendingDiscrepancies(mappedDiscrepancies);
      }

      // Consultar traslados virtuales existentes para la misión
      const { data: transfersData } = await supabase
        .from('Read_Virtual_Transfers')
        .select('*')
        .eq('MissionId', activeMissionId)
        .order('CreatedAt', { ascending: false });

      if (transfersData) {
        setVirtualTransfers(transfersData as VirtualTransfer[]);
      }
    } catch (err) {
      console.error('[TabFloorReconciliation] Fallo al sincronizar discrepancias:', err);
    } finally {
      setIsLoading(false);
    }
  }, [activeMissionId, setPendingDiscrepancies, setVirtualTransfers]);

  useEffect(() => {
    fetchOpenDiscrepancies();
  }, [fetchOpenDiscrepancies]);

  // Selección de ítem discrepante
  const handleSelectDiscrepancy = (disc: FloorDiscrepancy) => {
    setSelectedDiscrepancy(disc);
    setFloorCountedInput('');
    setFloorSystemInput(String(disc.FloorSystemQuantity || 0));
  };

  // Cálculos visuales inmediatos de compensación y traslado virtual
  const warehouseShortfall = Math.abs(
    Number(selectedDiscrepancy?.WarehouseDiscrepancy ?? selectedDiscrepancy?.MissingQuantity ?? 0)
  );
  const floorCounted = parseFloat(floorCountedInput);
  const isFloorCountValid = !isNaN(floorCounted) && floorCounted >= 0;
  const floorSystem = parseFloat(floorSystemInput) || 0;
  const floorDiscrepancy = isFloorCountValid ? floorCounted - floorSystem : 0;

  // Cantidad compensable transferible a tránsito (150104)
  // min(|Faltante_Almacén|, Conteo_en_Piso)
  const transferQuantity = isFloorCountValid
    ? Math.min(warehouseShortfall, floorCounted)
    : 0;

  const willCompensateFull = isFloorCountValid && transferQuantity >= warehouseShortfall;
  const willCompensatePartial = isFloorCountValid && transferQuantity > 0 && transferQuantity < warehouseShortfall;

  // 3. Confirmar Reconciliación en Piso (Envío a Edge Function)
  const handleConfirmReconciliation = async () => {
    if (!selectedDiscrepancy || !activeMissionId || !isFloorCountValid) {
      showToast('Ingrese un conteo válido de Piso de Venta', 'error');
      return;
    }

    setIsSubmitting(true);
    const discId = selectedDiscrepancy.DiscrepancyId || selectedDiscrepancy.discrepancyId || '';
    const skuCode = selectedDiscrepancy.SkuCode || selectedDiscrepancy.skuCode || '';
    const skuDesc = selectedDiscrepancy.SkuDescription || selectedDiscrepancy.skuDescription || '';

    // Preparar objeto de traslado virtual si hay unidades a compensar
    let virtualTransfer: VirtualTransfer | undefined;
    if (transferQuantity > 0) {
      virtualTransfer = {
        TransferId: crypto.randomUUID ? crypto.randomUUID() : `trans_${Date.now()}`,
        MissionId: activeMissionId,
        TaskId: selectedDiscrepancy.TaskId || '',
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
      origin_deposit: selectedDiscrepancy.OriginDeposit || '150101',
      warehouse_discrepancy: selectedDiscrepancy.WarehouseDiscrepancy || selectedDiscrepancy.MissingQuantity,
      floor_counted_qty: floorCounted,
      floor_system_qty: floorSystem,
      sales_during_audit: 0,
    };

    try {
      if (isOnline && isSupabaseConfigured) {
        // Invocación a Edge Function register-floor-count
        const { error } = await supabase.functions.invoke('register-floor-count', {
          body: payload,
        });

        if (error) {
          console.warn('[TabFloorReconciliation] Edge Function no disponible, actualizando tablas directamente:', error);
          // Fallback directo a tablas PostgreSQL
          await supabase
            .from('Read_Floor_Discrepancies')
            .update({
              FloorCountedQuantity: floorCounted,
              FloorDiscrepancy: floorDiscrepancy,
              Status: 'RESOLVED',
              ResolvedAt: new Date().toISOString(),
              UpdatedAt: new Date().toISOString(),
            })
            .eq('DiscrepancyId', discId);

          if (virtualTransfer) {
            await supabase.from('Read_Virtual_Transfers').insert({
              TransferId: virtualTransfer.TransferId,
              MissionId: activeMissionId,
              SkuCode: skuCode,
              SkuDescription: skuDesc,
              FromDeposit: '150103',
              ToDeposit: '150101',
              TransferQuantity: transferQuantity,
              TransitDeposit: '150104',
              Status: 'SUGGESTED',
            });
          }

          // Actualizar tarea en Read_Mission_Tasks a RECONCILED
          await supabase
            .from('Read_Mission_Tasks')
            .update({
              Status: 'RECONCILED',
              UpdatedAt: new Date().toISOString(),
            })
            .eq('MissionId', activeMissionId)
            .eq('SkuCode', skuCode);
        }
      } else {
        // Encolado Offline en IndexedDB
        await enqueueOfflineEvent({
          type: 'register-floor-count',
          missionId: activeMissionId,
          discrepancyId: discId,
          payload,
        });
      }

      // Actualizar estado local reactivo inmediatamente
      resolveDiscrepancyLocally(discId, floorCounted, virtualTransfer);

      showToast(
        transferQuantity > 0
          ? `Reconciliado: Traslado virtual de ${transferQuantity.toFixed(2)} u generado hacia Tránsito (150104)`
          : `Conteo de piso registrado. Sin stock suficiente para compensar.`,
        'success'
      );

      // Limpiar selección y refrescar
      setSelectedDiscrepancy(null);
      setFloorCountedInput('');
      fetchOpenDiscrepancies();
    } catch (err) {
      console.error('[TabFloorReconciliation] Error al confirmar reconciliación:', err);
      showToast('Error al registrar reconciliación en piso', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const showToast = (text: string, type: 'success' | 'warning' | 'error') => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Filtrado de discrepancias por SKU o descripción
  const filteredDiscrepancies = pendingFloorDiscrepancies.filter((d) => {
    const q = filterQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      (d.SkuCode || d.skuCode || '').toLowerCase().includes(q) ||
      (d.SkuDescription || d.skuDescription || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-5 max-w-4xl mx-auto w-full">
      {/* 1. HEADER EXPLICATIVO DEL FLUJO FINANCIERO */}
      <div className="bg-amber-950/40 border-2 border-amber-600/50 rounded-2xl p-4 sm:p-5 shadow-xl text-amber-200">
        <div className="flex items-start gap-3">
          <div className="p-2.5 bg-amber-500/20 rounded-xl text-amber-400 shrink-0">
            <Store className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base sm:text-lg font-black text-amber-300 tracking-tight flex items-center gap-2">
              <span>Reconciliación Asíncrona: Piso de Venta (150103) &rarr; Tránsito (150104)</span>
            </h2>
            <p className="text-xs sm:text-sm text-amber-200/90 leading-relaxed">
              Los artículos listados abajo presentaron faltantes físicos al auditar en <strong>Almacén (150101)</strong>.
              Al auditar y confirmar existencia física en <strong>Piso de Venta (150103)</strong>, el sistema genera
              una orden automática de traslado virtual hacia el <strong>Nodo de Tránsito (150104)</strong> para reconciliar
              la merma y balancear el inventario contable.
            </p>
          </div>
        </div>
      </div>

      {/* 2. BARRA DE HERRAMIENTAS Y BÚSQUEDA */}
      <div className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center justify-between">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Filtrar por SKU o descripción..."
            className="w-full h-11 pl-10 pr-3 bg-slate-900 border border-slate-700 rounded-xl text-white font-mono text-sm placeholder:text-slate-500 focus:outline-hidden focus:border-amber-500"
          />
        </div>

        <button
          onClick={fetchOpenDiscrepancies}
          disabled={isLoading}
          className="btn-collector bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 min-h-[44px] shrink-0 border border-slate-700"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-amber-400' : ''}`} />
          <span>Refrescar Lista</span>
        </button>
      </div>

      {/* 3. MODAL / PANEL DE CONTEO EN PISO ACTIVO */}
      {selectedDiscrepancy && (
        <div className="bg-slate-800/95 border-2 border-amber-500 rounded-2xl p-4 sm:p-6 shadow-2xl space-y-4 animate-fadeIn">
          <div className="flex items-start justify-between pb-3 border-b border-slate-700">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-black bg-amber-950 text-amber-400 px-2.5 py-0.5 rounded border border-amber-800">
                  SKU: {selectedDiscrepancy.SkuCode || selectedDiscrepancy.skuCode}
                </span>
                <span className="text-xs font-semibold text-rose-400 bg-rose-950/60 px-2 py-0.5 rounded border border-rose-800">
                  Faltante Almacén: -{warehouseShortfall.toFixed(2)} u
                </span>
              </div>
              <h3 className="text-lg sm:text-xl font-black text-white mt-1.5">
                {selectedDiscrepancy.SkuDescription || selectedDiscrepancy.skuDescription}
              </h3>
            </div>

            <button
              onClick={() => setSelectedDiscrepancy(null)}
              className="p-1.5 bg-slate-700/60 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Formulario de Entrada de Piso */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-amber-300 mb-1.5 uppercase tracking-wider">
                CANTIDAD CONTADA FÍSICAMENTE EN PISO (150103):
              </label>
              <input
                type="number"
                step="any"
                min="0"
                value={floorCountedInput}
                onChange={(e) => setFloorCountedInput(e.target.value)}
                placeholder="0.00"
                className="w-full h-16 px-4 bg-slate-950 border-2 border-amber-500 rounded-xl text-white font-mono text-3xl font-black text-center focus:outline-hidden shadow-inner"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1.5 uppercase tracking-wider">
                TEÓRICO EN SISTEMA PISO (ERP):
              </label>
              <input
                type="number"
                step="any"
                min="0"
                value={floorSystemInput}
                onChange={(e) => setFloorSystemInput(e.target.value)}
                placeholder="0.00"
                className="w-full h-16 px-4 bg-slate-900 border border-slate-700 rounded-xl text-slate-300 font-mono text-2xl font-bold text-center focus:outline-hidden"
              />
            </div>
          </div>

          {/* Cálculo Visual Inmediato y Sugerencia de Traslado Virtual */}
          {isFloorCountValid && (
            <div className="bg-slate-950/90 border border-slate-700 p-4 rounded-xl space-y-3">
              <div className="flex items-center justify-between text-xs sm:text-sm font-semibold pb-2 border-b border-slate-800">
                <span className="text-slate-400">Balance Calculado:</span>
                <span className={`font-mono font-bold ${floorDiscrepancy >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {floorDiscrepancy >= 0 ? `+${floorDiscrepancy.toFixed(2)}` : floorDiscrepancy.toFixed(2)} u en Piso
                </span>
              </div>

              {/* Diagrama de Traslado Virtual */}
              {transferQuantity > 0 ? (
                <div className="bg-emerald-950/40 border border-emerald-500/50 p-3.5 rounded-xl space-y-2">
                  <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs sm:text-sm">
                    <Sparkles className="w-4 h-4 text-emerald-400" />
                    <span>Sugerencia: Traslado Virtual Automático a Tránsito (150104)</span>
                  </div>

                  <div className="flex flex-wrap items-center justify-center gap-2 text-xs font-mono font-bold text-white py-1">
                    <div className="px-2.5 py-1 bg-slate-800 rounded-lg border border-slate-700">
                      Piso Venta (150103)
                    </div>
                    <ArrowRight className="w-4 h-4 text-emerald-400" />
                    <div className="px-3 py-1 bg-emerald-600 rounded-lg text-white shadow-sm">
                      +{transferQuantity.toFixed(2)} u a Tránsito (150104)
                    </div>
                    <ArrowRight className="w-4 h-4 text-emerald-400" />
                    <div className="px-2.5 py-1 bg-slate-800 rounded-lg border border-slate-700">
                      Almacén (150101)
                    </div>
                  </div>

                  <p className="text-[11px] text-emerald-300/80 text-center">
                    {willCompensateFull
                      ? 'Compensación Total: El stock de piso cubre el 100% del faltante de almacén.'
                      : `Compensación Parcial: Se compensarán ${transferQuantity.toFixed(2)} u de las ${warehouseShortfall.toFixed(2)} u faltantes.`}
                  </p>
                </div>
              ) : (
                <div className="bg-rose-950/40 border border-rose-600/40 p-3 rounded-xl text-rose-300 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>
                    El conteo de piso no tiene existencia suficiente para generar compensación de traslado.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Botón de Acción Principal (Mínimo 56px de alto) */}
          <div className="flex gap-2 pt-2">
            <button
              onClick={() => setSelectedDiscrepancy(null)}
              className="btn-collector bg-slate-700 hover:bg-slate-600 text-slate-200 min-h-[52px] px-5 rounded-xl font-bold text-sm"
            >
              Cancelar
            </button>
            <button
              onClick={handleConfirmReconciliation}
              disabled={!isFloorCountValid || isSubmitting}
              className="btn-collector flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white min-h-[52px] rounded-xl font-black text-sm sm:text-base flex items-center justify-center gap-2 shadow-lg shadow-emerald-700/30 transition"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-5 h-5 animate-spin" />
                  <span>PROCESANDO RECONCILIACIÓN...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-5 h-5" />
                  <span>CONFIRMAR RECONCILIACIÓN EN PISO</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* 4. LISTA DE DISCREPANCIAS ABIERTAS */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs sm:text-sm font-black text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <Layers className="w-4 h-4 text-amber-400" />
            <span>Discrepancias Abiertas en Piso ({filteredDiscrepancies.length})</span>
          </h3>
          <span className="text-xs text-slate-400">
            {pendingFloorDiscrepancies.length} pendientes en total
          </span>
        </div>

        {filteredDiscrepancies.length === 0 ? (
          <div className="bg-slate-800/40 border-2 border-dashed border-slate-700 rounded-2xl p-10 text-center text-slate-400 space-y-2">
            <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-400" />
            <p className="text-base font-bold text-slate-200">
              No hay discrepancias abiertas pendientes
            </p>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Todos los faltantes de almacén han sido debidamente auditados y reconciliados en Piso de Venta.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredDiscrepancies.map((disc) => {
              const shortfall = Math.abs(Number(disc.WarehouseDiscrepancy ?? disc.MissingQuantity ?? 0));
              const isSelected = (disc.DiscrepancyId || disc.discrepancyId) === (selectedDiscrepancy?.DiscrepancyId || selectedDiscrepancy?.discrepancyId);

              return (
                <div
                  key={disc.DiscrepancyId || disc.discrepancyId}
                  className={`bg-slate-800 border-2 rounded-2xl p-4 shadow-md transition ${
                    isSelected
                      ? 'border-amber-500 bg-slate-800/95 ring-2 ring-amber-500/20'
                      : 'border-slate-700 hover:border-amber-500/50'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-mono font-bold bg-amber-950 text-amber-400 px-2.5 py-0.5 rounded border border-amber-800">
                          SKU: {disc.SkuCode || disc.skuCode}
                        </span>
                        <span className="text-[11px] font-semibold text-slate-400">
                          Origen: Almacén (150101) &rarr; Destino: Piso (150103)
                        </span>
                      </div>
                      <h4 className="text-base font-bold text-white tracking-tight">
                        {disc.SkuDescription || disc.skuDescription || 'Artículo'}
                      </h4>
                    </div>

                    <div className="flex items-center gap-3 justify-between sm:justify-end">
                      <div className="bg-slate-900 border border-slate-700 px-3 py-2 rounded-xl text-right">
                        <span className="text-[10px] uppercase font-bold text-slate-400 block">
                          Faltante Almacén
                        </span>
                        <span className="text-base font-mono font-black text-rose-400">
                          -{shortfall.toFixed(2)} u
                        </span>
                      </div>

                      <button
                        onClick={() => handleSelectDiscrepancy(disc)}
                        className="btn-collector bg-amber-600 hover:bg-amber-500 text-white min-h-[48px] px-4 rounded-xl font-bold text-xs sm:text-sm flex items-center gap-1.5 shadow-md shadow-amber-600/20 active:scale-95 transition shrink-0"
                      >
                        <span>Contar en Piso</span>
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

      {/* 5. HISTÓRICO DE TRASLADOS VIRTUALES (150104) */}
      {virtualTransfers.length > 0 && (
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs sm:text-sm font-black text-emerald-400 uppercase tracking-wider flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Traslados Virtuales Registrados a Tránsito (150104) ({virtualTransfers.length})</span>
            </h4>
            <span className="text-[11px] font-mono text-slate-400">Compensación CQRS</span>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
            {virtualTransfers.map((vt) => (
              <div
                key={vt.TransferId || vt.transferId}
                className="bg-slate-800/80 border border-emerald-600/30 rounded-xl p-3 text-xs flex items-center justify-between gap-2"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-emerald-400">
                      {vt.SkuCode || vt.skuCode}
                    </span>
                    <span className="text-slate-200 font-semibold truncate max-w-[200px] sm:max-w-md">
                      {vt.SkuDescription || vt.skuDescription || 'Artículo compensado'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    Piso (150103) &rarr; Tránsito (150104) &rarr; Almacén (150101) •{' '}
                    <span className="text-slate-500">
                      {new Date(vt.CreatedAt || Date.now()).toLocaleTimeString()}
                    </span>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <span className="font-mono font-black text-emerald-300 text-sm sm:text-base block">
                    +{Number(vt.TransferredQuantity || vt.TransferQuantity || 0).toFixed(2)} u
                  </span>
                  <span className="text-[10px] font-bold text-emerald-400/80 uppercase">Reconciliado</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TOAST FLOTANTE */}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-2xl shadow-2xl text-xs sm:text-sm font-bold flex items-center gap-2.5 max-w-md w-[90%] border backdrop-blur-md animate-slideUp ${
            toast.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500 text-emerald-200'
              : toast.type === 'warning'
              ? 'bg-amber-950/90 border-amber-500 text-amber-200'
              : 'bg-rose-950/90 border-rose-500 text-rose-200'
          }`}
        >
          {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
          {toast.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />}
          {toast.type === 'error' && <X className="w-5 h-5 text-rose-400 shrink-0" />}
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
};
