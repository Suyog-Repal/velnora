import { DatabaseSync } from 'node:sqlite';
import type { IDatabase } from '../types';

export class NodeSqliteAdapter implements IDatabase {
  public db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
  }

  async execAsync(source: string): Promise<void> {
    this.db.exec(source);
  }

  async runAsync(source: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowId: number }> {
    const stmt = this.db.prepare(source);
    // Flatten params if passed as an array or rest
    const flattenedParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const result = stmt.run(...(flattenedParams as (string | number | bigint | null)[]));
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  }

  async getFirstAsync<T>(source: string, ...params: unknown[]): Promise<T | null> {
    const stmt = this.db.prepare(source);
    const flattenedParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const result = stmt.get(...(flattenedParams as (string | number | bigint | null)[]));
    return (result as T) ?? null;
  }

  async getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]> {
    const stmt = this.db.prepare(source);
    const flattenedParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const result = stmt.all(...(flattenedParams as (string | number | bigint | null)[]));
    return (result as T[]) ?? [];
  }

  close(): void {
    this.db.close();
  }
}
