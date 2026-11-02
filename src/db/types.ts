export type Direction = 'income' | 'expense';
export type TransactionSource = 'manual' | 'sms';
export type SyncStatus = 'synced' | 'pending_create' | 'pending_update' | 'pending_delete' | 'failed';
export type CategoryType = 'income' | 'expense' | 'both';
export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncEntityType = 'transaction' | 'category' | 'device';

export interface TransactionEntity {
  id: string; // Stable UUID v4
  user_id: string | null;
  amount: number; // In standard currency units (Rupees)
  amount_paise: number; // Exact integer minor currency units (Paise: 1 INR = 100 paise)
  direction: Direction;
  counterparty: string;
  category_id: string | null;
  category: string;
  description: string;
  transaction_date: string; // ISO 8601
  source: TransactionSource;
  reference_id: string | null;
  fingerprint: string | null;
  sync_status: SyncStatus;
  server_version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTransactionInput {
  id?: string;
  user_id?: string | null;
  amount: number;
  amount_paise?: number;
  direction: Direction;
  counterparty: string;
  category_id?: string | null;
  category: string;
  description?: string;
  transaction_date?: string;
  source?: TransactionSource;
  reference_id?: string | null;
  fingerprint?: string | null;
  sync_status?: SyncStatus;
}

export interface UpdateTransactionInput {
  amount?: number;
  direction?: Direction;
  counterparty?: string;
  category_id?: string | null;
  category?: string;
  description?: string;
  transaction_date?: string;
}

export interface CategoryEntity {
  id: string;
  user_id: string | null;
  name: string;
  transaction_type: CategoryType;
  icon: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceEntity {
  device_id: string;
  user_id: string | null;
  device_name: string;
  last_sync_at: string | null;
  created_at: string;
}

export interface SyncQueueEntity {
  id: string;
  entity_type: SyncEntityType;
  entity_id: string;
  operation: SyncOperation;
  payload: string; // JSON string
  retry_count: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  error_code: string | null;
  created_at: string;
}

export interface RemoteTransaction {
  id: string;
  user_id: string;
  amount: number | string;
  amount_paise: number;
  direction: Direction;
  counterparty: string;
  category: string;
  category_id?: string | null;
  description: string;
  transaction_date: string;
  source: TransactionSource;
  reference_id?: string | null;
  fingerprint?: string | null;
  server_version: number;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface IDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getFirstAsync<T>(source: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]>;
  withExclusiveTransactionAsync?(task: (txn: IDatabase) => Promise<void>): Promise<void>;
  withTransactionAsync?(task: () => Promise<void>): Promise<void>;
}

export type AuthUser = { id: string; full_name: string; email: string };
export type Session = { user: AuthUser; access_token: string; refresh_token: string; token_type: string };

