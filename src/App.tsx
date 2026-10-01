/**
 * AUDITORIAPLUS+ - PWA de Auditoría de Inventario Físico
 * Layout Principal PWA: Barra Superior de Control, Bottom Navigation Dock y Flujo CQRS.
 * Cero datos mock. Modo offline transparente con IndexedDB (AuditDB) y sincronización automática.
 */

import React, { useEffect, useState, useRef, useTransition } from 'react';
import {
  UploadCloud,
  Barcode,
  Layers,
  AlertTriangle,
  FileText,
  Wifi,
  WifiOff,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Database,
  ArrowRight,
  ShieldCheck,
  ChevronRight
} from 'lucide-react';
import { supabase, isSupabaseConfigured, checkSupabaseConnection } from './lib/supabase';
import { useMissionStore } from './store/useMissionStore';
import { useDiscrepancyStore } from './stores/useDiscrepancyStore';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { PWAInstallButton } from './components/PWAInstallButton';
import { TabIngestion } from './components/TabIngestion';
import { TabCollector } from './components/TabCollector';
import { TabFloorReconciliation } from './components/TabFloorReconciliation';
import { TabReports } from './components/TabReports';
import { getOfflineQueueCount } from './lib/db';
import { processOfflineQueue, subscribeToSync } from './lib/sync';

type ActiveTab = 'ingestion' | 'mission' | 'discrepancies' | 'reports';

