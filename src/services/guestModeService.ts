import { AttachmentRepository } from '../db/repositories/attachmentRepository.ts';
import { getDatabase } from '../db/database.ts';
import { withWriteLock } from '../db/writeLock.ts';
import type { IDatabase } from '../db/types.ts';

/**
 * Guest mode = records with user_id IS NULL. They live only in local SQLite. They are never uploaded:
 * the sync engine only pushes rows whose owner equals the authenticated session user, and a NULL owner never does.
 * They become an account's data only through importGuestData(), which the UI calls after explicit user consent.
 */

export const GUEST_MODE_KEY = 'guest_mode_chosen';

export interface GuestDataSummary {
  /** Live (not deleted) guest transactions that could be imported. */
  transactionCount: number;
  budgetCount: number;
  categoryCount: number;
  expectedCount: number;
}

export interface GuestImportResult {
  imported: number;
  /** Guest rows left untouched because the account already has the same bank reference / fingerprint. */
  skippedDuplicates: number;
}

export async function isGuestModeChosen(database?: IDatabase): Promise<boolean> {
  const db = database ?? (await getDatabase());
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_metadata WHERE key = ?', GUEST_MODE_KEY);
  return row?.value === '1';
}

export async function setGuestModeChosen(chosen: boolean, database?: IDatabase): Promise<void> {
  const db = database ?? (await getDatabase());
  if (!chosen) {
    await db.runAsync('DELETE FROM app_metadata WHERE key = ?', GUEST_MODE_KEY);
    return;
  }
  await db.runAsync(
    `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    GUEST_MODE_KEY,
    new Date().toISOString(),
  );
}

export async function getGuestDataSummary(database?: IDatabase): Promise<GuestDataSummary> {
  const db = database ?? (await getDatabase());
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM transactions WHERE user_id IS NULL AND deleted_at IS NULL',
  );
  const b = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM budgets WHERE user_id IS NULL AND deleted_at IS NULL');
  const c = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM categories WHERE is_custom = 1 AND user_id IS NULL');
  const x = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM expected_payments WHERE user_id IS NULL AND deleted_at IS NULL');
  return { transactionCount: row?.count ?? 0, budgetCount: b?.count ?? 0, categoryCount: c?.count ?? 0, expectedCount: x?.count ?? 0 };
}

/**
 * Associates local guest transactions with `userId` and leaves them queued for the normal sync engine.
 * Call ONLY after the user has confirmed. Atomic: any failure rolls back and nothing changes.
 * Transaction ids are preserved (server-side idempotency); guest rows that duplicate an existing account
 * record (same reference id, or same fingerprint) are skipped and stay local.
 */
export async function importGuestData(userId: string, database?: IDatabase): Promise<GuestImportResult> {
  const id = userId?.trim();
  if (!id) throw new Error('A signed-in user is required to import local data');
  const db = database ?? (await getDatabase());

  return withWriteLock(async () => {
    const guestRows = await db.getAllAsync<{
      id: string; reference_id: string | null; fingerprint: string | null; sync_status: string;
    }>('SELECT id, reference_id, fingerprint, sync_status FROM transactions WHERE user_id IS NULL AND deleted_at IS NULL');

    await db.execAsync('BEGIN TRANSACTION');
    try {
      let imported = 0;
      let skipped = 0;
      const now = new Date().toISOString();
      for (const row of guestRows) {
        const dupRef = row.reference_id
          ? await db.getFirstAsync<{ id: string }>(
              'SELECT id FROM transactions WHERE user_id = ? AND deleted_at IS NULL AND reference_id = ?', id, row.reference_id)
          : null;
        const dupFp = !dupRef && row.fingerprint
          ? await db.getFirstAsync<{ id: string }>(
              'SELECT id FROM transactions WHERE user_id = ? AND deleted_at IS NULL AND fingerprint = ?', id, row.fingerprint)
          : null;
        if (dupRef || dupFp) {
          // The account already has this payment: the guest copy is not imported, but photos attached to it while in guest
          // mode move to the account's transaction (and are queued for upload by adoptForUser below), so none are lost.
          await db.runAsync(
            `UPDATE transaction_attachments SET transaction_id = ?, updated_at = ? WHERE transaction_id = ? AND user_id IS NULL AND deleted_at IS NULL`,
            (dupRef ?? dupFp)!.id, now, row.id,
          );
          skipped += 1;
          continue;
        }

        await db.runAsync(
          `UPDATE transactions SET user_id = ?, sync_status = 'pending_create', updated_at = ? WHERE id = ? AND user_id IS NULL`,
          id, now, row.id,
        );
        const updatedQueue = await db.runAsync(
          `UPDATE sync_queue SET payload = json_set(payload, '$.user_id', ?, '$.sync_status', 'pending_create')
           WHERE entity_type = 'transaction' AND entity_id = ?`,
          id, row.id,
        );
        if (updatedQueue.changes === 0) {
          // Guest row without a queue item (should not happen): enqueue so it still synchronizes.
          const tx = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM transactions WHERE id = ?', row.id);
          await db.runAsync(
            `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, created_at)
             VALUES (?, 'transaction', ?, 'create', ?, 0, ?)`,
            `import-${row.id}`, row.id, JSON.stringify(tx), now,
          );
        }
        imported += 1;
      }
      // Guest-created custom categories and budgets travel with the account (same consent as the transactions).
      const guestCats = await db.getAllAsync<{ id: string; name: string; transaction_type: string; icon: string | null; color: string | null }>(
        'SELECT id, name, transaction_type, icon, color FROM categories WHERE is_custom = 1 AND user_id IS NULL');
      for (const c of guestCats) {
        const clash = await db.getFirstAsync<{ id: string }>(
          `SELECT id FROM categories WHERE lower(name) = lower(?) AND transaction_type = ? AND (is_custom = 0 OR user_id = ?)`, c.name, c.transaction_type, id);
        if (clash) continue; // account already has an equivalent category; keep the guest one local
        await db.runAsync('UPDATE categories SET user_id = ?, updated_at = ? WHERE id = ?', id, now, c.id);
        await db.runAsync(
          `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, created_at)
           VALUES (?, 'category', ?, 'create', ?, 0, ?)
           ON CONFLICT(entity_type, entity_id) DO UPDATE SET payload = excluded.payload, operation = 'create'`,
          `import-cat-${c.id}`, c.id, JSON.stringify({ user_id: id, category: c.name, direction: c.transaction_type, icon: c.icon ?? 'tag', color: c.color ?? '#6366f1' }), now);
      }
      const guestBudgets = await db.getAllAsync<{ id: string; category: string | null; amount_paise: number }>(
        'SELECT id, category, amount_paise FROM budgets WHERE user_id IS NULL AND deleted_at IS NULL');
      for (const b of guestBudgets) {
        const clash = await db.getFirstAsync<{ id: string }>(
          `SELECT id FROM budgets WHERE user_id = ? AND deleted_at IS NULL AND ((category IS NULL AND ? IS NULL) OR category = ? COLLATE NOCASE)`, id, b.category, b.category);
        if (clash) continue;
        await db.runAsync(`UPDATE budgets SET user_id = ?, sync_status = 'pending_create', updated_at = ? WHERE id = ?`, id, now, b.id);
        await db.runAsync(
          `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, created_at)
           VALUES (?, 'budget', ?, 'create', ?, 0, ?)
           ON CONFLICT(entity_type, entity_id) DO UPDATE SET payload = excluded.payload, operation = 'create'`,
          `import-bud-${b.id}`, b.id, JSON.stringify({ user_id: id, category: b.category, amount_paise: b.amount_paise }), now);
      }
      const guestExpected = await db.getAllAsync<{ id: string; person: string; direction: string; amount_paise: number; paid_paise: number; note: string | null; due_date: string | null; status: string; settled_at: string | null; payments_json: string }>(
        'SELECT id, person, direction, amount_paise, paid_paise, note, due_date, status, settled_at, payments_json FROM expected_payments WHERE user_id IS NULL AND deleted_at IS NULL');
      for (const e of guestExpected) {
        await db.runAsync(`UPDATE expected_payments SET user_id = ?, sync_status = 'pending_create', updated_at = ? WHERE id = ?`, id, now, e.id);
        let payments: unknown = []; try { payments = JSON.parse(e.payments_json); } catch { /* history unreadable: import without it */ }
        await db.runAsync(
          `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, created_at)
           VALUES (?, 'expected_payment', ?, 'create', ?, 0, ?)
           ON CONFLICT(entity_type, entity_id) DO UPDATE SET payload = excluded.payload, operation = 'create'`,
          `import-exp-${e.id}`, e.id, JSON.stringify({ user_id: id, person: e.person, direction: e.direction, amount_paise: e.amount_paise, paid_paise: e.paid_paise, note: e.note, due_date: e.due_date, status: e.status, settled_at: e.settled_at, payments }), now);
      }
      // Photos and scans of the imported transactions now belong to the account too, and are queued for upload.
      await new AttachmentRepository(db).adoptForUser(id);
      await db.execAsync('COMMIT');
      return { imported, skippedDuplicates: skipped };
    } catch (err) {
      await db.execAsync('ROLLBACK');
      throw err;
    }
  });
}
