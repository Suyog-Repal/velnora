import { TransactionRepository, merchantsCompatible, type DetectionInput } from '../db/repositories/transactionRepository.ts';
import { withWriteLock } from '../db/writeLock.ts';
import type { CreateTransactionInput, Direction, IDatabase } from '../db/types.ts';
import { extractReference } from '../../transactionParser.ts';
import { suggestCategory, type KindForCategory } from './transactionClassifier.ts';

/**
 * Bank statement import (CSV). The person picks one file; it is read on the device and never uploaded as a file.
 * Parse → preview against the ledger → person confirms → accepted rows join the same ledger with the same keys, so
 * importing the same statement twice adds nothing.
 */
export interface StatementRow {
  line: number;
  date: string; // ISO, noon local (a statement states only the day)
  amount: number;
  direction: Direction;
  narration: string;
  referenceId: string;
  balance?: number;
  fingerprint: string;
  kind: KindForCategory;
  /** Where the row was read from. Absent means CSV. */
  origin?: 'csv' | 'pdf';
  /** The statement printed a time of day, so `date` carries it; otherwise `date` is the day only. */
  hasTime?: boolean;
  /** The person's (or a saved merchant rule's) category; wins over the suggested one. */
  category?: string;
  /** Set by the PDF flow: the category is a guess the person should check. */
  needsReview?: boolean;
  /** How sure the category is. 'user' means the person chose it (now or in a saved rule). */
  categoryConfidence?: 'high' | 'medium' | 'low' | 'user';
}

export interface StatementParseResult { rows: StatementRow[]; errors: { line: number; reason: string }[]; headerFound: boolean }

export type PreviewStatus = 'already_imported' | 'matched' | 'possible' | 'new';
export interface PreviewRow { row: StatementRow; status: PreviewStatus; matchId: string | null; matchLabel: string | null }

export interface ImportSummary { found: number; added: number; matched: number; possibleDuplicates: number; alreadyImported: number; needsReview: number; errors: number }

export const MAX_STATEMENT_BYTES = 2 * 1024 * 1024;

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = ''; let row: string[] = []; let quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Indian statement dates are day-first; an impossible date is an error, never a guess. */
export function parseStatementDate(value: string): Date | null {
  const v = value.trim();
  let y: number; let m: number; let d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (r) { y = +r[1]; m = +r[2] - 1; d = +r[3]; }
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(v))) { d = +r[1]; m = +r[2] - 1; y = r[3].length === 2 ? 2000 + +r[3] : +r[3]; }
  else if ((r = /^(\d{1,2})[\s/-]([A-Za-z]{3,9})[\s/,-]+(\d{2}|\d{4})\b/.exec(v))) {
    const month = MONTHS[r[2].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    d = +r[1]; m = month; y = r[3].length === 2 ? 2000 + +r[3] : +r[3];
  } else return null;
  const out = new Date(y, m, d, 12, 0, 0);
  return out.getFullYear() === y && out.getMonth() === m && out.getDate() === d ? out : null;
}

export function parseStatementAmount(value: string): number | null {
  let v = value.trim();
  if (!v || v === '-') return null;
  if (/^\(.*\)$/.test(v)) v = v.slice(1, -1);
  v = v.replace(/(?:INR|Rs\.?|₹|\s|,|Dr|Cr)/gi, '').replace(/^-/, '');
  if (!/^\d+(?:\.\d{1,4})?$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? Math.round(n * 100) / 100 : null;
}

const COL = {
  date: /^(?:txn |tran(?:saction)? |value )?date\b/i,
  narration: /narration|description|particulars|remarks|details/i,
  debit: /debit|withdrawal|\bdr\b/i,
  credit: /credit|deposit|\bcr\b/i,
  amount: /^(?:txn |transaction )?amount\b/i,
  type: /^(?:type|dr\s*\/\s*cr|cr\s*\/\s*dr|txn type)$/i,
  balance: /balance/i,
  reference: /ref|utr|chq|cheque/i,
};

function findColumns(header: string[]) {
  const pick = (pattern: RegExp, skip: RegExp[] = []) => header.findIndex((h) => pattern.test(h.trim()) && !skip.some((s) => s.test(h)));
  const cols = {
    date: pick(COL.date), narration: pick(COL.narration), debit: pick(COL.debit, [COL.balance]), credit: pick(COL.credit, [COL.balance]),
    amount: pick(COL.amount), type: pick(COL.type), balance: pick(COL.balance), reference: pick(COL.reference, [COL.date]),
  };
  // A single "Dr/Cr" column says the direction of an Amount column; it is not separate debit and credit columns.
  if (cols.debit === cols.credit) { cols.debit = -1; cols.credit = -1; }
  const hasMoney = (cols.debit !== -1 && cols.credit !== -1) || cols.amount !== -1;
  return cols.date !== -1 && cols.narration !== -1 && hasMoney ? cols : null;
}

export function hashRow(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16);
}

