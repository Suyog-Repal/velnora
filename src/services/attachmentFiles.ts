/**
 * Expo implementations of the attachment ports: permanent app-private files and the authenticated attachments API.
 * Files go to documentDirectory/attachments/ (survives restarts and is not cleared by the OS like the cache).
 */
import * as FileSystem from 'expo-file-system/legacy';
import type { AttachmentEntity, Session } from '../db/types.ts';
import type { AttachmentApi, AttachmentFs, PutResult, RemoteAttachment } from './attachmentService.ts';

const DIR = `${FileSystem.documentDirectory ?? ''}attachments/`;
const UPLOAD_TIMEOUT_MS = 120_000;

const extFor = (mime: string) => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg');
function mimeFromUri(uri: string): string | null {
  const m = /\.(jpe?g|png|webp|heic|heif|gif)(?:$|\?)/i.exec(uri)?.[1]?.toLowerCase();
  if (!m) return null;
  return m === 'png' ? 'image/png' : m === 'webp' ? 'image/webp' : m === 'jpg' || m === 'jpeg' ? 'image/jpeg' : `image/${m}`;
}

async function ensureDir() {
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => undefined);
}

/** Anything the server would refuse (HEIC, GIF, unknown) is converted to JPEG at full resolution before it is stored. */
async function toStorableImage(sourceUri: string): Promise<{ uri: string; mime: string; temp: boolean }> {
  const mime = mimeFromUri(sourceUri);
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp') return { uri: sourceUri, mime, temp: false };
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const ref = await ImageManipulator.manipulate(sourceUri).renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.92 });
  return { uri: out.uri, mime: 'image/jpeg', temp: true };
}

export const expoAttachmentFs: AttachmentFs = {
  async importImage(sourceUri, attachmentId) {
    await ensureDir();
    const src = await toStorableImage(sourceUri);
    const fileName = `${attachmentId}.${extFor(src.mime)}`;
    const dest = `${DIR}${fileName}`;
    await FileSystem.copyAsync({ from: src.uri, to: dest });
    if (src.temp) await FileSystem.deleteAsync(src.uri, { idempotent: true }).catch(() => undefined);
    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists || !info.size) {
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined);
      throw new Error('The image could not be read. Try another photo.');
    }
    return { path: dest, sizeBytes: info.size ?? null, mimeType: src.mime, fileName };
  },
  async remove(path) { await FileSystem.deleteAsync(path, { idempotent: true }); },
  async exists(path) { return (await FileSystem.getInfoAsync(path)).exists; },
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export function expoAttachmentApi(apiUrl: string): AttachmentApi {
  const base = `${apiUrl}/api/v1/receipts/attachments`;
  const auth = (s: Session) => ({ Authorization: `Bearer ${s.access_token}` });
  return {
    async put(session, a: AttachmentEntity): Promise<PutResult> {
      if (!apiUrl) return { kind: 'transient', reason: 'no server configured' };
      const q = [
        `transaction_id=${encodeURIComponent(a.transaction_id)}`, `attachment_type=${a.attachment_type}`, `page_index=${a.page_index}`,
        a.width ? `width=${Math.round(a.width)}` : '', a.height ? `height=${Math.round(a.height)}` : '',
      ].filter(Boolean).join('&');
      try {
        const res = await withTimeout(FileSystem.uploadAsync(`${base}/${encodeURIComponent(a.id)}?${q}`, a.local_path!, {
          httpMethod: 'PUT',
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: { ...auth(session), 'Content-Type': a.mime_type ?? 'image/jpeg' },
        }), UPLOAD_TIMEOUT_MS);
        if (res.status === 200 || res.status === 201) return { kind: 'stored' };
        if (res.status === 410) return { kind: 'deleted' };
        if (res.status === 404) return { kind: 'not_found' };
        if (res.status === 401) return { kind: 'unauthorized' };
        if (res.status === 413 || res.status === 415 || res.status === 422) return { kind: 'rejected', status: res.status };
        return { kind: 'transient', reason: `HTTP ${res.status}` };
      } catch (e) {
        return { kind: 'transient', reason: e instanceof Error ? e.message : 'network' };
      }
    },
    async list(session, transactionId) {
      const res = await fetch(`${base}?transaction_id=${encodeURIComponent(transactionId)}`, { headers: auth(session) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { attachments?: RemoteAttachment[]; deleted_ids?: string[] };
      return { attachments: Array.isArray(body.attachments) ? body.attachments : [], deleted_ids: Array.isArray(body.deleted_ids) ? body.deleted_ids : [] };
    },
    async remove(session, attachmentId) {
      try {
        const res = await fetch(`${base}/${encodeURIComponent(attachmentId)}`, { method: 'DELETE', headers: auth(session) });
        if (res.status === 204 || res.status === 404) return 'ok';
        if (res.status === 401) return 'unauthorized';
        return 'transient';
      } catch { return 'transient'; }
    },
    async download(session, a) {
      await ensureDir();
      const dest = `${DIR}${a.id}.${extFor(a.mime_type ?? 'image/jpeg')}`;
      const res = await FileSystem.downloadAsync(`${base}/${encodeURIComponent(a.id)}`, dest, { headers: auth(session) });
      if (res.status !== 200) {
        await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined);
        throw new Error('This attachment is not available offline yet. Connect to the internet to load it.');
      }
      return dest;
    },
  };
}
