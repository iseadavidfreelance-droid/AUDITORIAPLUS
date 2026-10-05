/**
 * AUDITORIAPLUS+ - Definición de Tipos e Interfaces de Dominio
 * Estrictamente alineadas con el esquema PostgreSQL CQRS y Supabase Edge Functions.
 */

/**
 * Códigos de Depósitos Oficiales:
 * - 150101: Almacén Principal (Reserva)
 * - 150103: Piso de Venta (Exhibición / Venta al público)
 * - 150104: Tránsito Virtual (Intermediario de compensación)
 * - 150102: Avería (Merma / Dañados)
 * - 150107: Galpón (Almacenamiento masivo)
 */
export type DepositCode = '150101' | '150103' | '150104' | '150102' | '150107';

export const DEPOSIT_NAMES: Record<DepositCode, string> = {
  '150101': 'Almacén Principal',
  '150103': 'Piso de Venta',
  '150104': 'Tránsito Virtual',
  '150102': 'Avería / Merma',
  '150107': 'Galpón Secundario',
};

/**
 * Estados de la tarea de auditoría física:
 * - PENDING: Pendiente de conteo
 * - COMPLETED: Conteo registrado (alias COMPLETED_MATCH sin discrepancia)
 * - COMPLETED_MATCH: Conteo coincide exactamente con el inventario teórico ajustado
 * - DISCREPANT: Presenta faltante o sobrante no nulo
 * - RECONCILED: Reconciliado mediante compensación en Piso de Venta y traslado virtual
 */
export type TaskStatus = 'PENDING' | 'COMPLETED' | 'COMPLETED_MATCH' | 'DISCREPANT' | 'RECONCILED';

/**
 * Estados de la discrepancia detectada en Almacén:
 * - OPEN: Abierta, requiere verificación
 * - PENDING_FLOOR_COUNT: Esperando conteo en Piso de Venta (150103)
 * - COUNTED_VALIDATED: Conteo en piso efectuado y validado
 * - RESOLVED: Resuelta y compensada mediante traslado virtual
 */
export type DiscrepancyStatus = 'OPEN' | 'RESOLVED' | 'PENDING_FLOOR_COUNT' | 'COUNTED_VALIDATED' | 'PENDING_TARGET_COUNT';

/**
 * Métricas acumuladas y financieras de la misión de auditoría
 */
export interface MissionMetrics {
  totalSkus: number;
  pendingSkus: number;
  countedSkus: number;
  discrepantSkus: number;
  reconciledSkus: number;
  totalCostDiscrepancy: number;
  // Campos complementarios de la misión
  missionId?: string;
  name?: string;
  depositCode?: DepositCode;
  status?: 'IN_PROGRESS' | 'COMPLETED' | 'CLOSED';
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Tarea individual de conteo asignada a la misión (Read_Mission_Tasks)
 */
export interface MissionTask {
  TaskId: string;
  MissionId: string;
  DepositCode: string;
  SkuCode: string;
  SkuDescription: string;
  Barcodes: string[];
  Cost: number;
  SystemQuantity: number;
  CountedQuantity: number | null;
  SalesDuringAudit: number;
  Discrepancy: number;
  Status: TaskStatus;
  CreatedAt: string;
  UpdatedAt: string;

  // Propiedades opcionales para compatibilidad y proyecciones
  IsFichaComplete?: boolean;
  
  // Aliases en camelCase para interoperabilidad con Zustand stores
  taskId?: string;
  missionId?: string;
  depositCode?: DepositCode | string;
  skuCode?: string;
  skuDescription?: string;
  barcodes?: string[];
  cost?: number;
  systemQuantity?: number;
  countedQuantity?: number | null;
  salesDuringAudit?: number;
  discrepancy?: number | null;
  status?: TaskStatus;
  isFichaComplete?: boolean;
}

/**
 * Registro de discrepancia bidireccional (Read_Floor_Discrepancies renombrada lógicamente)
 */
export interface FloorDiscrepancy {
  DiscrepancyId: string;
  TaskId: string;
  MissionId: string;
  SkuCode: string;
  SkuDescription: string;
  Status: DiscrepancyStatus;
  ResolvedAt: string | null;

