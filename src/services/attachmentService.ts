/**
 * Transaction attachments (photos and scanned document pages), local-first.
 *
 * - Files live in app-private persistent storage (documentDirectory/attachments), metadata in SQLite
 *   (transaction_attachments). No image data is ever stored in the transaction row or its sync payload.
 * - The attachment id is generated on the device and used as the server id, so an upload retried after a lost response is
 *   idempotent (the server answers "already stored") and can never create a duplicate.
 * - Uploads run after every sync cycle of the existing engine (see App.tsx post-sync hook); there is no second engine.
 *   An attachment uploads only once the server knows its transaction. A failed upload never changes the transaction.
 * - Deleting keeps a tombstone until the server confirmed the deletion. A local file is only removed when the person
 *   removed the attachment or the server says it was deleted; never because an upload failed.
 *
 * Native pieces (files, HTTP) come in through ports, so all of this is tested in Node (see __tests__/attachments.test.ts).
 */
import { AttachmentRepository } from '../db/repositories/attachmentRepository.ts';
import { TransactionRepository } from '../db/repositories/transactionRepository.ts';
import { generateUUID } from '../db/repositories/syncQueueRepository.ts';
import { canEditTransaction } from './transactionDetails.ts';
import type { AttachmentEntity, AttachmentType, AttachmentUploadStatus, IDatabase, Session } from '../db/types.ts';

/** Maximum attachments per transaction (matches the server's limit). */
export const MAX_ATTACHMENTS = 10;
const PERMANENT = '9999-12-31T23:59:59Z';
const MAX_BACKOFF_MS = 15 * 60_000;

export interface ImportedFile { path: string; sizeBytes: number | null; mimeType: string; fileName: string }

