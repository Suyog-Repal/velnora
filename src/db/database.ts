import type { IDatabase } from './types.ts';
import { runMigrations } from './migrations.ts';

const DATABASE_NAME = 'velnora.db';

let dbInstance: IDatabase | null = null;
let initPromise: Promise<IDatabase> | null = null;

export async function getDatabase(): Promise<IDatabase> {
  if (dbInstance) {
    return dbInstance;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const SQLite = await import('expo-sqlite');
    const expoDb = await SQLite.openDatabaseAsync(DATABASE_NAME);

    // Apply performance and integrity PRAGMAs
    await expoDb.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);

    // Run sequential versioned migrations
    await runMigrations(expoDb);

    dbInstance = expoDb;
    return dbInstance;
  })();

  return initPromise;
}

export function setCustomDatabase(customDb: IDatabase | null): void {
  dbInstance = customDb;
  initPromise = customDb ? Promise.resolve(customDb) : null;
}

export async function resetDatabaseInstance(): Promise<void> {
  dbInstance = null;
  initPromise = null;
}
