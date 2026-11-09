import * as FileSystem from 'expo-file-system/legacy';
import type { PdfExtractPort } from './pdfStatementImport.ts';

/** The PDF goes to the app's own server as the raw request body, the same way receipts do (see receiptFiles.ts). */
export function expoPdfExtractPort(apiUrl: string): PdfExtractPort {
  return {
    async extract(file, session) {
      const res = await FileSystem.uploadAsync(`${apiUrl}/api/v1/statements/extract`, file.uri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/pdf' },
      });
      let body: unknown = null;
      try { body = JSON.parse(res.body); } catch { /* not JSON: reported as a server problem */ }
      return { httpStatus: res.status, body };
    },
  };
}

/** The picked file is a cache copy; it is removed as soon as it has been read. */
export async function removeTempFile(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}
