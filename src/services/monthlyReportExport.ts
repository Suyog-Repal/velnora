/**
 * Turns a MonthlyReport into a PDF or CSV file and hands it to the system share sheet. The platform pieces (printing,
 * files, sharing) come in through a port so this flow is testable without a device; the Expo implementation is in
 * monthlyReportExportExpo.ts. Everything stays on the device: no report content is sent anywhere or logged.
 */
import { buildCsv, reportFileName, verifyReport, type MonthlyReport } from './monthlyReportService.ts';
import { renderReportHtml, PDF_PAGE } from './monthlyReportHtml.ts';

export interface ReportExportPort {
  /** Empties the app's report cache folder and makes sure it exists. Returns its path with a trailing slash. */
  prepareDir(): Promise<string>;
  /** Renders HTML to a PDF file somewhere in the cache and returns its uri. */
  printHtmlToPdf(html: string, size: { width: number; height: number }): Promise<string>;
  moveFile(from: string, to: string): Promise<void>;
  writeUtf8(uri: string, text: string): Promise<void>;
  canShare(): Promise<boolean>;
  share(uri: string, options: { mimeType: string; uti: string; dialogTitle: string }): Promise<void>;
  /**
   * Saves a copy where the person chooses (Android: a folder picked in the system file picker). Independent of the share
   * sheet, so it still works when sharing fails. Optional: platforms without it simply do not offer the fallback.
   */
  saveToDevice?(uri: string, fileName: string, mimeType: string): Promise<'saved' | 'cancelled'>;
}

/** A file that was created: what the screen needs to offer "Save to device" for it. */
export interface ExportedFile { uri: string; fileName: string; mimeType: string }

export type ExportResult =
  | { ok: true; fileName: string; file: ExportedFile }
  | { ok: false; cancelled?: boolean; error: string; file?: ExportedFile; code?: string };

const isCancel = (e: unknown) => /cancel|dismiss|abort/i.test(e instanceof Error ? e.message : String(e));
/** Native modules reject with a code such as ERR_SHARING_FAILED. Only that shape is surfaced (never a message or path). */
export function safeErrorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,60}$/.test(code) ? code : undefined;
}

function shareFailureMessage(code: string | undefined): string {
  if (code === 'ERR_SHARING_IN_PROGRESS') return 'An earlier share is still open. Close it (or restart Velnora) and try again, or save the file to your device.';
  return 'The file was created but the share sheet could not open. You can save it to your device instead.';
}

async function run(port: ReportExportPort, report: MonthlyReport, kind: 'pdf' | 'csv'): Promise<ExportResult> {
  // Never produce a file whose numbers disagree with each other.
  if (verifyReport(report).length) return { ok: false, error: 'The report figures did not reconcile, so nothing was exported. Please try again.' };
  const fileName = reportFileName(kind, report.meta.month);
  let step = 'prepare';
  let file: ExportedFile | undefined;
  try {
    const dir = await port.prepareDir();
    const target = `${dir}${fileName}`;
    step = 'create';
    if (kind === 'pdf') {
      const temp = await port.printHtmlToPdf(renderReportHtml(report), PDF_PAGE);
      await port.moveFile(temp, target);
    } else {
      await port.writeUtf8(target, buildCsv(report));
    }
    file = { uri: target, fileName, mimeType: kind === 'pdf' ? 'application/pdf' : 'text/csv' };
    step = 'share';
    if (!(await port.canShare())) return { ok: false, error: 'Sharing is not available on this device. You can save the file to your device instead.', file };
    await port.share(target, kind === 'pdf'
      ? { mimeType: 'application/pdf', uti: 'com.adobe.pdf', dialogTitle: `Velnora report – ${report.meta.monthLabel}` }
      : { mimeType: 'text/csv', uti: 'public.comma-separated-values-text', dialogTitle: `Velnora transactions – ${report.meta.monthLabel}` });
    return { ok: true, fileName, file };
  } catch (e) {
    const code = safeErrorCode(e);
    if (step === 'share' && isCancel(e)) return { ok: false, cancelled: true, error: 'Sharing was cancelled.', file };
    // Debug builds log the native reason (for logcat); release builds log only the code. Nothing is shown with paths.
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn(`[Velnora export] ${kind} ${step} failed`, code ?? '', e instanceof Error ? e.message : String(e));
    else console.warn(`[Velnora export] ${kind} ${step} failed`, code ?? 'no-code');
    if (step === 'share') return { ok: false, error: shareFailureMessage(code), file, code };
    return { ok: false, code, error: kind === 'pdf' ? 'The PDF could not be created. Check free storage and try again.' : 'The CSV could not be saved. Check free storage and try again.' };
  }
}

/** "Save to device" for a file an export created. Never throws. */
export async function saveExportedFile(port: ReportExportPort, file: ExportedFile): Promise<{ ok: boolean; cancelled?: boolean; message: string }> {
  if (!port.saveToDevice) return { ok: false, message: 'Saving to a folder is not available on this device.' };
  try {
    const r = await port.saveToDevice(file.uri, file.fileName, file.mimeType);
    return r === 'saved' ? { ok: true, message: `${file.fileName} was saved.` } : { ok: false, cancelled: true, message: 'Saving was cancelled.' };
  } catch (e) {
    console.warn('[Velnora export] save failed', safeErrorCode(e) ?? 'no-code');
    return { ok: false, message: 'The file could not be saved to that folder. Try another folder.' };
  }
}

export const exportReportPdf = (port: ReportExportPort, report: MonthlyReport) => run(port, report, 'pdf');
export const exportReportCsv = (port: ReportExportPort, report: MonthlyReport) => run(port, report, 'csv');
