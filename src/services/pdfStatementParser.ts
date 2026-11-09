import type { Direction } from '../db/types.ts';
import { extractReference } from '../../transactionParser.ts';
import { hashRow, kindOf, parseStatementDate, type StatementRow } from './statementImport.ts';

/**
 * Turns the text of a bank statement PDF (rows as printed, columns kept as runs of spaces; see backend/app/statements.py)
 * into the same StatementRow the CSV importer produces, so the preview, duplicate matching and saving are shared.
 *
 * The layout is read, never assumed: the column headings on the page decide which column is the debit, credit, balance
 * and reference. A row's money direction comes from, in order of trust: the running balance (when it adds up), the
 * debit/credit column, a Dr/Cr marker. A row whose direction none of these settle is reported, never guessed.
 * Nothing here logs or keeps statement text.
 */
export interface PdfStatementMeta {
  bankName: string | null;
  periodStart: string | null; // ISO
  periodEnd: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  headerFound: boolean;
  unsupportedCurrency: boolean;
}

export interface PdfParseResult { rows: StatementRow[]; errors: { line: number; reason: string }[]; meta: PdfStatementMeta }

interface Cell { text: string; start: number; end: number }
type ColumnKind = 'date' | 'narration' | 'debit' | 'credit' | 'amount' | 'balance' | 'reference' | 'type';
interface Column { kind: ColumnKind; center: number }
interface Money { value: number; text: string; cell: Cell; line: number }
interface Group { cellsByLine: Cell[][] }
interface DateContext { start: Date | null; end: Date | null }
/** One statement row before the running balance has had its say about direction. */
interface Draft { line: number; date: Date; hasTime: boolean; amount: number; columnDirection: Direction | null; balance: number | null; narration: string; referenceId: string }

const MONTH_NAMES = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const DATE_SOURCE = `\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{1,2}[\\s/-](?:${MONTH_NAMES})[a-z]*[\\s/,-]+\\d{2,4}`;
const PERIOD = new RegExp(`(${DATE_SOURCE})\\s*(?:to|-|–|till|through)\\s*(${DATE_SOURCE})`, 'i');
const DAY_MONTH_ONLY = new RegExp(`^(\\d{1,2})[\\s/-](${MONTH_NAMES})[a-z]*\\b(?![\\s/,-]*\\d)`, 'i');
const TIME = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\b/i;
// Indian (1,25,000) and western (125,000) grouping are both valid; a stray comma is not.
const GROUPED = '(?:\\d{1,2}(?:,\\d{2})*,\\d{3}|\\d{1,3}(?:,\\d{3})+)';
const wrap = (num: string, symbol = '(?:(?:INR|Rs\\.?|₹)\\s*)?') => new RegExp(`^${symbol}\\(?-?${num}\\)?(?:\\s*(?:Dr|Cr)\\.?)?$`, 'i');
/** Sure to be money wherever it sits: has decimals, or digit grouping, or a currency symbol. */
const AMOUNT_SURE = [wrap(`(?:${GROUPED}|\\d+)\\.\\d{1,2}`), wrap(GROUPED), wrap('\\d{1,9}', '(?:INR|Rs\\.?|₹)\\s*')];
/** A bare whole number ("1250"): money only when it sits under a money column, never a date, reference or page number. */
const AMOUNT_PLAIN = wrap('\\d{1,9}', '');
const AMOUNT = { test: (text: string) => AMOUNT_SURE.some((r) => r.test(text)) };
const NEAR_COLUMN = 12; // characters

const HEADINGS: Record<ColumnKind, RegExp> = {
  date: /^(?:txn\.? |tran(?:saction)?\.? |value |posting )?(?:date|dt)\b/i,
  narration: /narration|description|particulars|remarks|details/i,
  debit: /debit|withdrawal|\bdr\b|paid out|money out/i,
  credit: /credit|deposit|\bcr\b|paid in|money in/i,
  amount: /^(?:txn |transaction )?amount\b/i,
  balance: /balance|\bbal\b/i,
  reference: /\bref|\butr\b|\bchq|cheque|instrument/i,
  type: /^(?:type|dr\s*\/\s*cr|cr\s*\/\s*dr|txn type)$/i,
};