export interface AttachmentFs {
  /** Copies a picked/captured/scanned image into permanent app-private storage. */
  importImage(sourceUri: string, attachmentId: string): Promise<ImportedFile>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface RemoteAttachment {
  id: string; transaction_id: string; attachment_type: AttachmentType; page_index: number; content_type: string;
  size_bytes: number; width: number | null; height: number | null; created_at: string;
}

export type PutResult =
  | { kind: 'stored' } // 201 or 200 (already stored: idempotent retry)
  | { kind: 'deleted' } // 410: it was deleted (on another device); must not be re-created
  | { kind: 'not_found' } // 404: the server does not know the transaction (yet)
  | { kind: 'rejected'; status: number } // 413 / 415 / 422: this file will never be accepted
  | { kind: 'unauthorized' }
  | { kind: 'transient'; reason: string }; // offline, timeout, 5xx

export interface AttachmentApi {
  put(session: Session, attachment: AttachmentEntity): Promise<PutResult>;
  list(session: Session, transactionId: string): Promise<{ attachments: RemoteAttachment[]; deleted_ids: string[] }>;
  remove(session: Session, attachmentId: string): Promise<'ok' | 'unauthorized' | 'transient'>;
  /** Downloads into permanent app-private storage and returns the local path. */
  download(session: Session, attachment: AttachmentEntity): Promise<string>;
}

/** One item shown in the attachment area of the Add / Edit Transaction form. */
export interface DraftAttachment {
  key: string;
  /** saved = already stored for this transaction; new = picked in this form, not saved yet; legacy = old single receipt. */
  source: 'saved' | 'new' | 'legacy';
  type: AttachmentType;
  /** What to display (local file uri). NULL while a cloud-only attachment is still downloading. */
  uri: string | null;
  width?: number | null;
  height?: number | null;
  attachmentId?: string;
  uploadStatus?: AttachmentUploadStatus;
}

export interface AttachmentChanges {
  added: DraftAttachment[];
  removedIds: string[];
  removeLegacy?: boolean;
}

async function ownedTransaction(db: IDatabase, session: Session | null, transactionId: string) {
  const tx = await new TransactionRepository(db).getById(transactionId);
  if (!tx || tx.deleted_at) throw new Error('Transaction not found.');
  if (!canEditTransaction(tx, session)) throw new Error('This transaction belongs to a different account.');
  return tx;
}

/** Active attachments of a transaction, in page order. */
export async function getAttachments(db: IDatabase, transactionId: string): Promise<AttachmentEntity[]> {
  return new AttachmentRepository(db).getByTransaction(transactionId);
}

/** Converts stored attachments to form items. */
export function toDraft(a: AttachmentEntity): DraftAttachment {
  return { key: a.id, source: 'saved', type: a.attachment_type, uri: a.local_path, width: a.width, height: a.height, attachmentId: a.id, uploadStatus: a.upload_status };
}

/**
 * Stores one image for a transaction. Local first: works offline and for guests (guest attachments are never uploaded).
 */
export async function addAttachment(
  db: IDatabase, fs: AttachmentFs, session: Session | null, transactionId: string, sourceUri: string,
  attachmentType: AttachmentType, meta: { width?: number | null; height?: number | null; pageIndex?: number } = {},
): Promise<AttachmentEntity> {
  const tx = await ownedTransaction(db, session, transactionId);
  const repo = new AttachmentRepository(db);
  const existing = await repo.getByTransaction(transactionId);
  if (existing.length >= MAX_ATTACHMENTS) throw new Error(`A transaction can have at most ${MAX_ATTACHMENTS} attachments.`);
  const pageIndex = meta.pageIndex ?? (existing.length ? Math.max(...existing.map((a) => a.page_index)) + 1 : 0);
  const id = generateUUID();
  const file = await fs.importImage(sourceUri, id);
  try {
    return await repo.create({
      id, transaction_id: transactionId, user_id: tx.user_id ?? null, local_path: file.path, remote_id: null,
      upload_status: tx.user_id ? 'pending' : 'local', attachment_type: attachmentType, page_index: pageIndex, deleted_at: null,
      file_name: file.fileName, mime_type: file.mimeType, size_bytes: file.sizeBytes,
      width: meta.width ?? null, height: meta.height ?? null,
    });
  } catch (err) {
    await fs.remove(file.path).catch(() => undefined); // no orphaned file when the row could not be written
    throw err;
  }
}

/**
 * Removes one attachment the person chose to remove. If the server has (or may have) it, a tombstone stays until the
 * server confirmed the deletion; an attachment that never left the device is removed outright.
 */
export async function removeAttachment(db: IDatabase, fs: AttachmentFs, session: Session | null, attachmentId: string): Promise<void> {
  const repo = new AttachmentRepository(db);
  const a = await repo.getById(attachmentId);
  if (!a || a.deleted_at) return;
  await ownedTransaction(db, session, a.transaction_id);
  const mayBeOnServer = !!a.remote_id || a.upload_status === 'uploading' || a.upload_status === 'failed' || a.retry_count > 0;
  if (mayBeOnServer && a.user_id) {
    await repo.update(a.id, { remote_id: a.id }); // the server id is the client id: a DELETE of an unknown id is a no-op
    await repo.softDelete(a.id);
  } else {
    await repo.hardDelete(a.id);
  }
  if (a.local_path) await fs.remove(a.local_path).catch(() => undefined);
}

/** Removes every attachment of a transaction that is being deleted. */
export async function removeAttachmentsForTransaction(db: IDatabase, fs: AttachmentFs, session: Session | null, transactionId: string): Promise<void> {
  for (const a of await getAttachments(db, transactionId)) await removeAttachment(db, fs, session, a.id).catch(() => undefined);
}

/**
 * Applies the attachment changes made in the Add / Edit Transaction form, after the transaction itself was saved.
 * Only attachments the person explicitly removed are removed; everything else is kept as it was.
 * Each item is applied on its own, so one unreadable image never loses the others.
 */
export async function commitAttachmentChanges(
  db: IDatabase, fs: AttachmentFs, session: Session | null, transactionId: string, changes: AttachmentChanges,
  legacy?: { remove: () => Promise<void> },
): Promise<{ added: number; removed: number; failed: number }> {
  let added = 0; let removed = 0; let failed = 0;
  for (const id of changes.removedIds) {
    try { await removeAttachment(db, fs, session, id); removed += 1; } catch { failed += 1; }
  }
  if (changes.removeLegacy && legacy) {
    try { await legacy.remove(); removed += 1; } catch { failed += 1; }
  }
  for (const item of changes.added) {
    if (!item.uri) { failed += 1; continue; }
    try {
      await addAttachment(db, fs, session, transactionId, item.uri, item.type, { width: item.width, height: item.height });
      added += 1;
    } catch { failed += 1; }
  }
  return { added, removed, failed };
}

let uploadPass: Promise<{ uploaded: number; failed: number }> | null = null;

/**
 * Uploads this account's pending attachments. Runs after each sync cycle. Only one pass runs at a time (a concurrent
 * call waits for the running pass), so the same attachment is never uploaded twice at once.
 */
export function uploadPendingAttachments(
  db: IDatabase, fs: AttachmentFs, api: AttachmentApi, session: Session,
  refresh?: (stale: Session) => Promise<Session | null>,
): Promise<{ uploaded: number; failed: number }> {
  if (uploadPass) return uploadPass;
  uploadPass = runUploadPass(db, fs, api, session, refresh).finally(() => { uploadPass = null; });
  return uploadPass;
}

async function runUploadPass(
  db: IDatabase, fs: AttachmentFs, api: AttachmentApi, initial: Session, refresh?: (stale: Session) => Promise<Session | null>,
): Promise<{ uploaded: number; failed: number }> {
  const repo = new AttachmentRepository(db);
  let session = initial;
  const userId = session.user.id;
  await repo.resetStaleUploads(userId); // interrupted by an app restart / crash: safe to resend (idempotent by id)
  let uploaded = 0; let failed = 0; let refreshed = false;
  for (let round = 0; round < 20; round++) {
    const batch = await repo.getUploadable(userId, new Date().toISOString());
    if (!batch.length) break;
    let progressed = false;
    for (const a of batch) {
      if (!a.local_path || !(await fs.exists(a.local_path))) {
        // The file is gone (storage cleared): nothing can be uploaded. Keep the row visible as failed; never retried blindly.
        await repo.setStatus(a.id, 'failed', { last_error: 'FILE_MISSING', next_retry_at: PERMANENT });
        failed += 1; continue;
      }
      await repo.setStatus(a.id, 'uploading');
      let result: PutResult;
      try { result = await api.put(session, a); } catch (e) { result = { kind: 'transient', reason: e instanceof Error ? e.message : 'error' }; }
      if (result.kind === 'unauthorized' && refresh && !refreshed) {
        refreshed = true;
        const next = await refresh(session).catch(() => null);
        if (next && next.user.id === userId) {
          session = next;
          try { result = await api.put(session, a); } catch (e) { result = { kind: 'transient', reason: e instanceof Error ? e.message : 'error' }; }
        }
      }
      switch (result.kind) {
        case 'stored':
          // remote_id is recorded even if the person removed it meanwhile: the tombstone then deletes it on the server.
          await repo.setStatus(a.id, 'synced', { remote_id: a.id, retry_count: 0, next_retry_at: null, last_error: null });
          uploaded += 1; progressed = true; break;
        case 'deleted': {
          // Deleted on another device: honour it here too.
          const current = await repo.getById(a.id);
          if (current?.local_path) await fs.remove(current.local_path).catch(() => undefined);
          await repo.hardDelete(a.id);
          progressed = true; break;
        }
        case 'rejected':
          await repo.setStatus(a.id, 'failed', { last_error: `REJECTED_${result.status}`, next_retry_at: PERMANENT, retry_count: a.retry_count + 1 });
          failed += 1; break;
        case 'unauthorized':
          await repo.setStatus(a.id, 'pending');
          return { uploaded, failed }; // session ended: the next sign-in / sync retries
        case 'not_found':
        case 'transient': {
          const backoff = Math.min(MAX_BACKOFF_MS, 2 ** Math.min(a.retry_count, 20) * 2000);
          await repo.setStatus(a.id, 'failed', {
            retry_count: a.retry_count + 1, next_retry_at: new Date(Date.now() + backoff).toISOString(),
            last_error: result.kind === 'not_found' ? 'TRANSACTION_NOT_ON_SERVER' : 'NETWORK',
          });
          failed += 1;
          if (result.kind === 'transient') return { uploaded, failed }; // offline: stop this pass, retry later
          break;
        }
      }
    }
    if (!progressed) break;
  }
  return { uploaded, failed };
}

/** Tells the server about removed attachments; a tombstone is purged only after the server confirmed. */
export async function syncDeletedAttachments(db: IDatabase, api: AttachmentApi, session: Session): Promise<number> {
  const repo = new AttachmentRepository(db);
  let done = 0;
  for (const a of await repo.getPendingDeletions(session.user.id)) {
    const r = await api.remove(session, a.remote_id ?? a.id).catch(() => 'transient' as const);
    if (r === 'ok') { await repo.hardDelete(a.id); done += 1; }
    else break; // offline / signed out: try again after the next sync
  }
  return done;
}

/**
 * Brings the device's view of one transaction's attachments up to date with the server (attachments added or deleted on
 * another device). Files are not downloaded here; see ensureLocalFile.
 */
export async function refreshRemoteAttachments(db: IDatabase, fs: AttachmentFs, api: AttachmentApi, session: Session, transactionId: string): Promise<boolean> {
  const tx = await new TransactionRepository(db).getById(transactionId);
  if (!tx || tx.user_id !== session.user.id) return false;
  const repo = new AttachmentRepository(db);
  const remote = await api.list(session, transactionId);
  let changed = false;
  for (const r of remote.attachments) {
    if (await repo.getById(r.id)) continue; // includes local tombstones: a pending local deletion wins
    await repo.create({
      id: r.id, transaction_id: transactionId, user_id: session.user.id, local_path: null, remote_id: r.id, upload_status: 'synced',
      attachment_type: r.attachment_type === 'scan' ? 'scan' : 'photo', page_index: r.page_index, deleted_at: null,
      file_name: null, mime_type: r.content_type, size_bytes: r.size_bytes, width: r.width, height: r.height, created_at: r.created_at,
    });
    changed = true;
  }
  for (const id of remote.deleted_ids) {
    const local = await repo.getById(id);
    if (!local || local.deleted_at || local.upload_status !== 'synced') continue;
    if (local.local_path) await fs.remove(local.local_path).catch(() => undefined);
    await repo.hardDelete(id);
    changed = true;
  }
  return changed;
}

/** Local file of an attachment, downloading a cloud-only one into permanent storage the first time (then offline-ready). */
export async function ensureLocalFile(db: IDatabase, fs: AttachmentFs, api: AttachmentApi, session: Session | null, attachmentId: string): Promise<string | null> {
  const repo = new AttachmentRepository(db);
  const a = await repo.getById(attachmentId);
  if (!a || a.deleted_at) return null;
  if (a.local_path && (await fs.exists(a.local_path))) return a.local_path;
  if (!a.remote_id || !session || a.user_id !== session.user.id) return null;
  const path = await api.download(session, a);
  await repo.update(a.id, { local_path: path });
  return path;
}

/** Human label of an attachment's cloud state, for the small badge on each thumbnail. */
export function uploadStatusLabel(status: AttachmentUploadStatus | undefined, signedIn: boolean): string | null {
  if (!status || !signedIn) return null;
  switch (status) {
    case 'local': return 'On this device';
    case 'pending': return 'Waiting to upload';
    case 'uploading': return 'Uploading';
    case 'synced': return 'Backed up';
    case 'failed': return 'Upload failed, will retry';
  }
}
