import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import type { ReportExportPort } from './monthlyReportExport.ts';

/**
 * Reports are written to the app's cache folder (not Downloads) and offered through the system share sheet, from which
 * the person can save, send or print them. The folder is emptied before each export, so at most the latest PDF and CSV
 * remain, and the OS may clear them at any time.
 */
const dir = () => `${FileSystem.cacheDirectory}velnora-reports/`;

export const expoReportExportPort: ReportExportPort = {
  async prepareDir() {
    await FileSystem.deleteAsync(dir(), { idempotent: true });
    await FileSystem.makeDirectoryAsync(dir(), { intermediates: true });
    return dir();
  },
  async printHtmlToPdf(html, size) {
    const { uri } = await Print.printToFileAsync({ html, width: size.width, height: size.height, margins: { top: 0, right: 0, bottom: 0, left: 0 } });
    return uri;
  },
  async moveFile(from, to) { await FileSystem.moveAsync({ from, to }); },
  async writeUtf8(uri, text) { await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 }); },
  canShare: () => Sharing.isAvailableAsync(),
  async share(uri, o) { await Sharing.shareAsync(uri, { mimeType: o.mimeType, UTI: o.uti, dialogTitle: o.dialogTitle }); },
};

/** Removes any leftover report files (called when the report screen opens). */
export async function clearReportFiles(): Promise<void> {
  await FileSystem.deleteAsync(dir(), { idempotent: true }).catch(() => undefined);
}