export function kindOf(narration: string): KindForCategory {
  if (/\brevers(?:al|ed)\b/i.test(narration)) return 'reversal';
  if (/\brefund\b/i.test(narration)) return 'refund';
  if (/\b(?:self|own a\/?c)\b/i.test(narration)) return 'transfer';
  if (/\bATM\b|\bcash wdl\b|\bcash withdrawal\b/i.test(narration)) return 'cash_withdrawal';
  return 'payment';
}

export function parseStatementCsv(text: string): StatementParseResult {
  const table = parseCsvRows(text);
  const headerIndex = table.slice(0, 40).findIndex((row) => findColumns(row) !== null);
  if (headerIndex === -1) return { rows: [], errors: [], headerFound: false };
  const cols = findColumns(table[headerIndex])!;
  const rows: StatementRow[] = [];
  const errors: { line: number; reason: string }[] = [];
  const seen = new Map<string, number>();

  table.slice(headerIndex + 1).forEach((cells, offset) => {
    const line = headerIndex + offset + 2;
    if (cells.every((c) => !c.trim())) return;
    const rawDate = cells[cols.date] ?? '';
    const date = parseStatementDate(rawDate);
    if (!date) {
      // Footers ("Closing balance", legal text) have no date at all; only a row that looks like data is an error.
      if (rawDate.trim()) errors.push({ line, reason: 'Date not understood' });
      return;
    }
    let direction: Direction | null = null; let amount: number | null = null;
    if (cols.debit !== -1 && cols.credit !== -1) {
      const debit = parseStatementAmount(cells[cols.debit] ?? '');
      const credit = parseStatementAmount(cells[cols.credit] ?? '');
      if (debit && !credit) { direction = 'expense'; amount = debit; }
      else if (credit && !debit) { direction = 'income'; amount = credit; }
    } else {
      const raw = cells[cols.amount] ?? '';
      amount = parseStatementAmount(raw);
      const type = `${cols.type !== -1 ? cells[cols.type] ?? '' : ''} ${raw}`;
      if (/\b(?:dr|debit)\b/i.test(type) || /^\s*[-(]/.test(raw)) direction = 'expense';
      else if (/\b(?:cr|credit)\b/i.test(type)) direction = 'income';
    }
    if (!direction || !amount) { errors.push({ line, reason: 'Amount or direction not understood' }); return; }

    const narration = (cells[cols.narration] ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const stated = cols.reference !== -1 ? (cells[cols.reference] ?? '').trim() : '';
    const referenceId = /\d{6,}/.test(stated) ? stated : extractReference(narration);
    const balance = cols.balance !== -1 ? parseStatementAmount(cells[cols.balance] ?? '') ?? undefined : undefined;
    const base = [date.toISOString().slice(0, 10), amount.toFixed(2), direction, narration.toLowerCase(), balance?.toFixed(2) ?? '', referenceId].join('|');
    // Two identical lines in one statement are two transactions: the occurrence keeps them apart yet stable on re-import.
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    rows.push({ line, date: date.toISOString(), amount, direction, narration, referenceId, ...(balance !== undefined ? { balance } : {}), fingerprint: `st-${hashRow(`${base}|${occurrence}`)}`, kind: kindOf(narration) });
  });
  return { rows, errors, headerFound: true };
}

export function displayName(narration: string): string {
  const parts = narration.split(/[/-]/).map((p) => p.trim()).filter((p) => /[A-Za-z]{3}/.test(p) && !/^(?:UPI|NEFT|IMPS|RTGS|P2M|P2A|DR|CR|ATM|POS)$/i.test(p));
  return (parts[0] ?? narration).slice(0, 60).trim() || 'Statement entry';
}

function toInput(row: StatementRow, scope: string | null): CreateTransactionInput {
  const counterparty = displayName(row.narration);
  return {
    amount: row.amount, direction: row.direction, counterparty,
    category: row.category ?? suggestCategory({ merchant: row.narration, body: row.narration, direction: row.direction, kind: row.kind }),
    description: `Imported from ${row.origin === 'pdf' ? 'PDF ' : ''}statement: ${row.narration}`, transaction_date: row.date, source: 'sms', capture_source: 'csv_import',
    txn_kind: row.kind, verification_status: row.needsReview ? 'needs_review' : 'verified', reference_id: row.referenceId || null, fingerprint: row.fingerprint, user_id: scope, sync_status: 'pending_create',
  };
}

const detectionFor = (row: StatementRow): DetectionInput => ({
  source: 'csv_import', detectedAt: new Date(row.date).getTime(), dayPrecision: !row.hasTime,
  metadata: { referenceId: row.referenceId || undefined, balance: row.balance, fingerprint: row.fingerprint },
});

/** Read-only comparison with the ledger. */
export async function previewStatement(db: IDatabase, scope: string | null, rows: StatementRow[]): Promise<PreviewRow[]> {
  const repo = new TransactionRepository(db);
  const key = scope ?? '';
  const claimed = new Set<string>();
  const out: PreviewRow[] = [];
  for (const row of rows) {
    if (await repo.hasIdentityKey(key, `fp:${row.fingerprint}`)) { out.push({ row, status: 'already_imported', matchId: null, matchLabel: null }); continue; }
    const match = await repo.findPossibleDuplicate(toInput(row, scope), detectionFor(row), key);
    // Two lines of one statement are two payments: an existing transaction can stand for only one of them.
    if (match && claimed.has(match.row.id)) { out.push({ row, status: 'new', matchId: null, matchLabel: null }); continue; }
    if (match) claimed.add(match.row.id);
    const certain = match && (match.result.outcome === 'exact' || match.result.outcome === 'strong');
    out.push({ row, status: certain ? 'matched' : match ? 'possible' : 'new', matchId: match?.row.id ?? null, matchLabel: match?.row.counterparty ?? null });
  }
  return out;
}

/** Applies the person's confirmed preview. `include` decides which 'new' and 'possible' rows are added. */
export async function applyStatement(
  db: IDatabase, scope: string | null, preview: PreviewRow[], include: (p: PreviewRow) => boolean, parseErrors = 0,
): Promise<ImportSummary> {
  const repo = new TransactionRepository(db);
  // Every statement line is remembered by its own key, so re-importing the file is recognised line by line.
  const rememberRow = (row: StatementRow, transactionId: string) => withWriteLock(() => db.runAsync(
    'INSERT OR IGNORE INTO transaction_keys (scope, key, transaction_id, created_at) VALUES (?, ?, ?, ?)', scope ?? '', `fp:${row.fingerprint}`, transactionId, new Date().toISOString(),
  ));
  const summary: ImportSummary = { found: preview.length, added: 0, matched: 0, possibleDuplicates: 0, alreadyImported: 0, needsReview: 0, errors: parseErrors };
  for (const p of preview) {
    if (p.status === 'already_imported') { summary.alreadyImported += 1; continue; }
    if (p.status === 'matched' && p.matchId) {
      // The row is the existing transaction: keep one record, remember the statement confirmed it.
      await repo.ingestDetected(toInput(p.row, scope), detectionFor(p.row), { attachTo: p.matchId });
      await rememberRow(p.row, p.matchId);
      summary.matched += 1;
      continue;
    }
    if (!include(p)) continue;
    const outcome = await repo.ingestDetected(toInput(p.row, scope), detectionFor(p.row));
    await rememberRow(p.row, outcome.transaction.id);
    if (outcome.created) {
      summary.added += 1;
      if (outcome.transaction.verification_status === 'needs_review') { summary.needsReview += 1; summary.possibleDuplicates += 1; }
    } else summary.matched += 1;
  }
  return summary;
}

/**
 * Two different statement files (a CSV and a PDF of the same account, or two overlapping PDFs) both arrive through the
 * statement channel, and the ledger rule "one channel reports each payment once" cannot tell them apart. So a new row
 * that lines up with an already-imported statement row (same day, amount, direction, compatible merchant) is offered to
 * the person as a possible duplicate instead of being added silently. Each existing row is offered at most once, so two
 * genuine same-day payments of one amount are not both blocked by a single earlier row.
 */
export async function flagStatementOverlaps(db: IDatabase, scope: string | null, preview: PreviewRow[]): Promise<PreviewRow[]> {
  const key = scope ?? '';
  const taken = new Set<string>();
  const out: PreviewRow[] = [];
  for (const p of preview) {
    if (p.status !== 'new') { out.push(p); continue; }
    const d = new Date(p.row.date);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).toISOString();
    const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).toISOString();
    const rows = await db.getAllAsync<{ id: string; counterparty: string }>(
      `SELECT t.id, t.counterparty FROM transactions t
       WHERE t.deleted_at IS NULL AND COALESCE(t.user_id, '') = ? AND t.direction = ? AND t.amount_paise = ?
         AND t.transaction_date >= ? AND t.transaction_date <= ?
         AND EXISTS (SELECT 1 FROM transaction_sources s WHERE s.transaction_id = t.id AND s.source = 'csv_import')
       ORDER BY t.created_at`,
      key, p.row.direction, Math.round(p.row.amount * 100), from, to,
    );
    const hit = rows.find((r) => !taken.has(r.id) && merchantsCompatible(r.counterparty, displayName(p.row.narration)));
    if (hit) { taken.add(hit.id); out.push({ ...p, status: 'possible', matchId: hit.id, matchLabel: hit.counterparty }); } else out.push(p);
  }
  return out;
}

/** Lines of a preview that start out left out: a possible duplicate is added only if the person chooses to add it. */
export const defaultExcludedLines = (preview: PreviewRow[]): Set<number> => new Set(preview.filter((p) => p.status === 'possible').map((p) => p.row.line));
