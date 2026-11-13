import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { AttachmentRepository } from '../../db/repositories/attachmentRepository.ts';
import {
  MAX_ATTACHMENTS, addAttachment, commitAttachmentChanges, ensureLocalFile, getAttachments, refreshRemoteAttachments,
  removeAttachment, syncDeletedAttachments, uploadPendingAttachments,
  type AttachmentApi, type AttachmentFs, type PutResult,
} from '../attachmentService.ts';
import type { AttachmentEntity, Session } from '../../db/types.ts';

const session: Session = { user: { id: 'u1', full_name: 'U', email: 'u@x.y' }, access_token: 'a1', refresh_token: 'r', token_type: 'bearer' };

function memFs(): AttachmentFs & { files: Set<string> } {
  const files = new Set<string>();
  return {
    files,
    async importImage(src, id) { if (src.includes('broken')) throw new Error('unreadable'); const path = `doc://attachments/${id}.jpg`; files.add(path); return { path, sizeBytes: 1234, mimeType: 'image/jpeg', fileName: `${id}.jpg` }; },
    async remove(p) { files.delete(p); },
    async exists(p) { return files.has(p); },
  };
}

/** In-memory server with the real API's semantics (idempotent PUT, tombstones, ownership). */
function fakeServer(fs: ReturnType<typeof memFs>) {
  const rows = new Map<string, { tx: string; deleted: boolean; type: 'photo' | 'scan'; page: number }>();
  const knownTx = new Set<string>();
  let mode: 'ok' | 'offline' | 'expired' | 'lose-response' = 'ok';
  let puts = 0;
  const api: AttachmentApi = {
    async put(s, a): Promise<PutResult> {
      puts++;
      if (mode === 'offline') return { kind: 'transient', reason: 'offline' };
      if (mode === 'expired' && s.access_token === 'a1') return { kind: 'unauthorized' };
      const ex = rows.get(a.id);
      if (ex) return ex.deleted ? { kind: 'deleted' } : { kind: 'stored' };
      if (!knownTx.has(a.transaction_id)) return { kind: 'not_found' };
      rows.set(a.id, { tx: a.transaction_id, deleted: false, type: a.attachment_type, page: a.page_index });
      if (mode === 'lose-response') return { kind: 'transient', reason: 'response lost' };
      return { kind: 'stored' };
    },
    async list(_s, txId) {
      const mine = [...rows.entries()].filter(([, r]) => r.tx === txId);
      return {
        attachments: mine.filter(([, r]) => !r.deleted).map(([id, r]) => ({ id, transaction_id: txId, attachment_type: r.type, page_index: r.page, content_type: 'image/jpeg', size_bytes: 9, width: 100, height: 200, created_at: new Date().toISOString() })),
        deleted_ids: mine.filter(([, r]) => r.deleted).map(([id]) => id),
      };
    },
    async remove(_s, id) { if (mode === 'offline') return 'transient'; const r = rows.get(id); if (r) r.deleted = true; return 'ok'; },
    async download(_s, a) { const p = `doc://attachments/${a.id}-dl.jpg`; fs.files.add(p); return p; },
  };
  return { api, rows, knownTx, setMode: (m: typeof mode) => { mode = m; }, get puts() { return puts; } };
}

async function setup() {
  const db = new NodeSqliteAdapter();
  await runMigrations(db);
  const txRepo = new TransactionRepository(db);
  const fs = memFs();
  const server = fakeServer(fs);
  const newTx = async (userId: string | null = 'u1') => txRepo.create({ user_id: userId, amount: 120, direction: 'expense', counterparty: 'Cafe', category: 'Food', source: 'manual', sync_status: userId ? 'pending_create' : 'synced' } as any);
  const markSynced = async (id: string) => { await txRepo.updateSyncStatus(id, 'synced'); server.knownTx.add(id); };
  return { db, txRepo, fs, server, newTx, markSynced, repo: new AttachmentRepository(db) };
}
const status = async (repo: AttachmentRepository, id: string) => (await repo.getById(id))?.upload_status;

// 1. Offline add of several photos and scans; nothing uploads until the server has the transaction; then each uploads once.
{
  const { db, fs, server, newTx, markSynced, repo } = await setup();
  const tx = await newTx();
  const a = await addAttachment(db, fs, session, tx.id, 'file:///cache/p1.jpg', 'photo', { width: 3000, height: 4000 });
  const b = await addAttachment(db, fs, session, tx.id, 'file:///cache/scan1.jpg', 'scan');
  const c = await addAttachment(db, fs, session, tx.id, 'file:///cache/scan2.jpg', 'scan');
  assert.deepEqual((await getAttachments(db, tx.id)).map((x) => [x.page_index, x.attachment_type]), [[0, 'photo'], [1, 'scan'], [2, 'scan']]);
  assert.equal(a.width, 3000); assert.equal(a.mime_type, 'image/jpeg'); assert.ok(fs.files.has(a.local_path!));
  assert.equal(await status(repo, a.id), 'pending');
  let r = await uploadPendingAttachments(db, fs, server.api, session);
  assert.equal(r.uploaded, 0); assert.equal(server.puts, 0, 'no upload before the transaction reached the server');
  await markSynced(tx.id);
  r = await uploadPendingAttachments(db, fs, server.api, session);
  assert.equal(r.uploaded, 3);
  for (const x of [a, b, c]) { assert.equal(await status(repo, x.id), 'synced'); assert.equal((await repo.getById(x.id))!.remote_id, x.id); }
  assert.equal(server.rows.size, 3);
  r = await uploadPendingAttachments(db, fs, server.api, session);
  assert.equal(r.uploaded, 0); assert.equal(server.puts, 3, 'synced attachments are never uploaded again');
  assert.ok(fs.files.has(a.local_path!), 'local file kept after upload for offline viewing');
  console.log('ok: offline add, gated upload, single upload per attachment');
}

