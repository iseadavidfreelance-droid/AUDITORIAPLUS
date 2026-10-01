/**
 * AUDITORIAPLUS+ - Motor de Persistencia Local Offline (IndexedDB)
 * Base de datos: AuditDB (Versión 1)
 * Diseñado para operación ininterrumpida en zonas sin cobertura Wi-Fi en galpones y almacenes.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { RegisterCountPayload, RegisterFloorCountPayload, MissionMetrics, MissionTask } from '../types/audit';

export type OfflineEventType = 'register-count' | 'register-floor-count';

export interface OfflineEventRecord<T = RegisterCountPayload | RegisterFloorCountPayload | Record<string, unknown>> {
  eventId: string;
  type: OfflineEventType;
  functionName: string; // Ej: 'register-count' o 'register-floor-count'
  missionId: string;
  taskId?: string;
  discrepancyId?: string;
  payload: T;
  timestamp_utc: string;
  retryCount: number;
  lastError?: string;
}

export interface CachedMissionData {
  missionId: string;
  metrics: MissionMetrics;
  tasks: MissionTask[];
  cachedAt: string;
  version: number;
}

export interface AuditDBSchema extends DBSchema {
  offline_events_queue: {
    key: string;
    value: OfflineEventRecord;
    indexes: {
      timestamp_utc: string;
    };
  };
  missions_cache: {
    key: string;
    value: CachedMissionData;
  };
}

export const DB_NAME = 'AuditDB';
export const DB_VERSION = 1;

let dbInstance: IDBPDatabase<AuditDBSchema> | null = null;
let dbPromise: Promise<IDBPDatabase<AuditDBSchema>> | null = null;

/**
 * Obtiene o inicializa la conexión con AuditDB
 */
export async function getAuditDB(): Promise<IDBPDatabase<AuditDBSchema>> {
  if (dbInstance) {
    return dbInstance;
  }

  if (!dbPromise) {
    dbPromise = openDB<AuditDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, _transaction) {
        // 1. Almacén: offline_events_queue
        if (!db.objectStoreNames.contains('offline_events_queue')) {
          const eventsStore = db.createObjectStore('offline_events_queue', {
            keyPath: 'eventId',
          });
          // Índice obligatorio por timestamp_utc para procesamiento FIFO estricto
          eventsStore.createIndex('timestamp_utc', 'timestamp_utc');
        }

        // 2. Almacén: missions_cache
        if (!db.objectStoreNames.contains('missions_cache')) {
          db.createObjectStore('missions_cache', {
            keyPath: 'missionId',
          });
        }
      },
      blocked() {
        console.warn('[AuditDB] Base de datos bloqueada por otra pestaña o versión anterior abierta.');
      },
      blocking() {
        if (dbInstance) {
          dbInstance.close();
          dbInstance = null;
          dbPromise = null;
        }
      },
      terminated() {
        dbInstance = null;
        dbPromise = null;
      },
    });
  }

  dbInstance = await dbPromise;
  return dbInstance;
}

/**
 * Encola un evento de conteo o reconciliación física cuando el colector está sin red
 */
export async function enqueueOfflineEvent<T = RegisterCountPayload | RegisterFloorCountPayload | Record<string, unknown>>(
  eventPayload: {
    type: OfflineEventType;
    missionId: string;
    taskId?: string;
    discrepancyId?: string;
    payload: T;
  }
): Promise<OfflineEventRecord<T>> {
  const db = await getAuditDB();
  const eventId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const record: OfflineEventRecord<T> = {
    eventId,
    type: eventPayload.type,
    functionName: eventPayload.type,
    missionId: eventPayload.missionId,
    taskId: eventPayload.taskId,
    discrepancyId: eventPayload.discrepancyId,
    payload: eventPayload.payload,
    timestamp_utc: new Date().toISOString(),
    retryCount: 0,
  };

  await db.put('offline_events_queue', record as unknown as OfflineEventRecord);
  return record;
}

/**
 * Obtiene todos los eventos de la cola ordenados cronológicamente por timestamp_utc (FIFO)
 */
export async function getOfflineQueue(): Promise<OfflineEventRecord[]> {
  const db = await getAuditDB();
  const index = db.transaction('offline_events_queue', 'readonly').store.index('timestamp_utc');
  const events = await index.getAll();
  
  // Garantizar orden ascendente estricto por timestamp
  return events.sort(
    (a, b) => new Date(a.timestamp_utc).getTime() - new Date(b.timestamp_utc).getTime()
  );
}

/**
 * Elimina un evento de la cola local tras confirmación de sincronización
 */
export async function removeOfflineEvent(eventId: string): Promise<void> {
  const db = await getAuditDB();
  await db.delete('offline_events_queue', eventId);
}

/**
 * Actualiza el contador de reintentos y error de un evento
 */
export async function updateOfflineEventRetry(eventId: string, errorMessage: string): Promise<void> {
  const db = await getAuditDB();
  const tx = db.transaction('offline_events_queue', 'readwrite');
  const event = await tx.store.get(eventId);
  if (event) {
    event.retryCount = (event.retryCount || 0) + 1;
    event.lastError = errorMessage;
    await tx.store.put(event);
  }
  await tx.done;
}

/**
 * Retorna la cantidad de eventos pendientes en la cola local
 */
export async function getOfflineQueueCount(): Promise<number> {
  try {
    const db = await getAuditDB();
    return await db.count('offline_events_queue');
  } catch (error) {
    console.error('[AuditDB] Error al contar eventos en cola:', error);
    return 0;
  }
}

/**
 * Guarda en caché local la misión y sus tareas para lectura instantánea sin conexión
 */
export async function cacheMissionData(
  missionId: string,
  data: {
    metrics: MissionMetrics;
    tasks: MissionTask[];
  }
): Promise<void> {
  const db = await getAuditDB();
  const cacheRecord: CachedMissionData = {
    missionId,
    metrics: data.metrics,
    tasks: data.tasks,
    cachedAt: new Date().toISOString(),
    version: 1,
  };
  await db.put('missions_cache', cacheRecord);
}

/**
 * Recupera la misión y tareas desde el almacenamiento local
 */
export async function getCachedMissionData(missionId: string): Promise<CachedMissionData | undefined> {
  const db = await getAuditDB();
  return await db.get('missions_cache', missionId);
}

/**
 * Limpia la caché local de misiones (opcional al cerrar misión)
 */
export async function clearMissionCache(missionId: string): Promise<void> {
  const db = await getAuditDB();
  await db.delete('missions_cache', missionId);
}
