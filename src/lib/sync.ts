/**
 * AUDITORIAPLUS+ - Sincronizador Automático de Cola Offline
 * Procesa y transmite los eventos encolados en IndexedDB hacia Supabase y Edge Functions.
 */

import { supabase, isSupabaseConfigured } from './supabase';
import {
  getOfflineQueue,
  removeOfflineEvent,
  updateOfflineEventRetry,
  getOfflineQueueCount,
  OfflineEventRecord,
} from './db';
import { RegisterCountPayload, RegisterFloorCountPayload } from '../types/audit';

export interface SyncProgress {
  total: number;
  processed: number;
  failed: number;
  remaining: number;
}

export type SyncListener = (progress: SyncProgress, isSyncing: boolean) => void;

let isSyncRunning = false;
const listeners = new Set<SyncListener>();

function notifyListeners(progress: SyncProgress, syncing: boolean) {
  listeners.forEach((listener) => {
    try {
      listener(progress, syncing);
    } catch (err) {
      console.error('[SyncManager] Error en callback de oyente:', err);
    }
  });
}

/**
 * Registra un oyente para observar el progreso de sincronización
 */
export function subscribeToSync(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Indica si el sincronizador está actualmente despachando la cola
 */
export function isSyncing(): boolean {
  return isSyncRunning;
}

/**
 * Envía un evento a la Edge Function de Supabase correspondiente
 */
async function dispatchEventToBackend(event: OfflineEventRecord): Promise<{ success: boolean; isConflictOrDone: boolean; error?: string }> {
  const targetFunction = event.type === 'register-floor-count' ? 'register-floor-count' : 'register-count';

  try {
    // 1. Invocación a Supabase Edge Function
    const { data, error } = await supabase.functions.invoke(targetFunction, {
      body: event.payload as Record<string, unknown>,
    });

    if (!error) {
      return { success: true, isConflictOrDone: false };
    }

    // Comprobar si fue conflicto 409 (ya procesado previamente en backend / duplicado idempotente)
    const errorStatus = (error as { status?: number }).status;
    if (errorStatus === 409) {
      console.info(`[SyncManager] Evento ${event.eventId} ya había sido procesado en el servidor (409 Conflict). Removiendo de cola.`);
      return { success: true, isConflictOrDone: true };
    }

    // 2. Si la Edge Function retorna 404 o no está desplegada en el proyecto de Supabase,
    // intentamos persistencia directa en el Read Model de Supabase para no perder el dato
    if (errorStatus === 404 || error.message?.includes('Failed to send a request to the Edge Function')) {
      console.warn(`[SyncManager] Edge Function ${targetFunction} no desplegada (404). Realizando actualización directa en PostgreSQL...`);
      
      if (event.type === 'register-count') {
        const payload = event.payload as RegisterCountPayload;
        const systemQty = 0; // Se actualiza el conteo físico
        const { error: dbErr } = await supabase
          .from('Read_Mission_Tasks')
          .update({
            CountedQuantity: payload.counted_quantity,
            SalesDuringAudit: payload.sales_during_audit,
            UpdatedAt: new Date().toISOString(),
          })
          .eq('TaskId', payload.task_id);

        if (!dbErr) {
          return { success: true, isConflictOrDone: false };
        }
      } else if (event.type === 'register-floor-count') {
        const payload = event.payload as RegisterFloorCountPayload;
        const { error: dbErr } = await supabase
          .from('Read_Floor_Discrepancies')
          .update({
            FloorCountedQuantity: payload.floor_counted_qty,
            Status: 'RESOLVED',
            UpdatedAt: new Date().toISOString(),
          })
          .eq('DiscrepancyId', payload.discrepancy_id);

        if (!dbErr) {
          return { success: true, isConflictOrDone: false };
        }
      }
    }

    return {
      success: false,
      isConflictOrDone: false,
      error: error.message || `HTTP Error ${errorStatus}`,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      isConflictOrDone: false,
      error: errorMsg,
    };
  }
}

/**
 * Procesa secuencialmente todos los eventos de offline_events_queue ordenados por timestamp_utc.
 * REGLA ESTRICTA: Si la petición falla por caída de red, detiene el procesamiento inmediatamente
 * y preserva intacta la cola para no romper la causalidad temporal.
 */
export async function processOfflineQueue(): Promise<{
  processed: number;
  failed: number;
  remaining: number;
}> {
  // Evitar ejecuciones concurrentes
  if (isSyncRunning) {
    console.info('[SyncManager] Sincronización en curso. Omitiendo invocación duplicada.');
    const count = await getOfflineQueueCount();
    return { processed: 0, failed: 0, remaining: count };
  }

  // Verificar si hay conexión
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    console.info('[SyncManager] Sin conexión a internet (navigator.onLine = false). Sincronización pospuesta.');
    const count = await getOfflineQueueCount();
    return { processed: 0, failed: 0, remaining: count };
  }

  // Verificar configuración de Supabase
  if (!isSupabaseConfigured) {
    console.warn('[SyncManager] Supabase no está configurado. Configure VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY para transmitir la cola.');
    const count = await getOfflineQueueCount();
    return { processed: 0, failed: 0, remaining: count };
  }

  isSyncRunning = true;

  try {
    const events = await getOfflineQueue();
    const total = events.length;

    if (total === 0) {
      isSyncRunning = false;
      notifyListeners({ total: 0, processed: 0, failed: 0, remaining: 0 }, false);
      return { processed: 0, failed: 0, remaining: 0 };
    }

    console.info(`[SyncManager] Iniciando despacho de ${total} eventos offline ordenados por timestamp UTC...`);
    notifyListeners({ total, processed: 0, failed: 0, remaining: total }, true);

    let processed = 0;
    let failed = 0;

    for (const event of events) {
      // Re-verificar si la conexión se cayó en medio del loop
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        console.warn('[SyncManager] Se perdió la conexión durante el proceso de sincronización. Pausando cola.');
        break;
      }

      const result = await dispatchEventToBackend(event);

      if (result.success) {
        // HTTP 200, 201 o 409 procesado: eliminar de la cola local
        await removeOfflineEvent(event.eventId);
        processed++;
        const remaining = total - processed - failed;
        notifyListeners({ total, processed, failed, remaining }, true);
        console.info(`[SyncManager] Evento ${event.eventId} (${event.type}) sincronizado exitosamente.`);
      } else {
        // Fallo en la transmisión
        console.error(`[SyncManager] Fallo al sincronizar evento ${event.eventId}: ${result.error}`);
        await updateOfflineEventRetry(event.eventId, result.error || 'Error desconocido');
        failed++;

        // Si fue un error de red (TypeError: Failed to fetch, NetworkError, etc.),
        // detenemos el bucle inmediatamente para mantener intacta la cola
        const isNetworkFailure =
          result.error?.toLowerCase().includes('failed to fetch') ||
          result.error?.toLowerCase().includes('network') ||
          result.error?.toLowerCase().includes('connection') ||
          (typeof navigator !== 'undefined' && !navigator.onLine);

        if (isNetworkFailure) {
          console.warn('[SyncManager] Falla de red confirmada. Interrumpiendo ciclo para preservar orden cronológico.');
          break;
        }
      }
    }

    const remaining = await getOfflineQueueCount();
    notifyListeners({ total, processed, failed, remaining }, false);

    console.info(`[SyncManager] Ciclo finalizado. Procesados: ${processed}, Fallidos: ${failed}, Restantes en cola: ${remaining}`);
    return { processed, failed, remaining };
  } catch (error) {
    console.error('[SyncManager] Excepción no controlada durante processOfflineQueue:', error);
    const count = await getOfflineQueueCount();
    return { processed: 0, failed: 1, remaining: count };
  } finally {
    isSyncRunning = false;
  }
}

/**
 * Inicializador de oyentes globales del navegador
 */
export function initOfflineSync(): void {
  if (typeof window === 'undefined') return;

  // Escuchador de recuperación de red
  window.addEventListener('online', () => {
    console.info('[SyncManager] Evento window.online detectado. Ejecutando processOfflineQueue()...');
    processOfflineQueue().catch((err) => {
      console.error('[SyncManager] Error al ejecutar auto-sync en online:', err);
    });
  });

  // Si ya estamos online al cargar la aplicación, intentar vaciar cualquier evento previo
  if (navigator.onLine) {
    setTimeout(() => {
      processOfflineQueue().catch(console.error);
    }, 2000);
  }
}