const NOISE = /^(?:page\s+\d+|\d+\s+of\s+\d+|statement of account|account statement|this is a computer|computer generated|\*+\s*end of statement|registered office|customer care|toll free)/i;
const OPENING = /\b(?:opening balance|balance b\/?f|brought forward)\b/i;
const CLOSING = /\b(?:closing balance|balance c\/?f|carried forward)\b/i;
const TOTALS = /^(?:total|grand total|sub ?total|transaction total)\b/i;
const BANKS: [RegExp, string][] = [
  [/hdfc/i, 'HDFC Bank'], [/icici/i, 'ICICI Bank'], [/state bank of india|\bsbi\b/i, 'State Bank of India'], [/axis bank/i, 'Axis Bank'],
  [/kotak/i, 'Kotak Mahindra Bank'], [/punjab national|\bpnb\b/i, 'Punjab National Bank'], [/bank of baroda/i, 'Bank of Baroda'],
  [/yes bank/i, 'Yes Bank'], [/indusind/i, 'IndusInd Bank'], [/canara/i, 'Canara Bank'], [/idfc/i, 'IDFC First Bank'], [/union bank/i, 'Union Bank of India'],
];
const MAX_GROUP_LINES = 8;

function splitCells(line: string): Cell[] {
  const cells: Cell[] = [];
  for (const m of line.matchAll(/\S+(?: \S+)*/g)) {
    const text = m[0]; const start = m.index ?? 0;
    const words = text.split(' ');
    // "1,250.00 98,750.00" with one space between two amounts is two cells, not one.
    if (words.length > 1 && words.every((w) => AMOUNT.test(w))) {
      let at = start;
      for (const w of words) { cells.push({ text: w, start: at, end: at + w.length }); at += w.length + 1; }
    } else cells.push({ text, start, end: start + text.length });
  }
  return cells;
}

const centerOf = (c: Cell) => (c.start + c.end) / 2;

function headerColumns(cells: Cell[]): Column[] | null {
  // balance and type first: "Closing Balance" must not read as a credit, and "Dr/Cr" is one column, not two.
  const order: ColumnKind[] = ['balance', 'date', 'reference', 'type', 'debit', 'credit', 'amount', 'narration'];
  const columns: Column[] = [];
  for (const cell of cells) {
    const kind = order.find((k) => HEADINGS[k].test(cell.text.trim()));
    if (kind) columns.push({ kind, center: centerOf(cell) });
  }
  const has = (k: ColumnKind) => columns.some((c) => c.kind === k);
  const money = (has('debit') && has('credit')) || has('amount');
  return has('date') && has('narration') && money ? columns : null;
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
const dayEnd = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

function parseDateCell(text: string, ctx: DateContext): Date | null {
  const full = parseStatementDate(text);
  if (full) return full;
  const m = DAY_MONTH_ONLY.exec(text.trim());
  if (!m || !ctx.start) return null;
  // The year is only in the statement heading: choose the year that puts the day inside the stated period.
  const month = MONTH_NAMES.split('|').indexOf(m[2].toLowerCase());
  const end = ctx.end ?? ctx.start;
  for (const y of [ctx.start.getFullYear(), end.getFullYear()]) {
    const d = new Date(y, month, +m[1], 12, 0, 0);
    if (d.getMonth() === month && d.getDate() === +m[1] && d >= dayStart(ctx.start) && d <= dayEnd(end)) return d;
  }
  return null;
}

function withTime(date: Date, text: string): { date: Date; hasTime: boolean } {
  const t = TIME.exec(text);
  if (!t) return { date, hasTime: false };
  let hours = +t[1]; const minutes = +t[2];
  if (t[4]) hours = (hours % 12) + (/pm/i.test(t[4]) ? 12 : 0);
  if (hours > 23 || minutes > 59) return { date, hasTime: false };
  return { date: new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, t[3] ? +t[3] : 0), hasTime: true };
}

