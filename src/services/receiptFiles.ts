import * as FileSystem from 'expo-file-system/legacy';
import type { Session } from '../db/types.ts';
import type { ReceiptFs, ReceiptUploader } from './receiptService.ts';

const DIR = `${FileSystem.documentDirectory ?? ''}receipts/`;

/** App-private (documentDirectory) storage: survives restarts, unlike cache paths. */
export const expoReceiptFs: ReceiptFs = {
  async importImage(sourceUri, transactionId) {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => undefined);
    const ext = /\.(png|webp)$/i.exec(sourceUri)?.[1]?.toLowerCase() ?? 'jpg';
    const dest = `${DIR}${transactionId}-${Date.now()}.${ext}`;
    await FileSystem.copyAsync({ from: sourceUri, to: dest });
    return dest;
  },
  async remove(path) { await FileSystem.deleteAsync(path, { idempotent: true }); },
  async exists(path) { return (await FileSystem.getInfoAsync(path)).exists; },
};

export function expoReceiptUploader(apiUrl: string): ReceiptUploader {
  return {
    async upload(session: Session, transactionId, localPath) {
      const mime = /\.png$/i.test(localPath) ? 'image/png' : /\.webp$/i.test(localPath) ? 'image/webp' : 'image/jpeg';
      const res = await FileSystem.uploadAsync(`${apiUrl}/api/v1/receipts?transaction_id=${encodeURIComponent(transactionId)}`, localPath, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': mime },
      });
      if (res.status !== 201) throw new Error(`Receipt upload failed (${res.status})`);
      return (JSON.parse(res.body) as { id: string }).id;
    },
  };
}

/** For transactions that came from another device: fetch the image into private storage when first viewed. */
export async function downloadReceipt(apiUrl: string, session: Session, transactionId: string, remoteId: string): Promise<string> {
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => undefined);
  const dest = `${DIR}${transactionId}-remote.jpg`;
  const res = await FileSystem.downloadAsync(`${apiUrl}/api/v1/receipts/${encodeURIComponent(remoteId)}`, dest, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (res.status !== 200) { await FileSystem.deleteAsync(dest, { idempotent: true }); throw new Error('Receipt unavailable'); }
  return dest;
}
