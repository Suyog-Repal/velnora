import type { IDatabase } from './types.ts';
import { MIGRATIONS, DEFAULT_CATEGORIES } from './schema.ts';

export async function runMigrations(db: IDatabase): Promise<number> {
  // 1. Ensure migrations tracking table exists
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  // 2. Fetch applied migrations
  const appliedRows = await db.getAllAsync<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version ASC',
  );
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  let newlyApplied = 0;

  // 3. Apply pending migrations sequentially
  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      // Atomic: a failed migration must never leave a half-migrated schema or lose queued sync items.
      await db.execAsync('BEGIN TRANSACTION');
      try {
        await db.execAsync(migration.up);
        await db.execAsync('COMMIT');
      } catch (err) {
        await db.execAsync('ROLLBACK');
        throw err;
      }

      // Seed initial data if version 1
      if (migration.version === 1) {
        const now = new Date().toISOString();
        for (const cat of DEFAULT_CATEGORIES) {
          await db.runAsync(
            `INSERT OR IGNORE INTO categories (id, user_id, name, transaction_type, icon, created_at, updated_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?)`,
            cat.id,
            cat.name,
            cat.transaction_type,
            cat.icon,
            now,
            now,
          );
        }
      }

      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        migration.version,
        new Date().toISOString(),
      );
      newlyApplied += 1;
    }
  }

  return newlyApplied;
}

export async function getCurrentSchemaVersion(db: IDatabase): Promise<number> {
  try {
    const row = await db.getFirstAsync<{ version: number }>(
      'SELECT MAX(version) as version FROM schema_migrations',
    );
    return row?.version ?? 0;
  } catch {
    return 0;
  }
}
