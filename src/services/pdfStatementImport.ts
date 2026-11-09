import type { Session } from '../db/types.ts';
import { parsePdfStatement, type PdfStatementMeta } from './pdfStatementParser.ts';
import type { StatementRow } from './statementImport.ts';

/**
 * Reading a bank statement PDF. The file is validated on the device, then sent (only after the person agreed, over the
 * authenticated Velnora connection) to the Velnora server, which returns the text of each page. The server keeps neither
 * the file nor the text. Parsing into transactions happens here. Statement text is never logged and is dropped as soon
 * as the rows are built.
 *
 * Scanned (image-only) PDFs are NOT supported: reading them needs OCR, and this app has no OCR that can run on PDF
 * pages and the server has none either. They get a clear "unsupported" result instead of a pretend import.
 */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export type PdfFailure =
  | 'not_pdf' | 'empty_file' | 'too_large' | 'signin_required' | 'offline' | 'session_expired' | 'server'
  | 'encrypted' | 'invalid' | 'scanned' | 'too_many_pages' | 'unsupported_layout' | 'unsupported_currency' | 'no_transactions' | 'rows_not_understood';

export const PDF_FAILURE_MESSAGES: Record<PdfFailure, string> = {
  not_pdf: 'Please choose a PDF file.',
  empty_file: 'That file is empty.',
  too_large: 'That PDF is larger than 10 MB. Download a shorter date range from your bank.',
  signin_required: 'Sign in to import a PDF statement. PDFs are read by your Velnora server; CSV import works without an account.',
  offline: 'Could not reach Velnora to read the PDF. Check your connection and try again. Nothing was imported.',
  session_expired: 'Your session has expired. Sign in again to import a PDF. Your data on this phone is untouched.',
  server: 'Velnora could not read that PDF right now. Try again in a moment. Nothing was imported.',
  encrypted: 'This PDF is password protected. Remove the password in your bank app or a PDF viewer, then try again.',
  invalid: 'This file could not be read as a PDF. It may be damaged. Download the statement again.',
  scanned: 'This looks like a scanned statement (a picture of a page). Velnora cannot read scanned PDFs yet. Download the text version from your bank, or use CSV.',
  too_many_pages: 'That statement has more than 200 pages. Download a shorter date range.',
  unsupported_layout: 'Velnora could not find a transaction table in this PDF (date, description and amount columns). Try the CSV export from your bank.',
  unsupported_currency: 'This statement is not in rupees. Velnora imports INR statements only.',
  no_transactions: 'The statement table was found, but it has no transactions.',
  rows_not_understood: 'Transactions were found in this PDF but none could be read with confidence.',
};

export interface PdfFile { uri: string; name: string; mimeType?: string | null; size?: number | null }

export interface PdfExtractResponse { status: 'text' | 'scanned' | 'encrypted' | 'invalid' | 'empty'; page_count: number; pages: string[][] }

/** Transport, injected so the pipeline is testable without a device. Resolves with the HTTP status and parsed body. */
export interface PdfExtractPort {
  extract(file: PdfFile, session: Session): Promise<{ httpStatus: number; body: unknown }>;
}

export type PdfReadResult =
  | { ok: true; rows: StatementRow[]; errors: { line: number; reason: string }[]; meta: PdfStatementMeta; pageCount: number }
  | { ok: false; reason: PdfFailure; message: string };

const fail = (reason: PdfFailure, message?: string): PdfReadResult => ({ ok: false, reason, message: message ?? PDF_FAILURE_MESSAGES[reason] });

/** Counts only, never statement text: what stopped the lines that looked like transactions from being read. */
export function explainUnreadRows(errors: { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const why = top === 'Could not tell money in from money out' ? 'could not tell money received from money paid'
    : top === 'Amount not understood' ? 'had no amount Velnora could be sure of'
    : top === 'Date not understood' ? 'had a date Velnora could not read'
    : 'could not be read';
  return `Found ${errors.length} line${errors.length === 1 ? '' : 's'} that look like transactions, but ${n === errors.length ? 'all' : `${n} of them`} ${why}. Nothing was imported. Try the CSV export from your bank.`;
}

export function validatePdfFile(file: PdfFile): PdfFailure | null {
  const mime = (file.mimeType ?? '').toLowerCase();
  if (!/\.pdf$/i.test(file.name) || (mime && mime !== 'application/pdf' && mime !== 'application/octet-stream')) return 'not_pdf';
  if (file.size === 0) return 'empty_file';
  if ((file.size ?? 0) > MAX_PDF_BYTES) return 'too_large';
  return null;
}

function isExtractResponse(body: unknown): body is PdfExtractResponse {
  const b = body as PdfExtractResponse | null;
  return !!b && typeof b.status === 'string' && Array.isArray(b.pages) && b.pages.every((p) => Array.isArray(p));
}

export async function readPdfStatement(
  file: PdfFile, session: Session | null, port: PdfExtractPort, refresh?: (stale: Session) => Promise<Session | null>,
): Promise<PdfReadResult> {
  const invalid = validatePdfFile(file);
  if (invalid) return fail(invalid);
  if (!session) return fail('signin_required');

  let response: { httpStatus: number; body: unknown };
  try {
    response = await port.extract(file, session);
    if (response.httpStatus === 401 && refresh) {
      const fresh = await refresh(session);
      if (!fresh) return fail('session_expired');
      response = await port.extract(file, fresh);
    }
  } catch {
    return fail('offline');
  }
  if (response.httpStatus === 401) return fail('session_expired');
  if (response.httpStatus === 413) return fail((response.body as { detail?: string } | null)?.detail?.includes('pages') ? 'too_many_pages' : 'too_large');
  if (response.httpStatus === 415 || response.httpStatus === 422) return fail('not_pdf');
  if (response.httpStatus !== 200 || !isExtractResponse(response.body)) return fail('server');

  const { status, pages, page_count: pageCount } = response.body;
  if (status === 'encrypted') return fail('encrypted');
  if (status === 'invalid' || status === 'empty') return fail('invalid');
  if (status === 'scanned') return fail('scanned');

  const parsed = parsePdfStatement(pages);
  if (parsed.meta.unsupportedCurrency) return fail('unsupported_currency');
  if (!parsed.rows.length) {
    if (parsed.errors.length) return fail('rows_not_understood', explainUnreadRows(parsed.errors));
    return fail(parsed.meta.headerFound ? 'no_transactions' : 'unsupported_layout');
  }
  return { ok: true, rows: parsed.rows, errors: parsed.errors, meta: parsed.meta, pageCount };
}
