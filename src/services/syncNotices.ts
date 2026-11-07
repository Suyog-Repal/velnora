/**
 * Decides which toast to show for local saves and sync outcomes. Pure logic (the toast function is injected) so the
 * rules are unit-tested without React Native.
 *
 * Rules:
 *  - A local save is always confirmed immediately. Guests are told it is stored on the device (never "synced").
 *  - "Synced" is shown only after the backend confirmed (a sync that pushed something and reported no errors) AND only
 *    for a change this person just made, so background syncs stay quiet.
 *  - A failed sync shows "saved offline" once per pending change; the engine's own retries stay silent.
 */
export type ToastKind = 'success' | 'info' | 'warning';
export type ShowToast = (message: string, kind: ToastKind, key: string) => void;

export interface SyncSummaryLike { pushed: number; errors: string[] }

/** Engine messages that mean "nothing was attempted", not "the server failed". */
const BENIGN_ERRORS = new Set(['Sync already in progress', 'No active session']);

export type LocalSaveKind = 'income' | 'expense' | 'edit';

export function createSyncNotifier(show: ShowToast) {
  let awaiting = false;       // a signed-in change is waiting for server confirmation
  let offlineShown = false;   // the "saved offline" notice was already shown for the current pending change

  return {
    /** Call right after a transaction is written to SQLite. */
    localSave(kind: LocalSaveKind, signedIn: boolean): void {
      if (kind === 'edit') show(signedIn ? 'Changes saved' : 'Changes saved on this device', 'success', 'local-save');
      else if (signedIn) show(kind === 'income' ? 'Income recorded successfully' : 'Expense recorded successfully', 'success', 'local-save');
      else show(kind === 'income' ? 'Income saved on this device' : 'Expense saved on this device', 'success', 'local-save');
      if (signedIn) { awaiting = true; offlineShown = false; }
    },

    /** Call with every completed sync attempt. */
    syncResult(summary: SyncSummaryLike): void {
      if (!awaiting) return;
      const realErrors = summary.errors.filter((e) => !BENIGN_ERRORS.has(e));
      if (realErrors.length === 0) {
        if (summary.pushed > 0) { awaiting = false; offlineShown = false; show('Transaction synced successfully', 'success', 'synced'); }
        return; // nothing pushed yet (e.g. an overlapping sync) — keep waiting, say nothing
      }
      if (!offlineShown) { offlineShown = true; show('Transaction saved offline. Sync will retry.', 'warning', 'sync-offline'); }
    },

    /** Test/debug visibility. */
    get pending(): boolean { return awaiting; },
  };
}