// 2. Network failure keeps the file and retries later; a lost response is retried without a duplicate; restart recovery.
{
  const { db, fs, server, newTx, markSynced, repo } = await setup();
  const tx = await newTx(); await markSynced(tx.id);
  const a = await addAttachment(db, fs, session, tx.id, 'file:///cache/p.jpg', 'photo');
  server.setMode('offline');
  await uploadPendingAttachments(db, fs, server.api, session);
  const failed = (await repo.getById(a.id))!;
  assert.equal(failed.upload_status, 'failed'); assert.equal(failed.retry_count, 1); assert.ok(failed.next_retry_at);
  assert.ok(fs.files.has(a.local_path!), 'a failed upload never deletes the local file');
  await uploadPendingAttachments(db, fs, server.api, session);
  assert.equal((await repo.getById(a.id))!.retry_count, 1, 'backoff respected: not retried before next_retry_at');
  server.setMode('lose-response');
  await db.runAsync('UPDATE transaction_attachments SET next_retry_at = NULL');
  await uploadPendingAttachments(db, fs, server.api, session);
  assert.equal(server.rows.size, 1); assert.equal(await status(repo, a.id), 'failed');
  server.setMode('ok');
  await db.runAsync('UPDATE transaction_attachments SET next_retry_at = NULL');
  await uploadPendingAttachments(db, fs, server.api, session);
  assert.equal(await status(repo, a.id), 'synced'); assert.equal(server.rows.size, 1, 'retry after a lost response is not a duplicate');
  // Killed mid-upload: status left 'uploading'. The next pass resends it.
  const b = await addAttachment(db, fs, session, tx.id, 'file:///cache/q.jpg', 'photo');
  await repo.setStatus(b.id, 'uploading');
  await uploadPendingAttachments(db, fs, server.api, session);
  assert.equal(await status(repo, b.id), 'synced');
  console.log('ok: retry with backoff, no duplicate after lost response, restart recovery');
}

// 3. Expired token: refreshed once, upload continues with the new token.
{
  const { db, fs, server, newTx, markSynced, repo } = await setup();
  const tx = await newTx(); await markSynced(tx.id);
  const a = await addAttachment(db, fs, session, tx.id, 'file:///cache/p.jpg', 'photo');
  server.setMode('expired');
  let refreshes = 0;
  const r = await uploadPendingAttachments(db, fs, server.api, session, async (s) => { refreshes++; return { ...s, access_token: 'a2' }; });
  assert.equal(refreshes, 1); assert.equal(r.uploaded, 1); assert.equal(await status(repo, a.id), 'synced');
  console.log('ok: token refresh during upload');
}

// 4. Removal: never-uploaded -> gone at once; uploaded -> tombstone until the server confirms; only chosen items removed.
{
  const { db, fs, server, newTx, markSynced, repo } = await setup();
  const tx = await newTx(); await markSynced(tx.id);
  const keep = await addAttachment(db, fs, session, tx.id, 'file:///cache/k.jpg', 'photo');
  const up = await addAttachment(db, fs, session, tx.id, 'file:///cache/u.jpg', 'scan');
  await uploadPendingAttachments(db, fs, server.api, session);
  const local = await addAttachment(db, fs, session, tx.id, 'file:///cache/l.jpg', 'photo');
  await removeAttachment(db, fs, session, local.id);
  assert.equal(await repo.getById(local.id), null); assert.ok(!fs.files.has(local.local_path!));
  await removeAttachment(db, fs, session, up.id);
  const tomb = (await repo.getById(up.id))!;
  assert.ok(tomb.deleted_at); assert.equal(tomb.local_path, null);
  assert.deepEqual((await getAttachments(db, tx.id)).map((x) => x.id), [keep.id], 'unchanged attachment preserved');
  server.setMode('offline');
  assert.equal(await syncDeletedAttachments(db, server.api, session), 0);
  assert.ok(await repo.getById(up.id), 'tombstone kept while the server has not confirmed');
  server.setMode('ok');
  assert.equal(await syncDeletedAttachments(db, server.api, session), 1);
  assert.equal(await repo.getById(up.id), null); assert.equal(server.rows.get(up.id)!.deleted, true);
  assert.equal(server.rows.get(keep.id)!.deleted, false);
  console.log('ok: removal tombstones and deletion sync');
}

