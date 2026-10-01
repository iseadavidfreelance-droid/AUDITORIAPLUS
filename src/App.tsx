/**
 * AUDITORIAPLUS+ - PWA de Auditoría de Inventario Físico
 * Layout Principal PWA: Barra Superior de Control, Bottom Navigation Dock y Flujo CQRS.
 * Cero datos mock. Modo offline transparente con IndexedDB (AuditDB) y sincronización automática.
 * FASE 1.5: Login Modo Quiosco + Control de Roles + Misión Global Persistente.
 */

import React, { useEffect, useState, useTransition, useRef } from 'react';
import {
  UploadCloud,
  Barcode,
  AlertTriangle,
  FileText,
  Wifi,
  WifiOff,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
  LogOut,
  User,
  Fingerprint,
  ShieldCheck,
  ArrowRight
} from 'lucide-react';
import { Session } from '@supabase/supabase-js';
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

// DEFINICIÓN ESTÁTICA DE USUARIOS DEL QUIOSCO
const KIOSK_USERS = [
  { name: 'David', email: 'david@maraplus.local', pass: '123456', icon: ShieldCheck, color: 'text-blue-400', bg: 'bg-blue-500/10' },
  { name: 'Franyelin', email: 'franyelin@maraplus.local', pass: '123456', icon: User, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  { name: 'Luis', email: 'luis@maraplus.local', pass: '123456', icon: User, color: 'text-amber-400', bg: 'bg-amber-500/10' }
];

export default function App() {
  // ESTADOS DE AUTENTICACIÓN
  const [session, setSession] = useState<Session | null>(null);
  const [userRole, setUserRole] = useState<'admin' | 'auditor' | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<ActiveTab>('mission');
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

  // NUEVO: Ref para evitar rebotes infinitos al emitir la misión global
  const lastBroadcastedMissionRef = useRef<string | null>(null);

  // Consultar Rol Oficial en la Base de Datos
  const fetchUserRole = async (userId: string) => {
    try {
      const { data } = await supabase
        .from('Read_Users_Gamification')
        .select('Role')
        .eq('UserId', userId)
        .single();
      
      const role = data?.Role || 'auditor';
      setUserRole(role);
      // Ruteo automático: Admin va a Ingesta, Auditor va a Almacén
      setActiveTab(role === 'admin' ? 'ingestion' : 'mission'); 
    } catch (err) {
      console.error("Error obteniendo rol", err);
      setUserRole('auditor');
      setActiveTab('mission');
    }
  };

  // Verificación de Sesión Inicial
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user) {
        fetchUserRole(session.user.id).then(() => setIsCheckingAuth(false));
      } else {
        setIsCheckingAuth(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session?.user) {
        fetchUserRole(session.user.id).then(() => setIsCheckingAuth(false));
      } else {
        setUserRole(null);
        setIsCheckingAuth(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // 1. Verificación de Conectividad periódica y escucha de eventos de la cola offline
  const refreshConnectionAndQueue = async () => {
    if (!session) return;
    const status = await checkSupabaseConnection();
    setDbStatus(status);
    const count = await getOfflineQueueCount();
    setQueuedEvents(count);

    // NUEVO FASE 1.5: OYENTE GLOBAL - Buscar si existe una misión fijada por el administrador
    if (isOnline) {
      try {
        const { data } = await supabase
          .from('Read_Missions')
          .select('*')
          .eq('IsGlobalActive', true)
          .maybeSingle();

        if (data && data.MissionId !== activeMissionId) {
          lastBroadcastedMissionRef.current = data.MissionId; // Prevenir auto-rebote
          setActiveMissionId(data.MissionId);
          setActiveMission({
            missionId: data.MissionId,
            name: data.Name,
            depositCode: data.DepositCode,
            totalSkus: data.TotalSkus,
            countedSkus: data.CountedSkus,
            pendingSkus: data.PendingSkus,
            discrepantSkus: data.DiscrepantSkus,
            reconciledSkus: data.ReconciledSkus,
            status: data.Status
          });
          await fetchMissionTasks(data.MissionId);
          showToast(`Misión Anclada: ${data.Name}`, 'success');
        }
      } catch (err) {
        console.warn('Error validando misión global', err);
      }
    }
  };

  useEffect(() => {
    if (!session) return;
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
  }, [activeMissionId, fetchMissionTasks, session, isOnline]);

  // NUEVO FASE 1.5: TRANSMISOR GLOBAL (Solo Admin)
  // Cuando el admin selecciona una nueva misión, se inyecta a la BD para anclar a los auditores
  useEffect(() => {
    if (userRole === 'admin' && activeMissionId && activeMissionId !== lastBroadcastedMissionRef.current && isOnline) {
      const broadcastMissionToAll = async () => {
        lastBroadcastedMissionRef.current = activeMissionId;
        try {
          // Desactivar cualquier otra misión
          await supabase.from('Read_Missions').update({ IsGlobalActive: false }).neq('MissionId', activeMissionId);
          // Activar la seleccionada
          await supabase.from('Read_Missions').update({ IsGlobalActive: true }).eq('MissionId', activeMissionId);
          showToast('Misión anclada para todos los operadores', 'success');
        } catch (err) {
          console.error('Error al hacer broadcast de la misión', err);
        }
      };
      broadcastMissionToAll();
    }
  }, [activeMissionId, userRole, isOnline]);

  // 2. Listener global para el evento `online` del navegador
  useEffect(() => {
    if (!session) return;
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
  }, [activeMissionId, fetchMissionTasks, session]);

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

  // LOGIN MODO QUIOSCO (1 Clic)
  const handleQuickLogin = async (email: string, pass: string) => {
    setIsLoggingIn(true);
    setLoginError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) setLoginError('Error de acceso. Verifique los usuarios en Supabase.');
    setIsLoggingIn(false);
  };

  // PANTALLA DE CARGA GLOBAL
  if (isCheckingAuth) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center space-y-4">
        <RefreshCw className="w-8 h-8 text-emerald-500 animate-spin" />
      </div>
    );
  }

  // ============================================================ 
  // PANTALLA DE LOGIN MODO QUIOSCO (SIN SESIÓN)
  // ============================================================ 
  if (!session) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 selection:bg-emerald-600 selection:text-white">
        <div className="w-full max-w-md bg-slate-900/50 border border-slate-800 rounded-2xl p-8 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 to-[#009045]" />
          
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-[#009045]/20 flex items-center justify-center mb-4 border border-[#009045]/30">
               <Fingerprint className="w-8 h-8 text-[#009045]" />
            </div>
            <h1 className="text-2xl font-black text-white leading-none">SELECCIONA TU <span className="text-[#009045]">USUARIO</span></h1>
            <p className="text-slate-400 text-sm mt-2 text-center">Toca tu nombre para acceder al sistema.</p>
          </div>

          <div className="space-y-3">
            {KIOSK_USERS.map((u) => (
              <button
                key={u.name}
                onClick={() => handleQuickLogin(u.email, u.pass)}
                disabled={isLoggingIn}
                className="w-full flex items-center justify-between p-4 bg-slate-950 border border-slate-800 rounded-xl hover:border-slate-600 transition-all group disabled:opacity-50"
              >
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-lg ${u.bg} flex items-center justify-center`}>
                    <u.icon className={`w-5 h-5 ${u.color}`} />
                  </div>
                  <span className="text-white font-bold text-lg">{u.name}</span>
                </div>
                <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center group-hover:bg-[#009045] transition-colors">
                  <RefreshCw className={`w-4 h-4 text-white ${isLoggingIn ? 'animate-spin' : 'hidden'}`} />
                  <ArrowRight className={`w-4 h-4 text-white ${isLoggingIn ? 'hidden' : 'block'}`} />
                </div>
              </button>
            ))}
          </div>

          {loginError && <div className="mt-4 p-3 bg-rose-950/50 border border-rose-800/80 rounded-lg text-rose-300 text-xs font-medium text-center">{loginError}</div>}
        </div>
      </div>
    );
  }

  // ============================================================ 
  // APLICACIÓN PRINCIPAL (CON SESIÓN ACTIVA)
  // ============================================================ 
  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans pb-24 antialiased selection:bg-blue-600 selection:text-white">
      {/* ============================================================ */}
      {/* 1. BARRA SUPERIOR (HEADER INDUSTRIAL PWA)                    */}
      {/* ============================================================ */}
      <header className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur-md border-b border-slate-800 px-3 sm:px-5 py-2.5 shadow-lg">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          {/* Logo y Misión Activa */}
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-[#009045] flex items-center justify-center shadow-md shadow-emerald-900/40 text-white font-black text-sm shrink-0">
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
                    onClick={() => userRole === 'admin' && setActiveTab('ingestion')}
                    className={`text-[11px] font-mono font-bold flex items-center gap-1 transition ${userRole === 'admin' ? 'text-emerald-400 hover:text-emerald-300' : 'text-emerald-400 cursor-default'}`}
                  >
                    <span>Misión: {activeMissionId.slice(0, 8)}</span>
                    {userRole === 'admin' && <ChevronRight className="w-3 h-3 text-slate-500" />}
                  </button>
                ) : (
                  <button
                    onClick={() => userRole === 'admin' && setActiveTab('ingestion')}
                    className={`text-[11px] font-bold flex items-center gap-1 ${userRole === 'admin' ? 'text-amber-400 hover:text-amber-300' : 'text-amber-400 cursor-default'}`}
                  >
                    {/* Ajuste visual para el auditor cuando aún no hay misión */}
                    <span>{userRole === 'admin' ? 'Seleccionar misión' : 'Esperando asignación...'}</span>
                    {userRole === 'admin' && <ChevronRight className="w-3 h-3 text-amber-500" />}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Controles de Sesión, Red y Sincronización */}
          <div className="flex items-center gap-2">
            {/* Info de Usuario y Rol */}
            <div className="hidden xs:flex items-center gap-1.5 text-xs text-slate-400 bg-slate-800/50 px-2 py-1 rounded-lg">
              <User className="w-3 h-3" /> 
              <span className="capitalize font-bold text-white">{session.user.email?.split('@')[0]}</span>
              <span className="uppercase text-[10px] text-[#009045] ml-1 font-bold">({userRole})</span>
            </div>

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
              </button>
            )}

            {/* Badge de Conectividad */}
            <div
              className={`px-2 py-1 rounded-xl text-[10px] sm:text-xs font-bold flex items-center gap-1 border transition ${
                isOnline
                  ? 'bg-emerald-950/70 border-emerald-600/60 text-emerald-300'
                  : 'bg-rose-950/70 border-rose-600/60 text-rose-300 animate-pulse'
              }`}
            >
              {isOnline ? <Wifi className="w-3.5 h-3.5 text-emerald-400" /> : <WifiOff className="w-3.5 h-3.5 text-rose-400" />}
            </div>

            {/* Logout */}
            <button onClick={async () => await supabase.auth.signOut()} className="p-1.5 text-slate-400 hover:text-rose-400 bg-slate-800 rounded-lg transition" title="Salir">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* ============================================================ */}
      {/* 2. CONTENIDO PRINCIPAL SEGÚN TAB ACTIVO                      */}
      {/* ============================================================ */}
      <main className="flex-1 p-3 sm:p-5 max-w-5xl mx-auto w-full space-y-4">
        {activeTab === 'ingestion' && userRole === 'admin' && (
          <TabIngestion onMissionSelected={() => setActiveTab('mission')} />
        )}

        {activeTab === 'mission' && (
          <div className="space-y-4">
            <TabCollector onNavigateToFloor={() => setActiveTab('discrepancies')} />
          </div>
        )}

        {activeTab === 'discrepancies' && (
          <TabFloorReconciliation />
        )}

        {activeTab === 'reports' && (
          <TabReports />
        )}
      </main>

      {/* ============================================================ */}
      {/* 3. PWA BOTTOM NAVIGATION DOCK (FILTRO POR ROL)              */}
      {/* ============================================================ */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-slate-900/95 backdrop-blur-lg border-t border-slate-800 shadow-2xl safe-area-bottom">
        <div className="max-w-lg mx-auto flex items-center justify-around px-2 py-1.5">
          {/* Tab 1: Ingesta / Misiones (SÓLO ADMIN) */}
          {userRole === 'admin' && (
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
          )}

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