export default function App() {
  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<ActiveTab>('ingestion');
  const [, startTransition] = useTransition();

  // Stores
  const {
    activeMissionId,
    activeMission,
    metrics,
    tasks,
    fetchMissionTasks,
    setActiveMissionId,
    setActiveMission,
  } = useMissionStore();

  const {
    pendingFloorDiscrepancies,
    setPendingDiscrepancies,
  } = useDiscrepancyStore();

  // Estados locales de control y sincronización
  const [dbStatus, setDbStatus] = useState<{ connected: boolean; latencyMs: number; error?: string }>({
    connected: false,
    latencyMs: 0,
  });
  const [queuedEvents, setQueuedEvents] = useState<number>(0);
  const [isManualSyncing, setIsManualSyncing] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<{
    text: string;
    type: 'success' | 'warning' | 'error';
  } | null>(null);

  // 1. Verificación de Conectividad periódica y escucha de eventos de la cola offline
  const refreshConnectionAndQueue = async () => {
    const status = await checkSupabaseConnection();
    setDbStatus(status);
    const count = await getOfflineQueueCount();
    setQueuedEvents(count);
  };

  useEffect(() => {
    refreshConnectionAndQueue();
    const interval = setInterval(refreshConnectionAndQueue, 15000);

    // Escuchar el progreso del sincronizador background
    const unsubscribeSync = subscribeToSync((progress, syncing) => {
      setQueuedEvents(progress.remaining);
      if (progress.processed > 0 && !syncing) {
        showToast(`${progress.processed} eventos sincronizados con éxito`, 'success');
        if (activeMissionId) {
          fetchMissionTasks(activeMissionId);
        }
      }
    });

    return () => {
      clearInterval(interval);
      unsubscribeSync();
    };
  }, [activeMissionId, fetchMissionTasks]);

  // 2. Listener global para el evento `online` del navegador
  useEffect(() => {
    const handleOnline = async () => {
      console.log('[PWA] Conexión a Internet restablecida. Procesando cola offline...');
      showToast('Conexión reestablecida. Sincronizando eventos pendientes...', 'success');
      setIsManualSyncing(true);
      try {
        await processOfflineQueue();
        const count = await getOfflineQueueCount();
        setQueuedEvents(count);
        if (activeMissionId) {
          await fetchMissionTasks(activeMissionId);
        }
      } catch (err) {
        console.warn('[PWA] Error durante sincronización automática al volver online:', err);
      } finally {
        setIsManualSyncing(false);
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [activeMissionId, fetchMissionTasks]);

  // 3. Forzar sincronización manual desde la barra superior
  const handleManualSync = async () => {
    if (!isOnline) {
      showToast('Sin conexión a Internet para sincronizar', 'warning');
      return;
    }
    setIsManualSyncing(true);
    try {
      const result = await processOfflineQueue();
      const count = await getOfflineQueueCount();
      setQueuedEvents(count);
      if (result.processed > 0) {
        showToast(`${result.processed} eventos subidos a Supabase con éxito`, 'success');
        if (activeMissionId) {
          await fetchMissionTasks(activeMissionId);
        }
      } else if (result.remaining === 0) {
        showToast('Todos los eventos locales ya están sincronizados', 'success');
      }
    } catch {
      showToast('Error durante la sincronización', 'error');
    } finally {
      setIsManualSyncing(false);
    }
  };

  const showToast = (text: string, type: 'success' | 'warning' | 'error') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans pb-24 antialiased selection:bg-blue-600 selection:text-white">
      {/* ============================================================ */}
      {/* 1. BARRA SUPERIOR (HEADER INDUSTRIAL PWA)                    */}
      {/* ============================================================ */}
      <header className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur-md border-b border-slate-800 px-3 sm:px-5 py-2.5 shadow-lg">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          {/* Logo y Misión Activa */}
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-blue-600 flex items-center justify-center shadow-md shadow-emerald-900/40 text-white font-black text-sm shrink-0">
              A+
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-base sm:text-lg font-black tracking-tight text-white leading-none">
                  AUDITORIA<span className="text-emerald-400">PLUS+</span>
                </span>
                <span className="text-[10px] font-black uppercase tracking-wider bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">
                  CQRS
                </span>
              </div>

              {/* Selector / Indicador de Misión Activa */}
              <div className="flex items-center gap-1.5 mt-0.5">
                {activeMissionId ? (
                  <button
                    onClick={() => setActiveTab('ingestion')}
                    className="text-[11px] font-mono font-bold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition"
                  >
                    <span>Misión: {activeMissionId.slice(0, 8)}</span>
                    <ChevronRight className="w-3 h-3 text-slate-500" />
                  </button>
                ) : (
                  <button
                    onClick={() => setActiveTab('ingestion')}
                    className="text-[11px] font-bold text-amber-400 hover:text-amber-300 flex items-center gap-1"
                  >
                    <span>Seleccionar misión</span>
                    <ChevronRight className="w-3 h-3 text-amber-500" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Indicadores de Conexión, Eventos en Cola y PWA Install */}
          <div className="flex items-center gap-2">
            {/* Contador de Eventos Offline en Cola */}
            {queuedEvents > 0 && (
              <button
                onClick={handleManualSync}
                disabled={isManualSyncing || !isOnline}
                title="Eventos almacenados localmente en IndexedDB. Clic para sincronizar."
                className="btn-collector bg-amber-950/80 border border-amber-600 text-amber-300 hover:bg-amber-900 px-2.5 py-1 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-xs transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isManualSyncing ? 'animate-spin' : ''}`} />
                <span className="font-mono">{queuedEvents}</span>
                <span className="hidden sm:inline">en cola</span>
              </button>
            )}

            {/* Badge de Conectividad */}
            <div
              className={`px-2.5 py-1 rounded-xl text-xs font-bold flex items-center gap-1.5 border transition ${
                isOnline
                  ? 'bg-emerald-950/70 border-emerald-600/60 text-emerald-300'
                  : 'bg-rose-950/70 border-rose-600/60 text-rose-300 animate-pulse'
              }`}
            >
              {isOnline ? (
                <>
                  <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="hidden xs:inline">En Línea</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3.5 h-3.5 text-rose-400" />
                  <span>Offline</span>
                </>
              )}
            </div>

            {/* Botón PWA Install nativo */}
            <PWAInstallButton />
          </div>
        </div>
      </header>

      {/* ============================================================ */}
      {/* 2. CONTENIDO PRINCIPAL SEGÚN TAB ACTIVO                      */}
      {/* ============================================================ */}
      <main className="flex-1 p-3 sm:p-5 max-w-5xl mx-auto w-full space-y-4">
        {/* TAB 1: INGESTA / MISIONES */}
        {activeTab === 'ingestion' && (
          <TabIngestion onMissionSelected={() => setActiveTab('mission')} />
        )}

        {/* TAB 2: COLECTOR ALMACÉN (150101) */}
        {activeTab === 'mission' && (
          <div className="space-y-4">
            <TabCollector onNavigateToFloor={() => setActiveTab('discrepancies')} />
          </div>
        )}

        {/* TAB 3: RECONCILIACIÓN PISO (150103) */}
        {activeTab === 'discrepancies' && (
          <TabFloorReconciliation />
        )}

        {/* TAB 4: REPORTES & ANALÍTICA */}
        {activeTab === 'reports' && (
          <TabReports />
        )}
      </main>

      {/* ============================================================ */}
      {/* 3. PWA BOTTOM NAVIGATION DOCK (4 PESTAÑAS INDUSTRIALES)       */}
      {/* ============================================================ */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-slate-900/95 backdrop-blur-lg border-t border-slate-800 shadow-2xl safe-area-bottom">
        <div className="max-w-lg mx-auto flex items-center justify-around px-2 py-1.5">
          {/* Tab 1: Ingesta / Misiones */}
          <button
            onClick={() => setActiveTab('ingestion')}
            className={`flex-1 flex flex-col items-center justify-center min-h-[56px] py-1 px-1 rounded-xl font-bold text-[11px] transition touch-manipulation active:scale-95 ${
              activeTab === 'ingestion'
                ? 'text-blue-400 bg-blue-950/40 border border-blue-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
            }`}
          >
            <UploadCloud className="w-5 h-5 mb-0.5" />
            <span>Misiones</span>
          </button>

          {/* Tab 2: Colector Almacén (150101) */}
          <button
            onClick={() => setActiveTab('mission')}
            className={`flex-1 flex flex-col items-center justify-center min-h-[56px] py-1 px-1 rounded-xl font-bold text-[11px] transition touch-manipulation active:scale-95 ${
              activeTab === 'mission'
                ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
            }`}
          >
            <Barcode className="w-5 h-5 mb-0.5" />
            <span>Almacén</span>
          </button>

          {/* Tab 3: Reconciliación Piso (150103) */}
          <button
            onClick={() => setActiveTab('discrepancies')}
            className={`flex-1 flex flex-col items-center justify-center min-h-[56px] py-1 px-1 rounded-xl font-bold text-[11px] transition touch-manipulation relative active:scale-95 ${
              activeTab === 'discrepancies'
                ? 'text-amber-400 bg-amber-950/40 border border-amber-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
            }`}
          >
            <div className="relative">
              <AlertTriangle className="w-5 h-5 mb-0.5" />
              {pendingFloorDiscrepancies.length > 0 && (
                <span className="absolute -top-1.5 -right-2 bg-amber-500 text-slate-950 text-[10px] font-black px-1.5 py-0.2 rounded-full min-w-[16px] text-center shadow-xs">
                  {pendingFloorDiscrepancies.length}
                </span>
              )}
            </div>
            <span>Piso (150103)</span>
          </button>

          {/* Tab 4: Reportes */}
          <button
            onClick={() => setActiveTab('reports')}
            className={`flex-1 flex flex-col items-center justify-center min-h-[56px] py-1 px-1 rounded-xl font-bold text-[11px] transition touch-manipulation active:scale-95 ${
              activeTab === 'reports'
                ? 'text-indigo-400 bg-indigo-950/40 border border-indigo-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
            }`}
          >
            <FileText className="w-5 h-5 mb-0.5" />
            <span>Reportes</span>
          </button>
        </div>
      </nav>

      {/* ============================================================ */}
      {/* 4. TOAST FLOTANTE NO BLOQUEANTE                             */}
      {/* ============================================================ */}
      {toastMessage && (
        <div
          className={`fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-3 rounded-2xl shadow-2xl text-xs sm:text-sm font-bold flex items-center gap-2.5 max-w-md w-[90%] border backdrop-blur-md animate-slideUp ${
            toastMessage.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500 text-emerald-200'
              : toastMessage.type === 'warning'
              ? 'bg-amber-950/90 border-amber-500 text-amber-200'
              : 'bg-rose-950/90 border-rose-500 text-rose-200'
          }`}
        >
          {toastMessage.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
          {toastMessage.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />}
          {toastMessage.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />}
          <span>{toastMessage.text}</span>
        </div>
      )}
    </div>
  );
}
