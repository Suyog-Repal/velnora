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
  {
    version: 3,
    description: 'Transaction details (merchant phone, receipt, location), category colors/archive, merchant aliases, budgets',
    up: `
      ALTER TABLE transactions ADD COLUMN merchant_phone TEXT;
      ALTER TABLE transactions ADD COLUMN payment_method TEXT;
      ALTER TABLE transactions ADD COLUMN receipt_local_path TEXT;
      ALTER TABLE transactions ADD COLUMN receipt_remote_id TEXT;
      ALTER TABLE transactions ADD COLUMN receipt_upload_pending INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE transactions ADD COLUMN location_lat REAL;
      ALTER TABLE transactions ADD COLUMN location_lng REAL;
      ALTER TABLE transactions ADD COLUMN location_name TEXT;
      ALTER TABLE transactions ADD COLUMN location_address TEXT;
      ALTER TABLE transactions ADD COLUMN location_confirmed INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE categories ADD COLUMN color TEXT;
      ALTER TABLE categories ADD COLUMN archived_at TEXT;

      CREATE TABLE IF NOT EXISTS merchant_aliases (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        match_key TEXT NOT NULL,
        original_text TEXT NOT NULL,
        display_name TEXT NOT NULL,
        category TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending_create',
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_alias_user_key ON merchant_aliases(user_id, match_key) WHERE deleted_at IS NULL;

      CREATE TABLE IF NOT EXISTS budgets (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        category TEXT,
        amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
        sync_status TEXT NOT NULL DEFAULT 'pending_create',
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets(user_id);

      -- sync_queue CHECK constraint cannot be altered in place: copy -> drop -> rename (data preserved)
      CREATE TABLE sync_queue_v3 (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('transaction', 'category', 'device', 'budget', 'merchant_alias')),
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete')),
        payload TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_retry_at TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO sync_queue_v3 (id, entity_type, entity_id, operation, payload, retry_count, last_attempt_at, next_retry_at, error_code, created_at)
        SELECT id, entity_type, entity_id, operation, payload, retry_count, last_attempt_at, next_retry_at, error_code, created_at FROM sync_queue;
      DROP TABLE sync_queue;
      ALTER TABLE sync_queue_v3 RENAME TO sync_queue;
      CREATE INDEX IF NOT EXISTS idx_sync_queue_retry ON sync_queue(next_retry_at, retry_count);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_queue_entity ON sync_queue(entity_type, entity_id);
    `,
  },
  {
    version: 4,
    description: 'Custom-category ownership flag, more default categories with colors',
    up: `
      ALTER TABLE categories ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0;
      INSERT INTO categories (id, user_id, name, transaction_type, icon, color, created_at, updated_at) SELECT 'cat-shopping', NULL, 'Shopping', 'expense', 'ShoppingCart', '#8B5CF6', datetime('now'), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND lower(name) = lower('Shopping'));
      INSERT INTO categories (id, user_id, name, transaction_type, icon, color, created_at, updated_at) SELECT 'cat-health', NULL, 'Health', 'expense', 'HeartPulse', '#EF4444', datetime('now'), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND lower(name) = lower('Health'));
      INSERT INTO categories (id, user_id, name, transaction_type, icon, color, created_at, updated_at) SELECT 'cat-education', NULL, 'Education', 'expense', 'GraduationCap', '#3B82F6', datetime('now'), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND lower(name) = lower('Education'));
      INSERT INTO categories (id, user_id, name, transaction_type, icon, color, created_at, updated_at) SELECT 'cat-entertainment', NULL, 'Entertainment', 'expense', 'Film', '#EC4899', datetime('now'), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND lower(name) = lower('Entertainment'));
      INSERT INTO categories (id, user_id, name, transaction_type, icon, color, created_at, updated_at) SELECT 'cat-travel', NULL, 'Travel', 'expense', 'Plane', '#14B8A6', datetime('now'), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND lower(name) = lower('Travel'));
      INSERT INTO categories (id, user_id, name, transaction_type, icon, color, created_at, updated_at) SELECT 'cat-personal-care', NULL, 'Personal Care', 'expense', 'Sparkles', '#F59E0B', datetime('now'), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND lower(name) = lower('Personal Care'));
      INSERT INTO categories (id, user_id, name, transaction_type, icon, color, created_at, updated_at) SELECT 'cat-rent', NULL, 'Rent', 'expense', 'Home', '#6366F1', datetime('now'), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND lower(name) = lower('Rent'));
      INSERT INTO categories (id, user_id, name, transaction_type, icon, color, created_at, updated_at) SELECT 'cat-freelance', NULL, 'Freelance', 'income', 'Laptop', '#10B981', datetime('now'), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND lower(name) = lower('Freelance'));
      INSERT INTO categories (id, user_id, name, transaction_type, icon, color, created_at, updated_at) SELECT 'cat-business', NULL, 'Business', 'income', 'Store', '#059669', datetime('now'), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND lower(name) = lower('Business'));
      INSERT INTO categories (id, user_id, name, transaction_type, icon, color, created_at, updated_at) SELECT 'cat-investment', NULL, 'Investment', 'income', 'TrendingUp', '#0EA5E9', datetime('now'), datetime('now') WHERE NOT EXISTS (SELECT 1 FROM categories WHERE user_id IS NULL AND lower(name) = lower('Investment'));
      UPDATE categories SET color = '#F97316' WHERE id = 'cat-food' AND color IS NULL;
      UPDATE categories SET color = '#84CC16' WHERE id = 'cat-groceries' AND color IS NULL;
      UPDATE categories SET color = '#0EA5E9' WHERE id = 'cat-transport' AND color IS NULL;
      UPDATE categories SET color = '#64748B' WHERE id = 'cat-utilities' AND color IS NULL;
      UPDATE categories SET color = '#94A3B8' WHERE id = 'cat-other-exp' AND color IS NULL;
      UPDATE categories SET color = '#10B981' WHERE id = 'cat-salary' AND color IS NULL;
      UPDATE categories SET color = '#22C55E' WHERE id = 'cat-other-inc' AND color IS NULL;
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