function amountValue(text: string): number | null {
  const cleaned = text.replace(/(?:INR|Rs\.?|₹|\s|,|Dr\.?|Cr\.?|\(|\))/gi, '').replace(/^-/, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function underMoneyColumn(cell: Cell, columns: Column[] | null): boolean {
  if (!columns) return false; // with no headings a bare number could be anything
  let best: Column | null = null; let bestDistance = Infinity;
  for (const c of columns) {
    const d = Math.min(Math.abs(centerOf(cell) - c.center), Math.abs(cell.end - c.center));
    if (d < bestDistance) { best = c; bestDistance = d; }
  }
  return !!best && bestDistance <= NEAR_COLUMN && ['debit', 'credit', 'amount', 'balance'].includes(best.kind);
}

function nearestColumn(cell: Cell, columns: Column[]): ColumnKind | null {
  const numeric = columns.filter((c) => c.kind === 'debit' || c.kind === 'credit' || c.kind === 'amount' || c.kind === 'balance');
  if (!numeric.length) return null;
  let best = numeric[0]; let bestDistance = Infinity;
  for (const c of numeric) {
    // numbers are often right-aligned under their heading, so the cell's right edge is as telling as its centre
    const d = Math.min(Math.abs(centerOf(cell) - c.center), Math.abs(cell.end - c.center));
    if (d < bestDistance) { best = c; bestDistance = d; }
  }
  return best.kind;
}

export function parsePdfStatement(pages: string[][]): PdfParseResult {
  const meta: PdfStatementMeta = { bankName: null, periodStart: null, periodEnd: null, openingBalance: null, closingBalance: null, headerFound: false, unsupportedCurrency: false };
  const errors: { line: number; reason: string }[] = [];

  const allText = pages.flat().join('\n');
  const head = pages.flat().slice(0, 60).join('\n');
  meta.bankName = BANKS.find(([p]) => p.test(head))?.[1] ?? null;
  meta.unsupportedCurrency = /\b(?:USD|EUR|GBP|AED)\b|[$€£]/.test(allText) && !/\bINR\b|₹|\bRs\b/i.test(allText);
  const ctx: DateContext = { start: null, end: null };
  const period = PERIOD.exec(head);
  if (period) {
    const a = parseStatementDate(period[1]); const b = parseStatementDate(period[2]);
    if (a && b && a <= b) { ctx.start = a; ctx.end = b; meta.periodStart = a.toISOString(); meta.periodEnd = b.toISOString(); }
  }

  let columns: Column[] | null = null;
  const drafts: Draft[] = [];
  let counter = 0;

  const flush = (group: Group | null) => {
    if (!group) return;
    counter += 1;
    const line = counter;
    let cells = group.cellsByLine[0];
    if (cells.length > 1 && /^\d{1,5}$/.test(cells[0].text) && parseDateCell(cells[1].text, ctx)) cells = cells.slice(1); // serial number column
    const dateCell = cells[0];
    const parsedDate = parseDateCell(dateCell.text, ctx);
    if (!parsedDate) { errors.push({ line, reason: 'Date not understood' }); return; }

    const refColumn = columns?.find((c) => c.kind === 'reference');
    const narrationColumn = columns?.find((c) => c.kind === 'narration');
    const money: Money[] = []; const words: string[] = []; let typeMarker = ''; let referenceCell = ''; let timeText = dateCell.text;
    group.cellsByLine.forEach((lineCells, index) => {
      for (const cell of lineCells) {
        if (cell === dateCell || (index === 0 && !cells.includes(cell))) continue;
        const text = cell.text.trim();
        if (AMOUNT.test(text) || (AMOUNT_PLAIN.test(text) && underMoneyColumn(cell, columns))) { const value = amountValue(text); if (value !== null) money.push({ value, text, cell, line: index }); continue; }
        if (/^(?:dr|cr|debit|credit)\.?$/i.test(text)) { typeMarker = text; continue; }
        if (/^\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?$/i.test(text)) { timeText += ` ${text}`; continue; }
        if (index === 0 && words.length === 0 && parseDateCell(text, ctx)) continue; // value date beside the transaction date
        const nearRef = refColumn && Math.abs(centerOf(cell) - refColumn.center) < Math.abs(centerOf(cell) - (narrationColumn?.center ?? Infinity));
        if (nearRef && /^[A-Za-z0-9-]{6,}$/.test(text) && /\d/.test(text)) { referenceCell ||= text; continue; }
        words.push(text);
      }
    });

    // Assign each amount to a column. With no headings, the last of several amounts is the running balance.
    let debit: number | null = null; let credit: number | null = null; let single: Money | null = null; let balance: number | null = null;
    if (columns) {
      for (const m of money) {
        const kind = nearestColumn(m.cell, columns);
        if (kind === 'balance') balance = m.value;
        else if (kind === 'debit') { if (m.value > 0) debit = m.value; }
        else if (kind === 'credit') { if (m.value > 0) credit = m.value; }
        else if (m.value > 0) single = m;
      }
    } else {
      const ordered = [...money].sort((a, b) => a.line - b.line || a.cell.start - b.cell.start);
      if (ordered.length >= 2) { balance = ordered[ordered.length - 1].value; single = ordered[0]; } else if (ordered.length === 1 && ordered[0].value > 0) single = ordered[0];
    }
    if (debit !== null && credit !== null) { errors.push({ line, reason: 'Debit and credit both filled' }); return; }
    const amount = debit ?? credit ?? single?.value ?? null;
    if (amount === null || amount <= 0) { errors.push({ line, reason: 'Amount not understood' }); return; }

    let columnDirection: Direction | null = debit !== null ? 'expense' : credit !== null ? 'income' : null;
    if (!columnDirection && single) {
      const marker = `${typeMarker} ${single.text}`;
      if (/\b(?:dr|debit)\b\.?/i.test(marker) || /^\s*[-(]/.test(single.text)) columnDirection = 'expense';
      else if (/\b(?:cr|credit)\b\.?/i.test(marker)) columnDirection = 'income';
    }
    const narration = words.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const { date, hasTime } = withTime(parsedDate, timeText);
    drafts.push({ line, date, hasTime, amount, columnDirection, balance, narration, referenceId: referenceCell || extractReference(narration) });
  };

  for (const page of pages) {
    let group: Group | null = null;
    for (const raw of page) {
      const cells = splitCells(raw);
      if (!cells.length) continue;
      const header = headerColumns(cells);
      if (header) { flush(group); group = null; columns = header; meta.headerFound = true; continue; }

      const text = raw.trim();
      if (OPENING.test(text) || CLOSING.test(text)) {
        flush(group); group = null;
        const value = cells.filter((c) => AMOUNT.test(c.text) || AMOUNT_PLAIN.test(c.text)).map((c) => amountValue(c.text)).filter((v): v is number => v !== null).pop();
        if (value !== undefined && OPENING.test(text) && meta.openingBalance === null) meta.openingBalance = value;
        if (value !== undefined && CLOSING.test(text)) meta.closingBalance = value;
        continue;
      }
      const dated = cells.length > 1 && /^\d{1,5}$/.test(cells[0].text) ? cells[1] : cells[0];
      if (!PERIOD.test(text) && parseDateCell(dated.text, ctx)) { flush(group); group = { cellsByLine: [cells] }; continue; }
      if (NOISE.test(text) || TOTALS.test(text)) { flush(group); group = null; continue; }
      if (group && group.cellsByLine.length < MAX_GROUP_LINES) group.cellsByLine.push(cells);
    }
    flush(group); // a wrapped description is not continued across a page break
  }

  // Statements run oldest-first or newest-first. The balance BEFORE a row is the previous row's (or the next row's).
  const ascending = drafts.length < 2 || drafts[0].date.getTime() <= drafts[drafts.length - 1].date.getTime();
  const rows: StatementRow[] = [];
  const seen = new Map<string, number>();
  drafts.forEach((d, i) => {
    const before = ascending ? (i > 0 ? drafts[i - 1].balance : meta.openingBalance) : (drafts[i + 1]?.balance ?? null);
    let direction = d.columnDirection;
    if (d.balance !== null && before !== null) {
      const delta = Math.round((d.balance - before) * 100) / 100;
      if (delta !== 0 && Math.abs(Math.abs(delta) - d.amount) < 0.01) direction = delta > 0 ? 'income' : 'expense';
    }
    if (!direction) { errors.push({ line: d.line, reason: 'Could not tell money in from money out' }); return; }
    const day = `${d.date.getFullYear()}-${String(d.date.getMonth() + 1).padStart(2, '0')}-${String(d.date.getDate()).padStart(2, '0')}`;
    const base = [day, d.amount.toFixed(2), direction, d.narration.toLowerCase(), d.balance !== null ? d.balance.toFixed(2) : '', d.referenceId].join('|');
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    rows.push({
      line: d.line, date: d.date.toISOString(), amount: d.amount, direction, narration: d.narration, referenceId: d.referenceId,
      ...(d.balance !== null ? { balance: d.balance } : {}), fingerprint: `st-${hashRow(`${base}|${occurrence}`)}`, kind: kindOf(d.narration),
      origin: 'pdf', ...(d.hasTime ? { hasTime: true } : {}),
    });
  });
  return { rows, errors, meta };
}
