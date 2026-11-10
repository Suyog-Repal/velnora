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
}

export type ExportResult =
  | { ok: true; fileName: string }
  | { ok: false; cancelled?: boolean; error: string };

const isCancel = (e: unknown) => /cancel|dismiss|abort/i.test(e instanceof Error ? e.message : String(e));

async function run(port: ReportExportPort, report: MonthlyReport, kind: 'pdf' | 'csv'): Promise<ExportResult> {
  // Never produce a file whose numbers disagree with each other.
  if (verifyReport(report).length) return { ok: false, error: 'The report figures did not reconcile, so nothing was exported. Please try again.' };
  const fileName = reportFileName(kind, report.meta.month);
  let step = 'prepare';
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
    step = 'share';
    if (!(await port.canShare())) return { ok: false, error: 'Sharing is not available on this device.' };
    await port.share(target, kind === 'pdf'
      ? { mimeType: 'application/pdf', uti: 'com.adobe.pdf', dialogTitle: `Velnora report – ${report.meta.monthLabel}` }
      : { mimeType: 'text/csv', uti: 'public.comma-separated-values-text', dialogTitle: `Velnora transactions – ${report.meta.monthLabel}` });
    return { ok: true, fileName };
  } catch (e) {
    if (step === 'share' && isCancel(e)) return { ok: false, cancelled: true, error: 'Sharing was cancelled.' };
    // Fixed phrases only: the underlying error text may name file paths and is not shown or logged.
    return { ok: false, error: step === 'share' ? 'The file was created but could not be shared.' : kind === 'pdf' ? 'The PDF could not be created. Check free storage and try again.' : 'The CSV could not be saved. Check free storage and try again.' };
  }
}

export const exportReportPdf = (port: ReportExportPort, report: MonthlyReport) => run(port, report, 'pdf');
export const exportReportCsv = (port: ReportExportPort, report: MonthlyReport) => run(port, report, 'csv');