  // Campos adicionales del Read Model CQRS (Agnósticos)[cite: 19]
  OriginDeposit?: DepositCode | string;
  TargetDeposit?: DepositCode | string;
  OriginDiscrepancy?: number;
  TargetSystemQuantity?: number | null;
  TargetCountedQuantity?: number | null;
  TargetDiscrepancy?: number | null;
  CreatedAt?: string;
  UpdatedAt?: string;

  // Aliases en camelCase para interoperabilidad en Zustand[cite: 18]
  discrepancyId?: string;
  taskId?: string;
  missionId?: string;
  skuCode?: string;
  skuDescription?: string;
  originDeposit?: DepositCode | string;
  targetDeposit?: DepositCode | string;
  originDiscrepancy?: number;
  targetSystemQuantity?: number | null;
  targetCountedQuantity?: number | null;
  targetDiscrepancy?: number | null;
  status?: DiscrepancyStatus;
  resolvedAt?: string | null;
}

/**
 * Traslado Virtual sugerido o ejecutado hacia el depósito de tránsito (Read_Virtual_Transfers)
 */
export interface VirtualTransfer {
  TransferId: string;
  MissionId: string;
  TaskId: string;
  SkuCode: string;
  OriginDeposit: '150103';
  DestinationDeposit: '150104';
  TransferredQuantity: number;
  CreatedAt: string;

  // Campos del Read Model CQRS
  SkuDescription?: string;
  FromDeposit?: DepositCode | string;
  ToDeposit?: DepositCode | string;
  TransferQuantity?: number;
  TransitDeposit?: DepositCode | string;
  Status?: 'SUGGESTED' | 'CONFIRMED' | 'EXECUTED' | 'RECOMMENDED';

  // Aliases en camelCase
  transferId?: string;
  missionId?: string;
  taskId?: string;
  skuCode?: string;
  skuDescription?: string;
  originDeposit?: '150103';
  destinationDeposit?: '150104';
  transferredQuantity?: number;
  createdAt?: string;
}

/**
 * Modelo de evento inmutable para Write Model (EventStore)
 */
export interface EventStoreRecord<TPayload = Record<string, unknown>> {
  SequenceNum?: number;
  EventId: string;
  AggregateId: string;
  AggregateType: 'Mission' | 'SKU' | 'Inventory' | 'Transfer' | 'User' | 'CrossDiscrepancy';
  EventType:
    | 'MissionCreated'
    | 'TaskCountRegistered'
    | 'DiscrepancyDetected'
    | 'FloorCountRegistered'
    | 'VirtualTransferCreated';
  Version: number;
  Payload: TPayload;
  Metadata: {
    deviceId?: string;
    appVersion: string;
    userAgent?: string;
    ip?: string;
    offlineSync?: boolean;
    queuedAt?: string;
  };
  Timestamp: string;
  UserId: string;
  CorrelationId: string;
  CausationId?: string | null;
}

/**
 * Payload para registro de conteo en Almacén o Piso
 * Ecuación: Discrepancia = CountedQuantity - (SystemQuantity - SalesDuringAudit)
 */
export interface RegisterCountPayload {
  mission_id: string;
  task_id: string;
  deposit_code: DepositCode | string;
  sku_code: string;
  counted_quantity: number;
  sales_during_audit: number;
}

/**
 * Payload para registro de conteo en Destino
 */
export interface RegisterFloorCountPayload {
  discrepancy_id: string;
  mission_id: string;
  sku_code: string;
  floor_counted_qty: number;
  floor_system_qty: number;
  sales_during_audit?: number;
}

/**
 * Normalizador de SKU según regla LPAD a 6 dígitos
 * Ej: '42419' -> '042419'
 */
export function normalizeSku(input: string): string {
  const trimmed = input.trim();
  if (/^\d{1,5}$/.test(trimmed)) {
    return trimmed.padStart(6, '0');
  }
  return trimmed;
}