/**
 * AUDITORIAPLUS+ - Tab 1/2: Colector de Conteo en Almacén (Depósito 150101)
 * Ergonomía táctil para terminales industriales (Honeywell, Zebra, Smartphones)
 * Mínimo 48px - 56px por botón, contraste extremo, modo offline garantizado.
 * Integración de Escáner Óptico de Cámara HTML5 con retícula verde y flash toggle.
 * FASE 1: Inyección de Estadísticas en Tiempo Real.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Barcode,
  Search,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Zap,
  Wifi,
  WifiOff,
  X,
  Camera,
  CameraOff,
  Scan,
  Sparkles
} from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { useMissionStore } from '../store/useMissionStore';
import { useDiscrepancyStore } from '../stores/useDiscrepancyStore';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { enqueueOfflineEvent } from '../lib/db';
import { normalizeSku, FloorDiscrepancy } from '../types/audit';
// NUEVO: Importación del store de Auth para inyectar el user_id
import { useAuthStore } from '../stores/useAuthStore';

interface TabCollectorProps {
  onNavigateToFloor?: () => void;
}

const VIEWPORT_ID = 'barcode-scanner-viewport';

export const TabCollector: React.FC<TabCollectorProps> = ({ onNavigateToFloor }) => {
  const isOnline = useOnlineStatus();
  // NUEVO: Extraemos el usuario actual
  const user = useAuthStore(state => state.user);

  // Stores
  const {
    activeMission,
    activeMissionId,
    activeTask,
    tasks,
    searchTerm,
    setSearchTerm,
    setActiveTaskBySku,
    updateTaskCountLocally,
    clearActiveTask,
  } = useMissionStore();

  const { addDiscrepancy } = useDiscrepancyStore();

  // Estados locales de conteo
  const [countedInput, setCountedInput] = useState<string>('');
  const [salesInput, setSalesInput] = useState<string>('0');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [toast, setToast] = useState<{
    text: string;
    type: 'success' | 'warning' | 'error';
    discrepancyVal?: number;
  } | null>(null);

  // Estados de escáner de cámara
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [isCameraStarting, setIsCameraStarting] = useState<boolean>(false);
  const [isTorchOn, setIsTorchOn] = useState<boolean>(false);
  const [hasTorchCapability, setHasTorchCapability] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Referencias
  const scannerInputRef = useRef<HTMLInputElement>(null);
  const countInputRef = useRef<HTMLInputElement>(null);
  const html5QrCodeRef = useRef<Html5Qrcode | null>(null);
  const lastScanTimeRef = useRef<number>(0);
  const lastScannedCodeRef = useRef<string>('');

  // VARIABLES DE ESTADÍSTICAS EN VIVO
  const totalSkus = activeMission?.totalSkus || 0;
  const countedSkus = activeMission?.countedSkus || 0;
  const discrepantSkus = activeMission?.discrepantSkus || 0;
  const pendingSkus = activeMission?.pendingSkus || 0;
  const progressPct = totalSkus > 0 ? Math.round((countedSkus / totalSkus) * 100) : 0;

  useEffect(() => {
    scannerInputRef.current?.focus();
  }, []);

  const applyLpadNormalization = (raw: string): string => {
    const trimmed = (raw || '').trim();
    if (/^\d{1,6}$/.test(trimmed)) {
      return trimmed.padStart(6, '0');
    }
    return normalizeSku(trimmed);
  };

  const showToastBanner = useCallback(
    (text: string, type: 'success' | 'warning' | 'error', discrepancyVal?: number) => {
      setToast({ text, type, discrepancyVal });
      setTimeout(() => {
        setToast(null);
      }, 4500);
    },
    []
  );

  const processDetectedCode = useCallback(
    (rawCode: string, origin: 'camera' | 'manual') => {
      if (!rawCode || !rawCode.trim()) return;
      const normalizedSku = applyLpadNormalization(rawCode);

      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(origin === 'camera' ? 100 : 40);
      }

      setSearchTerm(normalizedSku);
      const task = setActiveTaskBySku(normalizedSku);

      if (!task) {
        showToastBanner(`No se encontró el SKU o código "${normalizedSku}" en esta misión`, 'warning');
        scannerInputRef.current?.focus();
        scannerInputRef.current?.select();
      } else {
        showToastBanner(`SKU ${task.SkuCode || task.skuCode} ${origin === 'camera' ? 'escaneado por cámara' : 'cargado'}`, 'success');
      }
    },
    [setActiveTaskBySku, setSearchTerm, showToastBanner]
  );

  const stopCameraScanner = useCallback(async () => {
    if (html5QrCodeRef.current) {
      try {
        if (html5QrCodeRef.current.isScanning) {
          await html5QrCodeRef.current.stop();
        }
        html5QrCodeRef.current.clear();
      } catch (err) {
        console.warn('[TabCollector] Limpieza de cámara:', err);
      }
      html5QrCodeRef.current = null;
    }
    setIsCameraActive(false);
    setIsTorchOn(false);
    setIsCameraStarting(false);
  }, []);

  const startCameraScanner = useCallback(async () => {
    setCameraError(null);
    try {
      await stopCameraScanner();
      setIsCameraStarting(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const qrScanner = new Html5Qrcode(VIEWPORT_ID, false);
      html5QrCodeRef.current = qrScanner;

      await qrScanner.start(
        { facingMode: 'environment' },
        {
          fps: 15,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const minEdgePercentage = 0.78;
            const minEdgeSize = Math.min(viewfinderWidth, viewfinderHeight);
            const boxSize = Math.floor(minEdgeSize * minEdgePercentage);
            return {
              width: Math.min(300, viewfinderWidth - 24),
              height: Math.min(180, Math.floor(boxSize * 0.7)),
            };
          },
          aspectRatio: 1.777778,
        },
        (decodedText: string) => {
          const now = Date.now();
          if (now - lastScanTimeRef.current < 1200 && lastScannedCodeRef.current === decodedText) {
            return;
          }
          lastScanTimeRef.current = now;
          lastScannedCodeRef.current = decodedText;
          processDetectedCode(decodedText, 'camera');
        },
        (_error) => {}
      );

      setIsCameraActive(true);
      try {
        const capabilities = qrScanner.getRunningTrackCapabilities();
        if (capabilities && 'torch' in capabilities) {
          setHasTorchCapability(true);
        } else {
          setHasTorchCapability(false);
        }
      } catch {
        setHasTorchCapability(false);
      }
    } catch (err: unknown) {
      console.warn('[TabCollector] Fallo al iniciar visor de cámara:', err);
      const errMsg = err instanceof Error ? err.message : 'No se pudo acceder a la cámara. Verifique los permisos del navegador.';
      setCameraError(errMsg);
      setIsCameraActive(false);
      showToastBanner('No fue posible abrir la cámara. Use el input manual.', 'warning');
    } finally {
      setIsCameraStarting(false);
    }
  }, [processDetectedCode, showToastBanner, stopCameraScanner]);

  const toggleFlashTorch = async () => {
    if (!html5QrCodeRef.current || !isCameraActive) return;
    try {
      const nextState = !isTorchOn;
      await html5QrCodeRef.current.applyVideoConstraints({
        // @ts-expect-error torch is valid
        advanced: [{ torch: nextState }],
      });
      setIsTorchOn(nextState);
    } catch (err) {
      console.warn('[TabCollector] Error al alternar linterna:', err);
      showToastBanner('El flash no está soportado en este dispositivo', 'warning');
    }
  };

  const toggleCamera = () => {
    if (isCameraActive || isCameraStarting) {
      stopCameraScanner();
    } else {
      startCameraScanner();
    }
  };

  useEffect(() => {
    return () => {
      if (html5QrCodeRef.current) {
        try {
          if (html5QrCodeRef.current.isScanning) {
            html5QrCodeRef.current.stop().catch(() => {});
          }
          html5QrCodeRef.current.clear();
        } catch {}
      }
    };
  }, []);

  useEffect(() => {
    if (activeTask) {
      const existingCount = activeTask.CountedQuantity !== null && activeTask.CountedQuantity !== undefined
        ? String(activeTask.CountedQuantity)
        : activeTask.countedQuantity !== null && activeTask.countedQuantity !== undefined
        ? String(activeTask.countedQuantity)
        : '';
          
      const existingSales = activeTask.SalesDuringAudit !== undefined 
        ? String(activeTask.SalesDuringAudit) 
        : String(activeTask.salesDuringAudit || 0);
          
      setCountedInput(existingCount);
      setSalesInput(existingSales);

      setTimeout(() => {
        countInputRef.current?.focus();
        countInputRef.current?.select();
      }, 50);
    } else {
      setCountedInput('');
      setSalesInput('0');
    }
  }, [activeTask]);

  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    processDetectedCode(searchTerm, 'manual');
  };

  const adjustCount = (delta: number) => {
    const current = parseFloat(countedInput) || 0;
    const nextVal = Math.max(0, current + delta);
    setCountedInput(String(nextVal));
  };

  const systemQty = Number(activeTask?.SystemQuantity ?? activeTask?.systemQuantity ?? 0);
  const salesQty = parseFloat(salesInput) || 0;
  const adjustedTheoretical = systemQty - salesQty;
  const countedQty = parseFloat(countedInput);
  const isCountValid = !isNaN(countedQty) && countedQty >= 0;
  const liveDiscrepancy = isCountValid ? countedQty - adjustedTheoretical : 0;
  const isExactMatch = isCountValid && liveDiscrepancy === 0;

  // NUEVO FLUJO CQRS: Registro Puro sin Mutar la Base de Datos Directamente
  const handleRegisterCount = async () => {
    if (!activeTask) return;
    
    // Validamos Sesión
    if (!user) {
      showToastBanner('Error: Sesión expirada o no válida. Vuelve a iniciar sesión.', 'error');
      return;
    }

    if (!isCountValid) {
      showToastBanner('Ingrese una cantidad válida mayor o igual a cero', 'error');
      countInputRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    const discrepancy = Number((countedQty - adjustedTheoretical).toFixed(2));
    const taskStatus = discrepancy === 0 ? 'COMPLETED_MATCH' : 'DISCREPANT';
    const skuCodeToUse = activeTask.SkuCode || activeTask.skuCode;
    const missionIdToUse = activeMissionId || activeTask.MissionId || activeTask.missionId;
    const taskIdToUse = activeTask.TaskId || activeTask.taskId;
    const depositCodeToUse = activeTask.DepositCode || activeTask.depositCode || '150101';
    const skuDescToUse = activeTask.SkuDescription || activeTask.skuDescription;

    // 1. Actualización optimista local en memoria (Feedback Instantáneo al Operador)
    updateTaskCountLocally(skuCodeToUse, countedQty, salesQty, discrepancy, taskStatus);

    // 2. Si se detecta discrepancia, registrar en cola local de piso
    if (discrepancy !== 0) {
      const discItem: FloorDiscrepancy = {
        discrepancyId: crypto.randomUUID ? crypto.randomUUID() : `disc_${Date.now()}`,
        taskId: taskIdToUse,
        missionId: missionIdToUse,
        skuCode: skuCodeToUse,
        skuDescription: skuDescToUse,
        warehouseDiscrepancy: discrepancy,
        originDeposit: depositCodeToUse as any,
        floorDeposit: '150103',
        floorSystemQuantity: 0,
        floorCountedQuantity: null,
        floorDiscrepancy: null,
        status: 'PENDING_FLOOR_COUNT',
      };
      addDiscrepancy(discItem);
    }

    // 3. Payload oficial con USER_ID
    const payload = {
      mission_id: missionIdToUse,
      task_id: taskIdToUse,
      deposit_code: depositCodeToUse,
      sku_code: skuCodeToUse,
      counted_quantity: countedQty,
      sales_during_audit: salesQty,
      user_id: user.id // <--- INYECTADO AQUÍ (Soluciona el error de red de la Fase 1)
    };

    // 4. Estrategia de Envío asíncrono
    try {
      if (isOnline && isSupabaseConfigured) {
        // SOLUCIÓN CQRS: Llamar a la API. Si falla, encolar. JAMÁS mutar la DB directo.
        const { error } = await supabase.functions.invoke('register-count', {
          body: payload,
        });

        if (error) {
          console.warn('[TabCollector] Edge Function falló, encolando offline:', error);
          await enqueueOfflineEvent({
            type: 'register-count',
            missionId: missionIdToUse,
            taskId: taskIdToUse,
            payload,
          });
        }
      } else {
        await enqueueOfflineEvent({
          type: 'register-count',
          missionId: missionIdToUse,
          taskId: taskIdToUse,
          payload,
        });
      }
    } catch (err) {
      console.warn('[TabCollector] Error de red al registrar conteo, encolando offline:', err);
      await enqueueOfflineEvent({
        type: 'register-count',
        missionId: missionIdToUse,
        taskId: taskIdToUse,
        payload,
      });
    } finally {
      setIsSubmitting(false);

      if (discrepancy === 0) {
        showToastBanner(`Conteo exacto registrado (${countedQty} u)`, 'success');
      } else {
        showToastBanner(
          `Discrepancia detectada (${discrepancy > 0 ? `+${discrepancy}` : discrepancy} u). Pasó a Piso de Venta (150103)`,
          'warning',
          discrepancy
        );
      }

      clearActiveTask();
      setCountedInput('');
      setSalesInput('0');
      setSearchTerm('');
      setTimeout(() => {
        scannerInputRef.current?.focus();
      }, 50);
    }
  };

  return (
    <div className="space-y-4 max-w-4xl mx-auto w-full">
      <div className="bg-slate-800 border-2 border-slate-700 focus-within:border-blue-500 rounded-2xl p-3 sm:p-4 shadow-xl transition space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs sm:text-sm font-black text-slate-200 uppercase tracking-wider flex items-center gap-2">
            <Barcode className="w-5 h-5 text-blue-400" />
            <span>Escaneo Híbrido: Cámara Trasera & Entrada SKU</span>
          </label>
          <div className="flex items-center gap-2">
            {isOnline ? (
              <span className="flex items-center gap-1 text-emerald-400 text-[11px] font-semibold">
                <Wifi className="w-3.5 h-3.5" /> En línea
              </span>
            ) : (
              <span className="flex items-center gap-1 text-amber-400 text-[11px] font-semibold">
                <WifiOff className="w-3.5 h-3.5" /> Modo Offline
              </span>
            )}

            <button
              type="button"
              onClick={toggleCamera}
              disabled={isCameraStarting}
              className={`min-h-[38px] px-3 rounded-lg text-xs font-bold flex items-center gap-1.5 transition active:scale-95 ${
                isCameraActive
                  ? 'bg-rose-600 hover:bg-rose-500 text-white'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              {isCameraActive ? (
                <>
                  <CameraOff className="w-4 h-4" />
                  <span className="hidden sm:inline">Cerrar Cámara</span>
                </>
              ) : (
                <>
                  <Camera className="w-4 h-4" />
                  <span>{isCameraStarting ? 'Iniciando...' : 'Abrir Cámara'}</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div
          className={`relative overflow-hidden rounded-xl bg-black border-2 transition-all ${
            isCameraActive || isCameraStarting
              ? 'block border-[#009045] shadow-lg shadow-emerald-950/50'
              : 'hidden border-slate-700'
          }`}
        >
          <div
            id={VIEWPORT_ID}
            className="w-full max-h-[320px] mx-auto bg-black flex items-center justify-center min-h-[220px]"
          />

          {isCameraActive && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
              <div className="relative w-64 sm:w-72 h-36 sm:h-44 border-2 border-[#009045] rounded-xl shadow-[0_0_15px_rgba(0,144,69,0.5)]">
                <span className="absolute -top-1 -left-1 w-4 h-4 border-t-4 border-l-4 border-[#009045]" />
                <span className="absolute -top-1 -right-1 w-4 h-4 border-t-4 border-r-4 border-[#009045]" />
                <span className="absolute -bottom-1 -left-1 w-4 h-4 border-b-4 border-l-4 border-[#009045]" />
                <span className="absolute -bottom-1 -right-1 w-4 h-4 border-b-4 border-r-4 border-[#009045]" />

                <div className="w-full h-0.5 bg-[#009045] shadow-[0_0_8px_#009045] absolute top-1/2 -translate-y-1/2 animate-pulse" />

                <div className="absolute bottom-2 inset-x-0 text-center">
                  <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#009045] bg-black/70 px-2 py-0.5 rounded">
                    Centrar Código de Barras
                  </span>
                </div>
              </div>
            </div>
          )}

          {isCameraActive && (
            <div className="absolute top-2 right-2 flex items-center gap-1.5 z-10">
              <button
                type="button"
                onClick={toggleFlashTorch}
                title="Alternar Linterna / Flash"
                className={`p-2.5 rounded-xl font-bold text-xs backdrop-blur-md transition shadow-md ${
                  isTorchOn
                    ? 'bg-amber-400 text-slate-950 ring-2 ring-amber-300'
                    : 'bg-black/60 hover:bg-black/80 text-white'
                }`}
              >
                <Zap className={`w-4 h-4 ${isTorchOn ? 'fill-current' : ''}`} />
              </button>

              <button
                type="button"
                onClick={stopCameraScanner}
                title="Cerrar visor"
                className="p-2.5 rounded-xl bg-black/60 hover:bg-black/80 text-white backdrop-blur-md transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {isCameraActive && (
            <div className="bg-slate-900/90 py-1.5 px-3 text-center border-t border-slate-800">
              <p className="text-[11px] text-slate-300 flex items-center justify-center gap-1.5">
                <Scan className="w-3.5 h-3.5 text-[#009045]" />
                Enfoque el código de barras 1D (EAN/UPC) o QR. Se aplicará regla LPAD (6 dígitos).
              </p>
            </div>
          )}
        </div>

        {cameraError && (
          <div className="p-3 bg-rose-950/70 border border-rose-600 rounded-xl text-xs text-rose-200 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{cameraError}</span>
          </div>
        )}

        {totalSkus > 0 && (
          <div className="bg-slate-900/80 p-3 sm:p-4 rounded-xl border border-slate-700/80 shadow-inner space-y-2.5 my-3 animate-fadeIn">
            <div className="flex items-center justify-between">
              <span className="text-[11px] sm:text-xs font-black text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                Progreso del Conteo
              </span>
              <span className="text-xs sm:text-sm font-mono font-black text-emerald-400">
                {countedSkus} / {totalSkus} SKUs ({progressPct}%)
              </span>
            </div>

            <div className="w-full bg-slate-800 h-2 sm:h-2.5 rounded-full overflow-hidden">
              <div
                className="bg-gradient-to-r from-emerald-500 to-[#009045] h-full transition-all duration-500 rounded-full"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            <div className="grid grid-cols-4 gap-2 pt-1 text-center">
              <div className="bg-slate-950/60 p-2 rounded-lg border border-slate-800 flex flex-col justify-center">
                <span className="block text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-wider">Total</span>
                <span className="block text-base sm:text-lg font-mono font-black text-white">{totalSkus}</span>
              </div>
              <div className="bg-emerald-950/40 p-2 rounded-lg border border-emerald-800/40 flex flex-col justify-center">
                <span className="block text-[9px] sm:text-[10px] font-bold text-emerald-400 uppercase tracking-wider">Contados</span>
                <span className="block text-base sm:text-lg font-mono font-black text-emerald-300">{countedSkus}</span>
              </div>
              <div className="bg-amber-950/40 p-2 rounded-lg border border-amber-800/40 flex flex-col justify-center">
                <span className="block text-[9px] sm:text-[10px] font-bold text-amber-400 uppercase tracking-wider">Discrep.</span>
                <span className="block text-base sm:text-lg font-mono font-black text-amber-300">{discrepantSkus}</span>
              </div>
              <div className="bg-slate-950/60 p-2 rounded-lg border border-slate-800 flex flex-col justify-center">
                <span className="block text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-wider">Faltan</span>
                <span className="block text-base sm:text-lg font-mono font-black text-slate-200">{pendingSkus}</span>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleBarcodeSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-5 h-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={scannerInputRef}
              type="text"
              inputMode="text"
              autoComplete="off"
              autoFocus
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Escanear o ingresar SKU manual..."
              className="w-full h-14 pl-11 pr-10 bg-slate-900 border-2 border-slate-700 focus:border-[#009045] rounded-xl text-white font-mono text-lg font-bold placeholder:text-slate-500 focus:outline-hidden"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => {
                  setSearchTerm('');
                  scannerInputRef.current?.focus();
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          <button
            type="submit"
            className="btn-collector bg-[#009045] hover:bg-[#007a3a] text-white min-h-[56px] min-w-[56px] px-5 sm:px-6 rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-emerald-700/20 active:scale-95 transition"
          >
            <Search className="w-5 h-5" />
            <span className="hidden sm:inline">Buscar</span>
          </button>
        </form>

        {searchTerm && /^\d{1,5}$/.test(searchTerm.trim()) && (
          <p className="text-xs font-mono text-emerald-400 flex items-center gap-1.5 pl-1">
            <Zap className="w-3.5 h-3.5 text-emerald-400" />
            Normalización LPAD: <strong>"{searchTerm.trim()}"</strong> &rarr;{' '}
            <strong className="underline font-bold text-white">
              {applyLpadNormalization(searchTerm)}
            </strong>
          </p>
        )}
      </div>

      {activeTask ? (
        <div className="bg-slate-800/95 border-2 border-blue-500/80 rounded-2xl p-4 sm:p-6 shadow-2xl space-y-5 animate-fadeIn">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-4 border-b border-slate-700/80">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono font-black bg-blue-950 text-blue-300 px-3 py-1 rounded-lg border border-blue-800">
                  SKU: {activeTask.SkuCode || activeTask.skuCode}
                </span>
                <span className="text-xs font-semibold text-slate-400">
                  Depósito {activeTask.DepositCode || activeTask.depositCode || '150101'}
                </span>
                <span className="text-xs font-semibold text-slate-400">
                  Costo: ${Number(activeTask.Cost || activeTask.cost || 0).toFixed(2)}
                </span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-white mt-1.5 tracking-tight">
                {activeTask.SkuDescription || activeTask.skuDescription}
              </h2>

              {(activeTask.Barcodes || activeTask.barcodes) && (activeTask.Barcodes || activeTask.barcodes).length > 0 && (
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className="text-[11px] text-slate-400 font-semibold uppercase">EAN/UPC:</span>
                  {(activeTask.Barcodes || activeTask.barcodes).map((bc: string, idx: number) => (
                    <span
                      key={idx}
                      className="text-xs font-mono bg-slate-900 text-slate-300 px-2 py-0.5 rounded border border-slate-700"
                    >
                      {bc}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={clearActiveTask}
              className="self-start sm:self-auto p-2 bg-slate-700/60 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition"
            >
              <X className="w-4 h-4" />
              <span>Cerrar</span>
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2.5 sm:gap-3 bg-slate-950/80 p-3 sm:p-4 rounded-xl border border-slate-700/80 text-center">
            <div className="p-2 bg-slate-900/60 rounded-lg">
              <span className="text-[10px] sm:text-xs text-slate-400 uppercase font-black block tracking-wider">
                Sistema (S)
              </span>
              <span className="text-xl sm:text-2xl font-black text-white font-mono mt-1 block">
                {systemQty.toFixed(2)}
              </span>
              <span className="text-[10px] text-slate-500">Unidades base</span>
            </div>

            <div className="p-2 bg-slate-900/60 rounded-lg">
              <span className="text-[10px] sm:text-xs text-amber-400 uppercase font-black block tracking-wider">
                Ventas Hoy (V)
              </span>
              <span className="text-xl sm:text-2xl font-black text-amber-300 font-mono mt-1 block">
                {salesQty.toFixed(2)}
              </span>
              <span className="text-[10px] text-amber-500/80">Facturadas</span>
            </div>

            <div className="p-2 bg-slate-900/60 rounded-lg border border-blue-500/30">
              <span className="text-[10px] sm:text-xs text-blue-400 uppercase font-black block tracking-wider">
                Teórico (S - V)
              </span>
              <span className="text-xl sm:text-2xl font-black text-blue-300 font-mono mt-1 block">
                {adjustedTheoretical.toFixed(2)}
              </span>
              <span className="text-[10px] text-blue-400/70">Ajustado</span>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs sm:text-sm font-black text-slate-200 uppercase tracking-wider flex items-center justify-between">
              <span>CANTIDAD CONTADA FÍSICAMENTE (Qc)</span>
              <span className="text-xs text-emerald-400 font-bold">Campo obligatorio</span>
            </label>

            <div className="relative">
              <input
                ref={countInputRef}
                type="number"
                step="any"
                min="0"
                value={countedInput}
                onChange={(e) => setCountedInput(e.target.value)}
                placeholder="0.00"
                className="w-full h-20 sm:h-24 px-4 bg-slate-950 border-3 border-[#009045] focus:border-emerald-400 rounded-2xl text-white font-mono text-3xl sm:text-5xl font-black text-center shadow-inner focus:outline-hidden"
              />
            </div>

            <div className="grid grid-cols-6 gap-2 pt-1">
              <button
                type="button"
                onClick={() => adjustCount(1)}
                className="btn-collector bg-slate-700 hover:bg-slate-600 text-white min-h-[48px] rounded-xl font-black text-base active:scale-95"
              >
                +1
              </button>
              <button
                type="button"
                onClick={() => adjustCount(5)}
                className="btn-collector bg-slate-700 hover:bg-slate-600 text-white min-h-[48px] rounded-xl font-black text-base active:scale-95"
              >
                +5
              </button>
              <button
                type="button"
                onClick={() => adjustCount(10)}
                className="btn-collector bg-slate-700 hover:bg-slate-600 text-white min-h-[48px] rounded-xl font-black text-base active:scale-95"
              >
                +10
              </button>
              <button
                type="button"
                onClick={() => adjustCount(25)}
                className="btn-collector bg-slate-700 hover:bg-slate-600 text-white min-h-[48px] rounded-xl font-black text-base active:scale-95"
              >
                +25
              </button>
              <button
                type="button"
                onClick={() => adjustCount(-1)}
                className="btn-collector bg-slate-700 hover:bg-slate-600 text-white min-h-[48px] rounded-xl font-black text-base active:scale-95"
              >
                -1
              </button>
              <button
                type="button"
                onClick={() => setCountedInput('')}
                className="btn-collector bg-rose-950/80 hover:bg-rose-900 border border-rose-700 text-rose-300 min-h-[48px] rounded-xl font-bold text-xs active:scale-95"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-300 mb-1.5 flex items-center justify-between">
              <span>VENTAS REGISTRADAS DURANTE LA AUDITORÍA:</span>
              <span className="text-[11px] text-amber-400 font-normal">Resta al inventario del sistema</span>
            </label>
            <input
              type="number"
              step="any"
              min="0"
              value={salesInput}
              onChange={(e) => setSalesInput(e.target.value)}
              className="w-full h-12 px-4 bg-slate-900 border border-slate-700 rounded-xl text-amber-300 font-mono text-xl font-black text-center focus:outline-hidden focus:border-amber-500"
            />
          </div>

          {isCountValid && (
            <div
              className={`p-4 rounded-xl border-2 flex items-center justify-between transition ${
                isExactMatch
                  ? 'bg-emerald-950/70 border-emerald-500 text-emerald-200'
                  : 'bg-amber-950/70 border-amber-500 text-amber-200'
              }`}
            >
              <div className="flex items-center gap-2.5">
                {isExactMatch ? (
                  <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
                ) : (
                  <AlertTriangle className="w-6 h-6 text-amber-400 shrink-0" />
                )}
                <div>
                  <span className="text-xs uppercase font-bold tracking-wider block">
                    {isExactMatch ? 'Coincidencia Exacta' : 'Discrepancia Calculada'}
                  </span>
                  <span className="text-sm font-semibold">
                    {isExactMatch
                      ? 'El conteo físico coincide al 100% con el teórico ajustado.'
                      : liveDiscrepancy < 0
                      ? `Faltante de ${Math.abs(liveDiscrepancy).toFixed(2)} unidades en almacén.`
                      : `Sobrante de ${liveDiscrepancy.toFixed(2)} unidades en almacén.`}
                  </span>
                </div>
              </div>

              <div className="text-right pl-3 shrink-0">
                <span className="font-mono text-2xl font-black">
                  {liveDiscrepancy > 0 ? `+${liveDiscrepancy.toFixed(2)}` : liveDiscrepancy.toFixed(2)}
                </span>
                <span className="text-[10px] block uppercase font-bold text-slate-400">Diferencia</span>
              </div>
            </div>
          )}

          <button
            onClick={handleRegisterCount}
            disabled={!isCountValid || isSubmitting}
            className="w-full min-h-[58px] bg-[#009045] hover:bg-[#007a3a] disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98] text-white font-black text-lg sm:text-xl rounded-2xl shadow-xl shadow-emerald-900/40 flex items-center justify-center gap-3 transition touch-manipulation"
          >
            <CheckCircle2 className="w-6 h-6" />
            <span>{isSubmitting ? 'REGISTRANDO...' : 'REGISTRAR CONTEO'}</span>
          </button>
        </div>
      ) : (
        <div className="bg-slate-800/40 border-2 border-dashed border-slate-700 rounded-2xl p-8 sm:p-12 text-center text-slate-400 space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-emerald-600/10 border border-emerald-500/20 text-[#009045] flex items-center justify-center mx-auto">
            <Barcode className="w-9 h-9" />
          </div>
          <h3 className="text-lg font-bold text-slate-200">Listo para escanear en Almacén</h3>
          <p className="text-xs sm:text-sm text-slate-400 max-w-md mx-auto leading-relaxed">
            Active el visor de cámara para escanear con la retícula verde o apunte su colector industrial hacia el código de barras.
          </p>

          {tasks.length > 0 && (
            <div className="pt-4 border-t border-slate-800 text-left max-w-lg mx-auto">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                Últimos SKUs pendientes en la misión:
              </span>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto custom-scrollbar">
                {tasks
                  .filter((t) => t.CountedQuantity === null && t.countedQuantity === null && t.countedQuantity === undefined)
                  .slice(0, 8)
                  .map((t) => (
                    <button
                      key={t.TaskId || t.taskId}
                      onClick={() => processDetectedCode(t.SkuCode || t.skuCode || '', 'manual')}
                      className="text-xs font-mono bg-slate-900 hover:bg-emerald-900/40 border border-slate-700 hover:border-[#009045] text-slate-300 hover:text-white px-2.5 py-1.5 rounded-lg transition"
                    >
                      {t.SkuCode || t.skuCode}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-3.5 rounded-2xl shadow-2xl text-xs sm:text-sm font-bold flex items-center justify-between gap-3 max-w-md w-[92%] border backdrop-blur-md animate-slideUp ${
            toast.type === 'warning'
              ? 'bg-[#FEF3C7] text-amber-950 border-amber-400 shadow-amber-950/20'
              : toast.type === 'success'
              ? 'bg-emerald-950/95 border-emerald-500 text-emerald-200'
              : 'bg-rose-950/95 border-rose-500 text-rose-200'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
            {toast.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />}
            {toast.type === 'error' && <X className="w-5 h-5 text-rose-400 shrink-0" />}
            <span>{toast.text}</span>
          </div>

          {toast.discrepancyVal !== undefined && onNavigateToFloor && (
            <button
              onClick={onNavigateToFloor}
              className="underline text-[11px] font-black text-amber-900 hover:text-black shrink-0 ml-2 uppercase"
            >
              Ir a Piso &rarr;
            </button>
          )}
        </div>
      )}
    </div>
  );
};