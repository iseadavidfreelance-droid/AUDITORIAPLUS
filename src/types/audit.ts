/**
 * AUDITORIAPLUS+ - Definición de Tipos e Interfaces de Dominio
 * Estrictamente alineadas con el esquema PostgreSQL CQRS y Supabase Edge Functions.
 */

export type DepositCode = '150101' | '150103' | '150104' | '150102' | '150107';

export const DEPOSIT_NAMES: Record<DepositCode, string> = {
  '150101': 'Almacén Principal',
  '150103': 'Piso de Venta',
  '150104': 'Tránsito Virtual',
  '150102': 'Avería / Merma',
  '150107': 'Galpón Secundario',
};

export type TaskStatus = 'PENDING' | 'COMPLETED' | 'COMPLETED_MATCH' | 'DISCREPANT' | 'RECONCILED' | 'PARTIALLY_RECONCILED';

export type DiscrepancyStatus = 'OPEN' | 'RESOLVED' | 'PENDING_TARGET_COUNT' | 'COUNTED_VALIDATED' | 'PENDING_TRANSFER_APPROVAL';

export interface MissionMetrics {
  totalSkus: number;
  pendingSkus: number;
  countedSkus: number;
  discrepantSkus: number;
  reconciledSkus: number;
  totalCostDiscrepancy: number;
  missionId?: string;
  name?: string;
  depositCode?: DepositCode;
  status?: 'IN_PROGRESS' | 'COMPLETED' | 'CLOSED';
  createdAt?: string;
  updatedAt?: string;
}

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
  IsFichaComplete?: boolean;
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

export interface FloorDiscrepancy {
  DiscrepancyId: string;
  TaskId: string;
  MissionId: string;
  SkuCode: string;
  SkuDescription: string;
  Status: DiscrepancyStatus;
  ResolvedAt: string | null;
  OriginDeposit?: DepositCode | string;
  TargetDeposit?: DepositCode | string;
  OriginDiscrepancy?: number;
  TargetSystemQuantity?: number | null;
  TargetCountedQuantity?: number | null;
  TargetDiscrepancy?: number | null;
  CreatedAt?: string;
  UpdatedAt?: string;
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

export interface VirtualTransfer {
  TransferId: string;
  MissionId: string;
  TaskId: string;
  SkuCode: string;
  OriginDeposit: '150103';
  DestinationDeposit: '150104';
  TransferredQuantity: number;
  CreatedAt: string;
  SkuDescription?: string;
  FromDeposit?: DepositCode | string;
  ToDeposit?: DepositCode | string;
  TransferQuantity?: number;
  TransitDeposit?: DepositCode | string;
  Status?: 'SUGGESTED' | 'COMPLETED';
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

export interface EventStoreRecord<TPayload = Record<string, unknown>> {
  SequenceNum?: number;
  EventId: string;
  AggregateId: string;
  AggregateType: 'Mission' | 'SKU' | 'Inventory' | 'Transfer' | 'User' | 'CrossDiscrepancy' | 'VirtualTransfer';
  EventType:
    | 'MissionCreated'
    | 'TaskCountRegistered'
    | 'DiscrepancyDetected'
    | 'FloorCountRegistered'
    | 'VirtualTransferCreated'
    | 'VirtualTransferExecuted';
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

export interface RegisterCountPayload {
  mission_id: string;
  task_id: string;
  deposit_code: DepositCode | string;
  sku_code: string;
  counted_quantity: number;
  sales_during_audit: number;
}

export interface RegisterFloorCountPayload {
  discrepancy_id: string;
  mission_id: string;
  sku_code: string;
  floor_counted_qty: number;
  floor_system_qty: number;
  sales_during_audit?: number;
}

export function normalizeSku(input: string): string {
  const trimmed = input.trim();
  if (/^\d{1,5}$/.test(trimmed)) {
    return trimmed.padStart(6, '0');
  }
  return trimmed;
}