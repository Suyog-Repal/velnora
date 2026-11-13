export type Direction = 'income' | 'expense';
export type TransactionSource = 'manual' | 'sms';
/** Where an auto-detected bank event was observed. One transaction may be seen by several. */
export type DetectionSource = 'sms' | 'truecaller_notification' | 'payment_notification' | 'csv_import';
/** What the money movement was. Decides how it counts: see ledgerRules. */
export type TransactionKind = 'payment' | 'refund' | 'reversal' | 'transfer' | 'cash_withdrawal';
export type VerificationStatus = 'detected' | 'needs_review' | 'verified' | 'reconciled';
export type CaptureSource = 'manual' | 'sms' | 'notification' | 'csv_import';
export type SyncStatus = 'synced' | 'pending_create' | 'pending_update' | 'pending_delete' | 'failed';
export type CategoryType = 'income' | 'expense' | 'both';
export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncEntityType = 'transaction' | 'category' | 'device' | 'budget' | 'merchant_alias' | 'expected_payment';

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
  merchant_phone?: string | null; // E.164, optional, user-entered only
  payment_method?: string | null;
  receipt_local_path?: string | null; // app-private file; never synced as a path
  receipt_remote_id?: string | null;
  receipt_upload_pending?: number;
  location_lat?: number | null;
  location_lng?: number | null;
  location_name?: string | null;
  location_address?: string | null;
  location_confirmed?: number;
  txn_kind?: TransactionKind;
  verification_status?: VerificationStatus;
  capture_source?: CaptureSource | null;
  account_last4?: string | null;
  bank_name?: string | null;
  payment_app?: string | null;
  /** Set while this row may be the same payment as another one; such rows are left out of totals until resolved. */
  possible_duplicate_of?: string | null;
  confidence?: number | null;
  /** Detection channels that saw this transaction (debug/UI only; loaded by list queries, not a column). */
  detected_via?: DetectionSource[];
}

/** Ledger fields shared by create and update inputs and the server record. */
export interface LedgerFields {
  txn_kind?: TransactionKind;
  verification_status?: VerificationStatus;
  capture_source?: CaptureSource | null;
  account_last4?: string | null;
  bank_name?: string | null;
  payment_app?: string | null;
  possible_duplicate_of?: string | null;
  confidence?: number | null;
}

export interface CreateTransactionInput extends LedgerFields {
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
  merchant_phone?: string | null;
  payment_method?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  location_name?: string | null;
  location_address?: string | null;
  location_confirmed?: number;
}

export interface UpdateTransactionInput extends LedgerFields {
  amount?: number;
  direction?: Direction;
  counterparty?: string;
  category_id?: string | null;
  category?: string;
  description?: string;
  transaction_date?: string;
  merchant_phone?: string | null;
  payment_method?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  location_name?: string | null;
  location_address?: string | null;
  location_confirmed?: number;
  receipt_local_path?: string | null;
  receipt_remote_id?: string | null;
  receipt_upload_pending?: number;
}

export interface CategoryEntity {
  id: string;
  user_id: string | null;
  name: string;
  transaction_type: CategoryType;
  icon: string | null;
  color?: string | null;
  archived_at?: string | null;
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

export interface RemoteTransaction extends LedgerFields {
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
  merchant_phone?: string | null;
  payment_method?: string | null;
  receipt_remote_id?: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  location_name?: string | null;
  location_address?: string | null;
  location_confirmed?: boolean | number;
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

export type AttachmentType = 'photo' | 'scan';
export type AttachmentUploadStatus = 'local' | 'pending' | 'uploading' | 'synced' | 'failed';

export interface AttachmentEntity {
  id: string;
  transaction_id: string;
  user_id: string | null;
  /** App-private file (documentDirectory). NULL when it only exists in the cloud and has not been downloaded yet. */
  local_path: string | null;
  /** Cloud reference, set only after the server confirmed it stored the file (same value as id). */
  remote_id: string | null;
  upload_status: AttachmentUploadStatus;
  attachment_type: AttachmentType;
  page_index: number;
  created_at: string;
  updated_at: string;
  /** Tombstone: set when the person removed it; the row stays until the server confirmed the deletion. */
  deleted_at: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  retry_count: number;
  next_retry_at: string | null;
  last_error: string | null;
}

