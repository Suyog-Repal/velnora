import { getLocalDataSummary, deleteUserLocalData, type LocalDataSummary } from './localDataService.ts';
import type { IDatabase } from '../db/types.ts';

export type DeletionPhase = 'idle' | 'confirming' | 'deleting' | 'done' | 'error';

export interface DeletionDeps {
  database?: IDatabase;
  afterCommit?: (userId: string) => Promise<void>;
}

/**
 * Pure state machine behind the "Delete local data" UI (kept free of React so it is unit-testable).
 * Nothing is deleted until confirm() is called from the `confirming` phase; cancel() never touches data.
 */
export class LocalDataDeletionController {
  phase: DeletionPhase = 'idle';
  summary: LocalDataSummary | null = null;
  error: string | null = null;
  private userId: string;
  private deps: DeletionDeps;

  constructor(userId: string, deps: DeletionDeps = {}) {
    this.userId = userId;
    this.deps = deps;
  }

  async request(): Promise<void> {
    this.error = null;
    try {
      // Count failure must surface as an error, never as a reassuring "0 unsynchronized".
      this.summary = await getLocalDataSummary(this.userId, this.deps.database);
      this.phase = 'confirming';
    } catch (e) {
      this.phase = 'error';
      this.error = 'Could not read local data. Nothing was deleted.';
    }
  }

  cancel(): void {
    if (this.phase === 'deleting') return;
    this.phase = 'idle';
    this.error = null;
  }

  async confirm(): Promise<boolean> {
    if (this.phase !== 'confirming') return false;
    this.phase = 'deleting';
    try {
      await deleteUserLocalData(this.userId, this.deps.database, this.deps.afterCommit);
      this.phase = 'done';
      return true;
    } catch {
      this.phase = 'error';
      this.error = 'Deletion failed. Your data was left unchanged.';
      return false;
    }
  }
}