// 5. Form commit: add new, remove chosen, keep the rest; a broken image does not lose the others; limit enforced.
{
  const { db, fs, newTx } = await setup();
  const tx = await newTx();
  const first = await addAttachment(db, fs, session, tx.id, 'file:///cache/1.jpg', 'photo');
  const second = await addAttachment(db, fs, session, tx.id, 'file:///cache/2.jpg', 'photo');
  const res = await commitAttachmentChanges(db, fs, session, tx.id, {
    removedIds: [second.id],
    added: [
      { key: 'n1', source: 'new', type: 'scan', uri: 'file:///cache/s1.jpg' },
      { key: 'n2', source: 'new', type: 'photo', uri: 'file:///cache/broken.jpg' },
      { key: 'n3', source: 'new', type: 'photo', uri: 'file:///cache/3.jpg' },
    ],
  });
  assert.deepEqual(res, { added: 2, removed: 1, failed: 1 });
  const now = await getAttachments(db, tx.id);
  assert.deepEqual(now.map((x) => x.attachment_type), ['photo', 'scan', 'photo']);
  assert.equal(now[0].id, first.id);
  for (let i = now.length; i < MAX_ATTACHMENTS; i++) await addAttachment(db, fs, session, tx.id, `file:///cache/x${i}.jpg`, 'photo');
  await assert.rejects(addAttachment(db, fs, session, tx.id, 'file:///cache/over.jpg', 'photo'), /at most 10/);
  console.log('ok: form commit semantics and limit');
}

// 6. Other device: remote attachments appear, download once into permanent storage; remote deletion is honoured.
{
  const { db, fs, server, newTx, markSynced, repo } = await setup();
  const tx = await newTx(); await markSynced(tx.id);
  server.rows.set('11111111-1111-4111-8111-111111111111', { tx: tx.id, deleted: false, type: 'scan', page: 0 });
  server.rows.set('22222222-2222-4222-8222-222222222222', { tx: tx.id, deleted: false, type: 'photo', page: 1 });
  assert.equal(await refreshRemoteAttachments(db, fs, server.api, session, tx.id), true);
  const listed = await getAttachments(db, tx.id);
  assert.equal(listed.length, 2); assert.equal(listed[0].local_path, null); assert.equal(listed[0].upload_status, 'synced');
  const path = await ensureLocalFile(db, fs, server.api, session, listed[0].id);
  assert.ok(path && fs.files.has(path)); assert.equal((await repo.getById(listed[0].id))!.local_path, path);
  assert.equal(await ensureLocalFile(db, fs, server.api, session, listed[0].id), path, 'second view is offline (no new download)');
  assert.equal(await refreshRemoteAttachments(db, fs, server.api, session, tx.id), false, 'idempotent');
  server.rows.get('22222222-2222-4222-8222-222222222222')!.deleted = true;
  await refreshRemoteAttachments(db, fs, server.api, session, tx.id);
  assert.deepEqual((await getAttachments(db, tx.id)).map((x) => x.id), ['11111111-1111-4111-8111-111111111111']);
  assert.equal(await uploadPendingAttachments(db, fs, server.api, session).then((r) => r.uploaded), 0, 'downloaded attachments are not re-uploaded');
  console.log('ok: cross-device listing, download, remote deletion');
}

// 7. Guests: stored locally, never uploaded; another account cannot attach to someone else's transaction.
{
  const { db, fs, server, newTx, repo } = await setup();
  const guestTx = await newTx(null);
  const g = await addAttachment(db, fs, null, guestTx.id, 'file:///cache/g.jpg', 'photo');
  assert.equal(g.upload_status, 'local'); assert.equal(g.user_id, null);
  await uploadPendingAttachments(db, fs, server.api, session);
  assert.equal(server.puts, 0);
  const owned = await newTx('u1');
  const other: Session = { ...session, user: { ...session.user, id: 'u2' } };
  await assert.rejects(addAttachment(db, fs, other, owned.id, 'file:///cache/z.jpg', 'photo'), /different account/);
  assert.equal(await repo.countActive(owned.id), 0);
  console.log('ok: guest attachments stay local; ownership enforced');
}

// 8. Missing file (storage cleared): marked failed, not retried forever, no crash.
{
  const { db, fs, server, newTx, markSynced, repo } = await setup();
  const tx = await newTx(); await markSynced(tx.id);
  const a = await addAttachment(db, fs, session, tx.id, 'file:///cache/p.jpg', 'photo');
  fs.files.clear();
  await uploadPendingAttachments(db, fs, server.api, session);
  const row = (await repo.getById(a.id)) as AttachmentEntity;
  assert.equal(row.upload_status, 'failed'); assert.equal(row.last_error, 'FILE_MISSING'); assert.equal(server.puts, 0);
  console.log('ok: missing local file handled');
}
