import { TransactionRepository } from '../db/repositories/transactionRepository.ts';
import { canEditTransaction } from './transactionDetails.ts';
import type { IDatabase, Session } from '../db/types.ts';

/** File operations are injected so the logic is testable without a device (see receiptFiles.ts for the Expo implementation). */
export interface ReceiptFs {
  /** Copies the picked/captured image into app-private storage and returns the permanent local path. */
  importImage(sourceUri: string, transactionId: string): Promise<string>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface ReceiptUploader {
  /** Uploads to the authenticated backend; resolves with the server receipt id. Rejects on network/server failure. */
  upload(session: Session, transactionId: string, localPath: string): Promise<string>;
}

async function loadOwned(db: IDatabase, session: Session | null, transactionId: string) {
  const repo = new TransactionRepository(db);
  const tx = await repo.getById(transactionId);
  if (!tx || tx.deleted_at) throw new Error('Transaction not found.');
  if (!canEditTransaction(tx, session)) throw new Error('This transaction belongs to a different account.');
  return { repo, tx };
}

/**
 * Attach or replace the receipt of a transaction. Always local-first: the image lives in app-private storage and the
 * upload is only marked pending, so it works offline and for guests (guest uploads are never attempted: no session).
 */
export async function attachReceipt(db: IDatabase, fs: ReceiptFs, session: Session | null, transactionId: string, sourceUri: string): Promise<string> {
  const { repo, tx } = await loadOwned(db, session, transactionId);
  const newPath = await fs.importImage(sourceUri, transactionId);
  try {
    await repo.update(transactionId, {
      receipt_local_path: newPath,
      receipt_remote_id: null,
      receipt_upload_pending: session ? 1 : 0,
    });
  } catch (err) {
    await fs.remove(newPath).catch(() => undefined);
    throw err;
  }
  if (tx.receipt_local_path && tx.receipt_local_path !== newPath) await fs.remove(tx.receipt_local_path).catch(() => undefined);
  return newPath;
}

export async function removeReceipt(db: IDatabase, fs: ReceiptFs, session: Session | null, transactionId: string): Promise<void> {
  const { repo, tx } = await loadOwned(db, session, transactionId);
  await repo.update(transactionId, { receipt_local_path: null, receipt_remote_id: null, receipt_upload_pending: 0 });
  if (tx.receipt_local_path) await fs.remove(tx.receipt_local_path).catch(() => undefined);
}

/**
 * Uploads receipts for the signed-in user's transactions that the server already knows about.
 * Failures leave the flag set so the next sync retries. Guests/other accounts' receipts are never selected.
 */
export async function uploadPendingReceipts(db: IDatabase, fs: ReceiptFs, uploader: ReceiptUploader, session: Session): Promise<{ uploaded: number; failed: number }> {
  const rows = await db.getAllAsync<{ id: string; receipt_local_path: string }>(
    `SELECT id, receipt_local_path FROM transactions
     WHERE user_id = ? AND deleted_at IS NULL AND receipt_upload_pending = 1 AND receipt_local_path IS NOT NULL AND sync_status = 'synced'`,
    session.user.id);
  const repo = new TransactionRepository(db);
  let uploaded = 0; let failed = 0;
  for (const row of rows) {
    try {
      if (!(await fs.exists(row.receipt_local_path))) {
        await repo.update(row.id, { receipt_local_path: null, receipt_upload_pending: 0 });
        continue;
      }
      const remoteId = await uploader.upload(session, row.id, row.receipt_local_path);
      // Only after the backend confirmed persistence do we record the remote reference (this also queues the metadata sync).
      await repo.update(row.id, { receipt_remote_id: remoteId, receipt_upload_pending: 0 });
      uploaded += 1;
    } catch {
      failed += 1;
    }
  }
  return { uploaded, failed };
}

/**
 * Same account, same total, same calendar day and the same (normalized) merchant => probably the same receipt.
 * Used to warn before creating a second transaction from one bill. Never blocks: the user decides.
 */
export async function findPossibleDuplicate(
  db: IDatabase, scope: string | null, input: { amountPaise: number; isoDate: string; merchant: string },
): Promise<{ id: string; counterparty: string } | null> {
  const { normalizeMerchantKey } = await import('./merchantAliasService.ts');
  const d = new Date(input.isoDate);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
  const rows = await db.getAllAsync<{ id: string; counterparty: string }>(
    `SELECT id, counterparty FROM transactions WHERE deleted_at IS NULL AND amount_paise = ? AND transaction_date >= ? AND transaction_date < ?
       AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`, input.amountPaise, start, end, scope, scope);
  const key = normalizeMerchantKey(input.merchant);
  return rows.find((r) => normalizeMerchantKey(r.counterparty) === key) ?? null;
}
