/**
 * AUDITORIAPLUS+ - Tab 4: Resumen Ejecutivo y Generación de Reportes PDF
 * Métricas consolidadas, trazabilidad de traslados virtuales (150104)
 * Descarga de flujo binario PDF directo desde Supabase Edge Function `reports-pdf`.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  FileText,
  Download,
  CheckCircle2,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  DollarSign,
  ShieldCheck,
  RefreshCw,
  Printer,
  Table,
  Layers,
  ArrowRight,
  ExternalLink
} from 'lucide-react';
import { supabase, isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from '../lib/supabase';
import { useMissionStore } from '../store/useMissionStore';
import { useDiscrepancyStore } from '../stores/useDiscrepancyStore';
import { VirtualTransfer, MissionTask } from '../types/audit';

export const TabReports: React.FC = () => {
  const { activeMissionId, activeMission, metrics, tasks } = useMissionStore();
  const { virtualTransfers, setVirtualTransfers } = useDiscrepancyStore();

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isDownloadingPdf, setIsDownloadingPdf] = useState<boolean>(false);
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'warning' | 'error' } | null>(null);

  // 1. Cargar traslados virtuales de la misión activa
  const fetchTransfers = useCallback(async () => {
    if (!activeMissionId || !isSupabaseConfigured) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('Read_Virtual_Transfers')
        .select('*')
        .eq('MissionId', activeMissionId)
        .order('CreatedAt', { ascending: false });

      if (error) {
        console.warn('[TabReports] Error al obtener Read_Virtual_Transfers:', error);
      } else if (data) {
        setVirtualTransfers(data as VirtualTransfer[]);
      }
    } catch (err) {
      console.error('[TabReports] Error de red:', err);
    } finally {
      setIsLoading(false);
    }
  }, [activeMissionId, setVirtualTransfers]);

  useEffect(() => {
    fetchTransfers();
  }, [fetchTransfers]);

  // Cálculos consolidados
  const totalSkus = metrics.totalSkus || tasks.length || 0;
  const countedSkus = metrics.countedSkus || 0;
  const pendingSkus = metrics.pendingSkus || Math.max(0, totalSkus - countedSkus);
  const discrepantSkus = metrics.discrepantSkus || 0;
  const reconciledSkus = metrics.reconciledSkus || 0;
  const costImpact = Math.abs(metrics.totalCostDiscrepancy || 0);

  const auditAccuracyPercent = totalSkus > 0
    ? Math.round((countedSkus / totalSkus) * 100)
    : 0;

  const reconciliationPercent = discrepantSkus + reconciledSkus > 0
    ? Math.round((reconciledSkus / (discrepantSkus + reconciledSkus)) * 100)
    : 100;

  // 2. Descargar Reporte PDF Oficial vía Edge Function `reports-pdf`
  const handleDownloadPdf = async () => {
    if (!activeMissionId) {
      showToast('Seleccione primero una misión activa para emitir su reporte', 'warning');
      return;
    }

    setIsDownloadingPdf(true);
    showToast('Generando reporte PDF oficial con Edge Function...', 'success');

    try {
      const endpoint = `${supabaseUrl}/functions/v1/reports-pdf?mission_id=${encodeURIComponent(activeMissionId)}`;

      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${supabaseAnonKey}`,
          apikey: supabaseAnonKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Edge Function respondió con status ${response.status}: ${response.statusText}`);
      }

      // Convertir el stream binario en Blob application/pdf
      const blob = await response.blob();
      const pdfBlob = new Blob([blob], { type: 'application/pdf' });
      const downloadUrl = window.URL.createObjectURL(pdfBlob);

      // Disparar descarga automática en navegador
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `AUDITORIAPLUS_Reporte_${activeMissionId.slice(0, 8)}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Liberar memoria del objeto URL
      setTimeout(() => {
        window.URL.revokeObjectURL(downloadUrl);
      }, 2000);

      showToast('Reporte PDF descargado con éxito', 'success');
    } catch (err) {
      console.warn('[TabReports] Fallo al invocar Edge Function reports-pdf, usando fallback de impresión:', err);
      // Fallback: Si la Edge Function no está desplegada en la nube, abrir ventana de impresión estructurada
      generateLocalPrintableReport();
    } finally {
      setIsDownloadingPdf(false);
    }
  };

  // Fallback de exportación imprimible local si la Edge Function no responde
  const generateLocalPrintableReport = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      showToast('Permita las ventanas emergentes para generar el reporte impreso', 'warning');
      return;
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>AUDITORIAPLUS+ | Reporte de Auditoría ${activeMissionId}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; color: #111827; }
          h1 { color: #0F172A; border-bottom: 2px solid #10B981; padding-bottom: 8px; margin-bottom: 4px; }
          .meta { color: #64748B; font-size: 13px; margin-bottom: 20px; }
          .kpis { display: flex; gap: 16px; margin-bottom: 24px; }
          .kpi-box { border: 1px solid #CBD5E1; border-radius: 8px; padding: 12px 16px; flex: 1; }
          .kpi-title { font-size: 11px; text-transform: uppercase; color: #64748B; font-weight: bold; }
          .kpi-val { font-size: 22px; font-weight: 900; margin-top: 4px; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
          th { background: #0F172A; color: white; text-align: left; padding: 8px 10px; }
          td { border-bottom: 1px solid #E2E8F0; padding: 8px 10px; }
          tr:nth-child(even) { background: #F8FAFC; }
          .badge { padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 10px; }
          .badge-match { background: #D1FAE5; color: #065F46; }
          .badge-disc { background: #FEE2E2; color: #991B1B; }
        </style>
      </head>
      <body>
        <h1>AUDITORIAPLUS+ • Reporte Oficial de Auditoría</h1>
        <div class="meta">
          <strong>Misión:</strong> ${activeMissionId} | 
          <strong>Fecha:</strong> ${new Date().toLocaleString()} | 
          <strong>Depósito Auditado:</strong> 150101 Almacén Principal
        </div>

        <div class="kpis">
          <div class="kpi-box">
            <div class="kpi-title">SKUs Auditados</div>
            <div class="kpi-val">${countedSkus} / ${totalSkus} (${auditAccuracyPercent}%)</div>
          </div>
          <div class="kpi-box">
            <div class="kpi-title">Discrepancias</div>
            <div class="kpi-val">${discrepantSkus}</div>
          </div>
          <div class="kpi-box">
            <div class="kpi-title">Reconciliados en Piso</div>
            <div class="kpi-val">${reconciledSkus} (${reconciliationPercent}%)</div>
          </div>
          <div class="kpi-box">
            <div class="kpi-title">Impacto Financiero</div>
            <div class="kpi-val">$${costImpact.toFixed(2)}</div>
          </div>
        </div>

        <h3>Detalle de Tareas de Auditoría (${tasks.length} SKUs)</h3>
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Descripción</th>
              <th>Costo</th>
              <th>Sistema</th>
              <th>Ventas</th>
              <th>Contado</th>
              <th>Diferencia</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            ${tasks.map((t) => `
              <tr>
                <td><strong>${t.SkuCode}</strong></td>
                <td>${t.SkuDescription}</td>                 <td>$${Number(t.Cost || 0).toFixed(2)}</td>
                <td>${Number(t.SystemQuantity || 0).toFixed(2)}</td>
                <td>${Number(t.SalesDuringAudit || 0).toFixed(2)}</td>
                <td>${t.CountedQuantity !== null ? Number(t.CountedQuantity).toFixed(2) : '-'}</td>
                <td style="font-weight:bold; color: ${Number(t.Discrepancy || 0) === 0 ? '#059669' : '#DC2626'}">
                  ${Number(t.Discrepancy || 0) > 0 ? `+${Number(t.Discrepancy).toFixed(2)}` : Number(t.Discrepancy || 0).toFixed(2)}
                </td>
                <td>
                  <span class="badge ${t.Status === 'COMPLETED_MATCH' || t.Status === 'RECONCILED' ? 'badge-match' : 'badge-disc'}">
                    ${t.Status}
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <script>
          window.onload = function() { window.print(); }
        </script>
      </body>
      </html>
    `;

    printWindow.document.write(htmlContent);
    printWindow.document.close();
    showToast('Reporte generado en formato de impresión / PDF', 'success');
  };

  const showToast = (text: string, type: 'success' | 'warning' | 'error') => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 4000);
  };

  // AISLAMIENTO: Filtramos los traslados para solo mostrar los confirmados.
  const executedTransfers = virtualTransfers.filter(
    (vt) => vt.Status === 'EXECUTED' || (vt as any).status === 'EXECUTED'
  );

  return (
    <div className="space-y-5 max-w-5xl mx-auto w-full">
      {/* 1. HEADER DE CONTROL Y BOTÓN DE DESCARGA PDF */}
      <div className="bg-slate-800 border-2 border-slate-700 rounded-2xl p-4 sm:p-6 shadow-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-bold bg-blue-950 text-blue-300 px-2.5 py-1 rounded border border-blue-800">
              Misión: {activeMissionId ? activeMissionId.slice(0, 12) : 'Sin misión activa'}
            </span>
            <span className="text-xs font-semibold text-slate-400">
              CQRS Analytics
            </span>
          </div>
          <h2 className="text-xl sm:text-2xl font-black text-white mt-1.5 tracking-tight">
            Resumen Ejecutivo y Cierre de Auditoría
          </h2>
          <p className="text-xs sm:text-sm text-slate-400">
            Consolidado financiero de inventario físico, mermas y balanceos en tránsito (150104).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={fetchTransfers}
            disabled={isLoading}
            className="btn-collector bg-slate-700 hover:bg-slate-600 text-slate-200 min-h-[50px] px-3.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-blue-400' : ''}`} />
            <span className="hidden sm:inline">Actualizar</span>
          </button>

          {/* BOTÓN CTA PRINCIPAL: DESCARGAR REPORTE AUDITORÍA (PDF) */}
          <button
            onClick={handleDownloadPdf}
            disabled={!activeMissionId || isDownloadingPdf}
            className="btn-collector flex-1 sm:flex-none min-h-[50px] bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-black text-xs sm:text-sm px-5 sm:px-6 rounded-xl shadow-lg shadow-blue-600/30 flex items-center justify-center gap-2 active:scale-95 transition"
          >
            {isDownloadingPdf ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>DESCARGANDO PDF...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>DESCARGAR REPORTE AUDITORÍA (PDF)</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 2. CUADRO DE MANDOS DE MÉTRICAS CONSOLIDADAS */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {/* KPI 1: Total SKUs Auditados */}
        <div className="bg-slate-800/90 border border-slate-700 p-4 rounded-2xl shadow-md">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
            <span>Progreso de Conteo</span>
            <CheckCircle2 className="w-4 h-4 text-blue-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-black text-white font-mono">
              {auditAccuracyPercent}%
            </span>
            <span className="text-xs text-slate-400 font-mono">
              ({countedSkus}/{totalSkus})
            </span>
          </div>
          <div className="w-full bg-slate-700 h-2 rounded-full mt-2.5 overflow-hidden">
            <div
              className="bg-blue-500 h-full transition-all duration-500"
              style={{ width: `${auditAccuracyPercent}%` }}
            />
          </div>
          <span className="text-[11px] text-slate-400 mt-2 block">
            {pendingSkus} SKUs pendientes
          </span>
        </div>

        {/* KPI 2: Discrepancias Totales */}
        <div className="bg-slate-800/90 border border-amber-600/40 p-4 rounded-2xl shadow-md">
          <div className="flex items-center justify-between text-amber-400 text-xs font-semibold uppercase tracking-wider">
            <span>Discrepancias</span>
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-black text-amber-300 font-mono">
              {discrepantSkus}
            </span>
            <span className="text-xs text-amber-400/80">
              diferencias
            </span>
          </div>
          <p className="text-[11px] text-amber-300/80 mt-3 leading-tight">
            Requieren compensación o ajuste contable
          </p>
        </div>

        {/* KPI 3: Porcentaje de Reconciliación */}
        <div className="bg-slate-800/90 border border-emerald-600/40 p-4 rounded-2xl shadow-md">
          <div className="flex items-center justify-between text-emerald-400 text-xs font-semibold uppercase tracking-wider">
            <span>Reconciliación Piso</span>
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-black text-emerald-300 font-mono">
              {reconciliationPercent}%
            </span>
            <span className="text-xs text-emerald-400/80">
              ({reconciledSkus} resueltos)
            </span>
          </div>
          <div className="w-full bg-slate-700 h-2 rounded-full mt-2.5 overflow-hidden">
            <div
              className="bg-emerald-500 h-full transition-all duration-500"
              style={{ width: `${reconciliationPercent}%` }}
            />
          </div>
          <span className="text-[11px] text-emerald-400/80 mt-2 block">
            Compensados con Piso (150103)
          </span>
        </div>

        {/* KPI 4: Impacto Financiero en Costo ($) */}
        <div className="bg-slate-800/90 border border-slate-700 p-4 rounded-2xl shadow-md">
          <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
            <span>Impacto en Costo</span>
            <DollarSign className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2">
            <span className="text-2xl sm:text-3xl font-black font-mono text-white">
              ${costImpact.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-3 leading-tight">
            Valoración total a costo de las discrepancias
          </p>
        </div>
      </div>

      {/* 3. TABLA DE TRASLADOS VIRTUALES (150104) */}
      <div className="bg-slate-800 border border-slate-700 rounded-2xl p-4 sm:p-5 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-emerald-400" />
            <h3 className="text-sm sm:text-base font-black text-white uppercase tracking-wider">
              Traslados Virtuales Registrados ({executedTransfers.length})
            </h3>
          </div>
          <span className="text-xs text-slate-400 font-mono">
            Nodo Intermediario (150104)
          </span>
        </div>

        {executedTransfers.length === 0 ? (
          <div className="bg-slate-900/60 border border-dashed border-slate-700 rounded-xl p-6 text-center text-slate-400">
            <p className="text-sm font-semibold text-slate-300">
              No hay traslados virtuales confirmados para esta misión
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Los traslados se muestran aquí una vez son confirmados manualmente.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left border-collapse text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 text-[11px] uppercase font-bold tracking-wider">
                  <th className="py-2.5 px-3">SKU</th>
                  <th className="py-2.5 px-3">Descripción</th>
                  <th className="py-2.5 px-3 text-center">Flujo de Depósitos</th>
                  <th className="py-2.5 px-3 text-right">Cantidad Compensada</th>
                  <th className="py-2.5 px-3 text-right">Fecha / Hora</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60 font-mono">
                {executedTransfers.map((vt) => (
                  <tr key={vt.TransferId || (vt as any).transferId} className="hover:bg-slate-700/30 transition">
                    <td className="py-3 px-3 font-bold text-emerald-400">
                      {vt.SkuCode || (vt as any).skuCode}
                    </td>
                    <td className="py-3 px-3 font-sans text-slate-200 max-w-xs truncate">
                      {vt.SkuDescription || (vt as any).skuDescription || 'Artículo auditado'}
                    </td>
                    <td className="py-3 px-3 text-center">
                      <span className="inline-flex items-center gap-1.5 text-xs text-slate-300 bg-slate-900 px-2.5 py-1 rounded-lg border border-slate-700">
                        <span>Piso (150103)</span>
                        <ArrowRight className="w-3 h-3 text-emerald-400" />
                        <strong className="text-emerald-400">Tránsito (150104)</strong>
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right font-black text-emerald-300">
                      +{Number((vt as any).TransferredQuantity || (vt as any).TransferQuantity || 0).toFixed(2)} u
                    </td>
                    <td className="py-3 px-3 text-right text-slate-400 text-xs">
                      {new Date(vt.CreatedAt || Date.now()).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 4. LISTADO RÁPIDO DE TODAS LAS TAREAS DE LA MISIÓN */}
      {tasks.length > 0 && (
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-4 sm:p-5 shadow-xl space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs sm:text-sm font-black text-slate-300 uppercase tracking-wider flex items-center gap-2">
              <Table className="w-4 h-4 text-blue-400" />
              <span>Detalle de Tareas de Inventario ({tasks.length} SKUs)</span>
            </h3>
            <button
              onClick={generateLocalPrintableReport}
              className="text-xs text-blue-400 hover:text-blue-300 font-semibold flex items-center gap-1"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Imprimir Ficha Completa</span>
            </button>
          </div>

          <div className="overflow-x-auto max-h-80 custom-scrollbar border border-slate-700 rounded-xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900 text-slate-400 text-[10px] uppercase font-bold sticky top-0">
                <tr>
                  <th className="py-2 px-3">SKU</th>
                  <th className="py-2 px-3">Descripción</th>
                  <th className="py-2 px-3 text-right">Sistema</th>
                  <th className="py-2 px-3 text-right">Contado</th>
                  <th className="py-2 px-3 text-right">Diferencia</th>
                  <th className="py-2 px-3 text-center">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50 bg-slate-900/40">
                {tasks.map((task) => {
                  const disc = Number(task.Discrepancy ?? 0);
                  const isCounted = task.CountedQuantity !== null && task.CountedQuantity !== undefined;

                  return (
                    <tr key={task.TaskId || task.taskId} className="hover:bg-slate-800/60">
                      <td className="py-2 px-3 font-mono font-bold text-white">
                        {task.SkuCode || task.skuCode}
                      </td>
                      <td className="py-2 px-3 text-slate-300 truncate max-w-xs">
                        {task.SkuDescription || task.skuDescription}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-slate-300">
                        {Number(task.SystemQuantity ?? 0).toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-slate-200">
                        {isCounted ? Number(task.CountedQuantity).toFixed(2) : '-'}
                      </td>
                      <td className="py-2 px-3 text-right font-mono font-bold">
                        <span
                          className={
                            disc === 0
                              ? 'text-emerald-400'
                              : disc < 0
                              ? 'text-rose-400'
                              : 'text-amber-400'
                          }
                        >
                          {disc > 0 ? `+${disc.toFixed(2)}` : disc.toFixed(2)}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-center">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            task.Status === 'COMPLETED_MATCH' || task.Status === 'RECONCILED'
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                              : task.Status === 'DISCREPANT'
                              ? 'bg-amber-950 text-amber-400 border border-amber-800'
                              : 'bg-slate-800 text-slate-400 border border-slate-700'
                          }`}
                        >
                          {task.Status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
};