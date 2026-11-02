import type { IDatabase } from '../types.ts';

export class MetadataRepository {
  private db: IDatabase;

  constructor(db: IDatabase) {
    this.db = db;
  }

  async get(key: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      'SELECT value FROM app_metadata WHERE key = ?',
      key,
    );
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.runAsync(
      `INSERT INTO app_metadata (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      key,
      value,
      now,
    );
  }

  async delete(key: string): Promise<void> {
    await this.db.runAsync('DELETE FROM app_metadata WHERE key = ?', key);
  }
}
