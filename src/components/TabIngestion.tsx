/**
 * AUDITORIAPLUS+ - Tab Ingesta de Misiones y Dashboard de Auditorías
 * Carga directa de archivos Excel/CSV hacia Supabase Edge Function 'ingest-excel'.
 * Lectura en tiempo real de Read_Missions y selección de misión activa.
 * REGLA DE ORO: Cero datos mock o simulados. Conexión 100% real a PostgreSQL.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  UploadCloud,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Layers,
  Calendar,
  ShieldCheck,
  ArrowRight,
  Hash,
  Database,
  Check,
  AlertCircle
} from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useMissionStore } from '../store/useMissionStore';
import { DepositCode, DEPOSIT_NAMES } from '../types/audit';

interface MissionRecord {
  MissionId: string;
  Name?: string;
  MissionName?: string;
  DepositCode: string;
  ExcelHashSHA256?: string;
  ExcelHash?: string;
  Status: string;
  TotalSkus?: number;
  TotalTasks?: number;
  CountedSkus?: number;
  CompletedTasks?: number;
  PendingSkus?: number;
  DiscrepantSkus?: number;
  ReconciledSkus?: number;
  ReconciledTasks?: number;
  CreatedAt: string;
  UpdatedAt?: string;
}

interface TabIngestionProps {
  onMissionSelected?: (missionId: string) => void;
}

export const TabIngestion: React.FC<TabIngestionProps> = ({ onMissionSelected }) => {
  const {
    activeMissionId,
    setActiveMissionId,
    fetchMissionTasks,
    setActiveMission,
    isOnline,
  } = useMissionStore();

  // Estados de Ingesta BLINDADOS (2 archivos separados)
  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [missionName, setMissionName] = useState<string>('');
  const [depositCode, setDepositCode] = useState<DepositCode>('150101');
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadResult, setUploadResult] = useState<{
    success: boolean;
    hash?: string;
    missionId?: string;
    totalTasks?: number;
    error?: string;
  } | null>(null);

  // Estados de Listado de Misiones
  const [missions, setMissions] = useState<MissionRecord[]>([]);
  const [isLoadingMissions, setIsLoadingMissions] = useState<boolean>(false);
  const [missionsError, setMissionsError] = useState<string | null>(null);

  const fileInputARef = useRef<HTMLInputElement>(null);
  const fileInputBRef = useRef<HTMLInputElement>(null);

  // 1. Cargar misiones reales desde Read_Missions en Supabase
  const loadMissions = async () => {
    if (!isSupabaseConfigured) {
      setMissionsError('Supabase no está configurado. Configure VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en su archivo de entorno.');
      return;
    }

    setIsLoadingMissions(true);
    setMissionsError(null);

    try {
      const { data, error } = await supabase
        .from('Read_Missions')
        .select('*')
        .order('CreatedAt', { ascending: false });

      if (error) {
        console.error('[TabIngestion] Error al consultar Read_Missions:', error);
        setMissionsError(error.message);
        setMissions([]);
      } else if (data) {
        setMissions(data as MissionRecord[]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TabIngestion] Excepción al leer misiones:', msg);
      setMissionsError(msg);
      setMissions([]);
    } finally {
      setIsLoadingMissions(false);
    }
  };

  useEffect(() => {
    loadMissions();
  }, [isOnline]);

  const handleFileAChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFileA(selectedFile);
      setUploadResult(null);

      // Sugerir nombre de misión a partir del archivo A si está vacío
      if (!missionName) {
        const nameWithoutExt = selectedFile.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
        setMissionName(`Auditoría ${nameWithoutExt}`);
      }
    }
  };

  const handleFileBChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFileB(e.target.files[0]);
      setUploadResult(null);
    }
  };

  // 2. Envío a la Edge Function 'ingest-excel' (BLINDADO CON FETCH NATIVO)
  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fileA || !fileB) {
      setUploadResult({
        success: false,
        error: 'Obligatorio: Debes cargar tanto el Archivo A (Taxonomía) como el Archivo B (Costos).',
      });
      return;
    }

    if (!isSupabaseConfigured) {
      setUploadResult({
        success: false,
        error: 'Supabase no está configurado. No se puede invocar la Edge Function ingest-excel.',
      });
      return;
    }

    setIsUploading(true);
    setUploadResult(null);

    try {
      const formData = new FormData();
      // Nombres de parámetros estrictos exigidos por el backend[cite: 3]
      formData.append('file_a', fileA);
      formData.append('file_b', fileB);
      formData.append('deposit_code', depositCode);
      formData.append(
        'mission_name',
        missionName.trim() || `Auditoría ${new Date().toLocaleDateString('es-ES')}`
      );

      // =====================================================================
      // SOLUCIÓN 0 INCERTIDUMBRE: BYPASS AL BUG DE SUPABASE-JS CON FETCH NATIVO
      // =====================================================================
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token || import.meta.env.VITE_SUPABASE_ANON_KEY;

      const response = await fetch(`${supabaseUrl}/functions/v1/ingest-excel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
          // ¡REGLA DE ORO!: NUNCA escribas el 'Content-Type' aquí. 
          // Al dejarlo vacío, el navegador inyecta el multipart/form-data con los bytes exactos.
        },
        body: formData,
      });

      // Parseamos la respuesta del servidor en Deno
      const responseData = await response.json().catch(() => ({}));

      if (!response.ok) {
        // Si el servidor rechaza la petición (Error 400 o 409)
        const errorMsg =
          response.status === 409
            ? 'Conflicto (409): Esta misión ya ha sido ingerida previamente. El hash SHA-256 es idéntico a una existente.'
            : responseData.error || 'Error en la Edge Function ingest-excel.';

        setUploadResult({
          success: false,
          error: errorMsg,
        });
      } else {
        // Si el servidor responde con éxito (200 OK / 201 Created)
        const data = responseData;
        const hash = data?.excel_hash || data?.excel_hash_sha256 || data?.data?.excel_hash_sha256 || 'Calculado en backend';
        const newMissionId = data?.mission_id || data?.data?.mission_id;
        const total = data?.total_tasks || data?.data?.total_tasks || 0;

        setUploadResult({
          success: true,
          hash,
          missionId: newMissionId,
          totalTasks: total,
        });

        // Limpiar archivos seleccionados físicamente
        setFileA(null);
        setFileB(null);
        if (fileInputARef.current) fileInputARef.current.value = '';
        if (fileInputBRef.current) fileInputBRef.current.value = '';

        // Recargar misiones y seleccionar automáticamente si hay ID
        await loadMissions();
        if (newMissionId) {
          await handleSelectMission(newMissionId);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setUploadResult({
        success: false,
        error: `Fallo de conexión al enviar archivo: ${msg}`,
      });
    } finally {
      setIsUploading(false);
    }
  };

  // 3. Selección de Misión
  const handleSelectMission = async (missionId: string) => {
    setActiveMissionId(missionId);

    // Buscar en lista local
    const selected = missions.find((m) => m.MissionId === missionId);
    if (selected) {
      const total = Number(selected.TotalSkus || selected.TotalTasks || 0);
      const counted = Number(selected.CountedSkus || selected.CompletedTasks || 0);
      const pending = Number(selected.PendingSkus ?? Math.max(0, total - counted));
      const discrepant = Number(selected.DiscrepantSkus || 0);
      const reconciled = Number(selected.ReconciledSkus || selected.ReconciledTasks || 0);

      setActiveMission({
        missionId: selected.MissionId,
        name: selected.Name || selected.MissionName || `Misión ${selected.MissionId.slice(0, 8)}`,
        depositCode: (selected.DepositCode as DepositCode) || '150101',
        totalSkus: total,
        countedSkus: counted,
        pendingSkus: pending,
        discrepantSkus: discrepant,
        reconciledSkus: reconciled,
        totalCostDiscrepancy: 0,
        status: (selected.Status as 'IN_PROGRESS' | 'COMPLETED' | 'CLOSED') || 'IN_PROGRESS',
        createdAt: selected.CreatedAt,
      });
    }

    // Cargar tareas desde Supabase
    await fetchMissionTasks(missionId);

    if (onMissionSelected) {
      onMissionSelected(missionId);
    }
  };

  return (
    <div className="space-y-6">
      {/* SECCIÓN 1: FORMULARIO DE INGESTA DE ARCHIVOS BLINDADO */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl">
        <div className="flex items-center gap-3 pb-4 border-b border-slate-800">
          <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/40 text-blue-400 flex items-center justify-center shrink-0">
            <UploadCloud className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-black text-white tracking-tight">
              Ingesta de Inventario a Supabase
            </h2>
            <p className="text-xs text-slate-400">
              Carga estrictamente el Archivo A (Taxonomía) y Archivo B (Costos) para inicializar la misión.
            </p>
          </div>
        </div>

        <form onSubmit={handleUpload} className="mt-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Selector de Depósito */}
            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1">
                Depósito a Auditar (Misión Base)
              </label>
              <select
                value={depositCode}
                onChange={(e) => setDepositCode(e.target.value as DepositCode)}
                className="w-full h-11 px-3 bg-slate-950 border border-slate-700 rounded-lg text-white font-medium text-sm focus:outline-hidden focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                disabled={isUploading}
              >
                <option value="150101">150101 - Almacén Principal (Origen)</option>
                <option value="150103">150103 - Piso de Venta (Solo si es misión directa)</option>
                <option value="150102">150102 - Avería / Merma</option>
              </select>
              <p className="text-[10px] text-slate-500 mt-1">
                Nota: Faltantes de almacén se arreglan desde Tab 2, no subiendo otro Excel.
              </p>
            </div>

            {/* Nombre de la Misión */}
            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1">
                Nombre de la Misión
              </label>
              <input
                type="text"
                value={missionName}
                onChange={(e) => setMissionName(e.target.value)}
                placeholder="Ej: Auditoría Almacén Q3 - Central"
                className="w-full h-11 px-3.5 bg-slate-950 border border-slate-700 rounded-lg text-white font-medium text-sm focus:outline-hidden focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                disabled={isUploading}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            {/* Archivo A: Taxonomía */}
            <div className={`p-4 border rounded-xl transition ${fileA ? 'border-emerald-500/50 bg-emerald-950/20' : 'border-slate-700 bg-slate-950/50'}`}>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">
                Archivo A: Taxonomía y EANs
              </label>
              <input
                ref={fileInputARef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileAChange}
                disabled={isUploading}
                className="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-blue-600 file:text-white hover:file:bg-blue-500 cursor-pointer"
              />
              {fileA && <p className="text-xs text-emerald-400 mt-2 font-medium break-all">{fileA.name}</p>}
            </div>

            {/* Archivo B: Costos */}
            <div className={`p-4 border rounded-xl transition ${fileB ? 'border-emerald-500/50 bg-emerald-950/20' : 'border-slate-700 bg-slate-950/50'}`}>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">
                Archivo B: Costos y Stock ERP
              </label>
              <input
                ref={fileInputBRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileBChange}
                disabled={isUploading}
                className="block w-full text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-blue-600 file:text-white hover:file:bg-blue-500 cursor-pointer"
              />
              {fileB && <p className="text-xs text-emerald-400 mt-2 font-medium break-all">{fileB.name}</p>}
            </div>
          </div>

          {/* Feedback de Ingesta */}
          {uploadResult && (
            <div
              className={`p-3.5 rounded-xl border text-xs sm:text-sm font-medium ${
                uploadResult.success
                  ? 'bg-emerald-950/60 border-emerald-500 text-emerald-200'
                  : 'bg-rose-950/60 border-rose-500 text-rose-200'
              }`}
            >
              {uploadResult.success ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-bold text-emerald-300">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>Misión creada e ingesta completada con éxito</span>
                  </div>
                  {uploadResult.hash && (
                    <div className="flex items-center gap-1.5 text-xs text-slate-300 font-mono break-all pt-1">
                      <Hash className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>SHA-256: {uploadResult.hash}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold block text-rose-300">Fallo en la ingesta</span>
                    <span>{uploadResult.error}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Botón de Ingesta */}
          <button
            type="submit"
            disabled={!fileA || !fileB || isUploading}
            className="w-full btn-collector bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white min-h-[48px] rounded-xl font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20 transition mt-2"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Procesando y cruzando Archivos A y B en la Nube...</span>
              </>
            ) : (
              <>
                <FileSpreadsheet className="w-4 h-4" />
                <span>Iniciar Ingesta Definitiva</span>
              </>
            )}
          </button>
        </form>
      </section>

      {/* SECCIÓN 2: LISTA DE MISIONES ACTIVAS Y SELECCIÓN */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-blue-400" />
            <h3 className="text-base font-black text-white">Misiones en la Base de Datos</h3>
            <span className="text-xs font-mono bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full border border-slate-700">
              {missions.length}
            </span>
          </div>

          <button
            onClick={loadMissions}
            disabled={isLoadingMissions}
            className="p-2 text-xs font-bold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg flex items-center gap-1.5 min-h-[38px] transition"
            title="Recargar misiones desde Supabase"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingMissions ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Actualizar</span>
          </button>
        </div>

        {missionsError && (
          <div className="bg-rose-950/40 border border-rose-800/80 p-3.5 rounded-xl text-xs text-rose-300 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold block">Error al consultar Read_Missions:</span>
              <span>{missionsError}</span>
            </div>
          </div>
        )}

        {isLoadingMissions && missions.length === 0 ? (
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-8 text-center text-slate-400 space-y-2">
            <Loader2 className="w-8 h-8 mx-auto animate-spin text-blue-500" />
            <p className="text-sm font-semibold text-slate-200">Consultando Read_Missions en PostgreSQL...</p>
          </div>
        ) : missions.length === 0 ? (
          <div className="bg-slate-900/40 border-2 border-dashed border-slate-800 rounded-xl p-8 text-center text-slate-400 space-y-2">
            <Database className="w-10 h-10 mx-auto text-slate-600" />
            <h4 className="text-sm font-bold text-slate-300">No hay misiones registradas</h4>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              Utiliza el formulario superior para cargar el archivo Excel o CSV y desplegar la primera misión de auditoría.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {missions.map((mission) => {
              const isActive = activeMissionId === mission.MissionId;
              const totalSkus = Number(mission.TotalSkus || mission.TotalTasks || 0);
              const countedSkus = Number(mission.CountedSkus || mission.CompletedTasks || 0);
              const discrepantSkus = Number(mission.DiscrepantSkus || 0);
              const progress = totalSkus > 0 ? Math.min(100, Math.round((countedSkus / totalSkus) * 100)) : 0;
              const createdDate = new Date(mission.CreatedAt).toLocaleDateString('es-ES', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });

              return (
                <div
                  key={mission.MissionId}
                  className={`bg-slate-900 border rounded-xl p-4 transition shadow-md flex flex-col justify-between gap-3 ${
                    isActive
                      ? 'border-blue-500 shadow-blue-500/10 ring-1 ring-blue-500'
                      : 'border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] uppercase font-bold tracking-wider bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700">
                            {DEPOSIT_NAMES[mission.DepositCode as DepositCode] || `Depósito ${mission.DepositCode}`}
                          </span>
                          {isActive && (
                            <span className="text-[10px] uppercase font-black tracking-wider bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded border border-blue-500/30 flex items-center gap-1">
                              <Check className="w-3 h-3" />
                              Activa
                            </span>
                          )}
                        </div>

                        <h4 className="text-base font-bold text-white mt-1.5 leading-snug">
                          {mission.Name || mission.MissionName || 'Auditoría General'}
                        </h4>
                      </div>
                    </div>

                    <div className="text-[11px] text-slate-400 space-y-0.5">
                      <div className="flex items-center gap-1 font-mono text-[10px] text-slate-500 truncate">
                        <Hash className="w-3 h-3 shrink-0" />
                        <span>{mission.MissionId}</span>
                      </div>
                      <div className="flex items-center gap-1 text-slate-400">
                        <Calendar className="w-3 h-3 text-slate-500 shrink-0" />
                        <span>{createdDate}</span>
                      </div>
                    </div>

                    <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80 space-y-1.5">
                      <div className="flex justify-between text-xs font-semibold">
                        <span className="text-slate-400">Progreso de Conteo:</span>
                        <span className="font-mono text-white">
                          {countedSkus} / {totalSkus} SKUs ({progress}%)
                        </span>
                      </div>
                      <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                        <div
                          className="bg-blue-500 h-full transition-all duration-300"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      {discrepantSkus > 0 && (
                        <div className="flex items-center gap-1 text-[11px] text-amber-400 font-semibold pt-0.5">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          <span>{discrepantSkus} discrepancias detectadas</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => handleSelectMission(mission.MissionId)}
                    disabled={isActive}
                    className={`btn-collector w-full min-h-[48px] rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition ${
                      isActive
                        ? 'bg-slate-800 text-slate-400 cursor-default border border-slate-700'
                        : 'bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-600/20 active:scale-[0.99]'
                    }`}
                  >
                    {isActive ? (
                      <>
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span>Misión Seleccionada</span>
                      </>
                    ) : (
                      <>
                        <span>Seleccionar Misión</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

export default TabIngestion;