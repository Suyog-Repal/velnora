export const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial normalized offline-first schema',
    up: `
      -- 1. Schema Migrations Table
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      -- 2. Metadata Key-Value Table
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 3. Categories Table
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT NOT NULL,
        transaction_type TEXT NOT NULL CHECK(transaction_type IN ('income', 'expense', 'both')),
        icon TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 4. Transactions Table
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        amount REAL NOT NULL CHECK(amount > 0),
        direction TEXT NOT NULL CHECK(direction IN ('income', 'expense')),
        counterparty TEXT NOT NULL,
        category_id TEXT,
        category TEXT NOT NULL,
        description TEXT DEFAULT '',
        transaction_date TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('manual', 'sms')),
        reference_id TEXT,
        fingerprint TEXT,
        sync_status TEXT NOT NULL CHECK(sync_status IN ('synced', 'pending_create', 'pending_update', 'pending_delete', 'failed')),
        server_version INTEGER DEFAULT 1,
        deleted_at TEXT DEFAULT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_sync ON transactions(sync_status);
      CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_fingerprint ON transactions(fingerprint);

      -- 5. Devices Table
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        user_id TEXT,
        device_name TEXT NOT NULL,
        last_sync_at TEXT,
        created_at TEXT NOT NULL
      );

      -- 6. Sync Queue Table
      CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('transaction', 'category', 'device')),
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete')),
        payload TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_retry_at TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sync_queue_retry ON sync_queue(next_retry_at, retry_count);
    `,
  },
  {
    version: 2,
    description: 'Monetary precision (integer paise) and sync queue uniqueness',
    up: `
      -- 1. Add amount_paise column to transactions table for exact integer precision
      ALTER TABLE transactions ADD COLUMN amount_paise INTEGER;

      -- 2. Backfill existing amounts as integer paise (1 INR = 100 paise)
      UPDATE transactions
      SET amount_paise = CAST(ROUND(amount * 100) AS INTEGER)
      WHERE amount_paise IS NULL;

      -- 3. Enforce strict uniqueness on sync_queue so each entity has at most one pending operation
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_queue_entity ON sync_queue(entity_type, entity_id);
    `,
  },
];

export const DEFAULT_CATEGORIES = [
  { id: 'cat-food', name: 'Food & Dining', transaction_type: 'expense' as const, icon: 'Utensils' },
  { id: 'cat-groceries', name: 'Groceries', transaction_type: 'expense' as const, icon: 'ShoppingBag' },
  { id: 'cat-transport', name: 'Transportation', transaction_type: 'expense' as const, icon: 'Car' },
  { id: 'cat-utilities', name: 'Bills & Utilities', transaction_type: 'expense' as const, icon: 'Receipt' },
  { id: 'cat-other-exp', name: 'Other Expenses', transaction_type: 'expense' as const, icon: 'MoreHorizontal' },
  { id: 'cat-salary', name: 'Salary', transaction_type: 'income' as const, icon: 'Briefcase' },
  { id: 'cat-other-inc', name: 'Other Income', transaction_type: 'income' as const, icon: 'TrendingUp' },
];
