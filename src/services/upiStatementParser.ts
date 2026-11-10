/**
 * Structured reader for UPI-app transaction statements (Google Pay layout: a date/time column on the left, the
 * transaction details in the middle, the amount on the right, one block per payment). Pipeline, one stage per function:
 *
 *   detect format -> clean page noise -> segment into blocks -> read fields (date, time, description, UPI id, bank, amount)
 *   -> classify direction from stated evidence -> validate -> reconcile against the statement's own Sent/Received totals
 *
 * Rules that keep the money honest:
 * - A block owns only the lines between its date line and the next date line. It never borrows a date, id or amount.
 * - The amount must sit on one of the block's own rows (in practice its date row). No amount means the record is withheld, not imported as 0.
 * - Direction is never guessed. "Received from" and "Paid to" are the statement's own words; the account line under the
 *   block ("Paid by <bank>" = money left that account, "Paid to <bank>" = money arrived in that account) must agree.
 *   If the two disagree, or neither speaks, the record is withheld with the evidence attached.
 * - Money is integer paise. No binary floating point is used to add or compare amounts.
 * - Nothing here logs or stores statement text; the evidence lines live in memory only for the review screen.
 */
import type { Direction } from '../db/types.ts';

export type PdfDirection = 'income' | 'expense' | 'refund' | 'reversal' | 'transfer' | 'unknown';
export type PdfConfidence = 'high' | 'medium' | 'low';

export interface UpiRecord {
  index: number; // 1-based position in the statement
  page: number; // page the block starts on
  dateText: string | null;
  timeText: string | null;
  date: Date | null; // local, carries the time when one was printed
  hasTime: boolean;
  description: string; // as printed, e.g. "Paid to Night canteen"
  counterparty: string; // description without the "Paid to" / "Received from" wording
  reference: string; // UPI transaction id, '' when absent
  bankName: string | null;
  accountLast4: string | null;
  accountRole: 'from' | 'to' | null; // "Paid by <bank>" = from, "Paid to <bank>" = to
  amountText: string | null;
  amountPaise: number | null;
  direction: PdfDirection;
  transfer: boolean; // own-account transfer (excluded from income and expense)
  evidence: string[];
  confidence: PdfConfidence;
  reviewReasons: string[];
  /** The block exactly as printed (trimmed). Kept in memory for the review screen only. */
  original: string[];
}

export interface StatementTotals { sentPaise: number | null; receivedPaise: number | null }

export interface Reconciliation {
  status: 'matched' | 'mismatch' | 'no_statement_totals';
  stated: StatementTotals;
  computed: { sentPaise: number; receivedPaise: number };
  /** computed - stated, in paise; null when the statement states no total. */
  sentDifferencePaise: number | null;
  receivedDifferencePaise: number | null;
  /** Amount held back in withheld records, so a mismatch can be explained. */
  withheldCount: number;
  withheldPaise: number;
  note: string;
}

export interface UpiParseResult {
  records: UpiRecord[]; // every block found, in statement order
  periodStart: Date | null;
  periodEnd: Date | null;
  totals: StatementTotals;
  reconciliation: Reconciliation;
  pagesSeen: number;
  recordsPerPage: number[]; // index = page - 1
  ignoredLines: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SYMBOL = '(?:₹|₨|`|¹|INR\\s?|Rs\\.?\\s?)';
const DATE_AT_START = /^(\d{1,2})\s*([A-Za-z]{3,9})\.?,?\s*(\d{4})(?=\s|$)/;
const TIME_AT_START = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?(?=\s|$)/;
const AMOUNT_AT_END = new RegExp(`${SYMBOL}\\s*(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*$`, 'i');
const ID_LINE = /UPI\s*Transaction\s*ID\s*[:#-]?\s*([A-Za-z0-9]{6,})/i;
const INSTRUMENT = /^(paid\s+by|paid\s+to|received\s+in|credited\s+to|debited\s+from)\s+(.+?)\s*(\d{4})?\s*$/i;
const NOISE = [
  /^transaction\s+statement\s*$/i,
  /^note\s*:/i,
  /^received\.\s*any\s+payments/i,
  /^page\s*\d+\s*of\s*\d+\s*$/i,
  /^date\s*&\s*time\b.*\bamount\s*$/i,
  /^\+?[\d\s-]{7,15},?\s+\S+@\S+\s*$/, // "9146742145, name@example.com"
  /^\S+@\S+\.\S+\s*$/,
];
const WORDING_OUT = /^paid\s+to\s+/i;
const WORDING_IN = /^(?:received\s+from|money\s+received\s+from)\s+/i;
const WORDING_SELF = /^self[\s-]*transfer(?:\s+(?:to|from))?\s*/i;
const WORDING_REFUND = /^refund(?:ed)?\b/i;
const WORDING_REVERSAL = /^(?:payment\s+)?revers(?:al|ed)\b/i;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "₹1,25,000.50" -> 12500050. Accepts Indian and western digit grouping and a plain number; rejects anything else. */
export function parseAmountPaise(text: string): number | null {
  const body = text.replace(new RegExp(`^\\s*${SYMBOL}`, 'i'), '').replace(/\s+/g, '');
  const m = /^(\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3})(?:\.(\d{1,2}))?$/.exec(body);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ''));
  if (!Number.isSafeInteger(whole) || whole > 99_999_999_999) return null;
  return whole * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

export const paiseToRupees = (paise: number): number => Math.round(paise) / 100;

function parseDate(day: string, monthName: string, year: string): Date | null {
  const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const d = new Date(Number(year), month, Number(day), 12, 0, 0);
  return d.getFullYear() === Number(year) && d.getMonth() === month && d.getDate() === Number(day) ? d : null;
}

function applyTime(date: Date, t: RegExpExecArray): { date: Date; ok: boolean } {
  let hours = Number(t[1]); const minutes = Number(t[2]);
  if (t[3]) { if (hours < 1 || hours > 12) return { date, ok: false }; hours = (hours % 12) + (/p/i.test(t[3]) ? 12 : 0); }
  if (hours > 23 || minutes > 59) return { date, ok: false };
  return { date: new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0), ok: true };
}

export function isUpiStatement(pages: string[][]): boolean {
  const head = pages.slice(0, 2).flat().map(clean);
  const header = head.some((l) => /^date\s*&\s*time\b.*\btransaction\s+details\b.*\bamount$/i.test(l));
  const idLines = pages.slice(0, 3).flat().filter((l) => ID_LINE.test(l)).length;
  return header && idLines > 0;
}

interface Block { page: number; lines: string[] }

function isNoise(line: string): boolean { return NOISE.some((r) => r.test(line)); }

/** Stage: cut the page rows into one block per payment. A block can continue across a page break. */
function segment(pages: string[][]): { blocks: Block[]; ignored: number; headerLines: string[] } {
  const blocks: Block[] = [];
  const headerLines: string[] = [];
  let current: Block | null = null;
  let ignored = 0;
  let seenHeader = false;
  pages.forEach((rows, p) => {
    for (const raw of rows) {
      const line = clean(raw);
      if (!line) continue;
      if (/^date\s*&\s*time\b/i.test(line)) { seenHeader = true; continue; }
      if (!seenHeader) { headerLines.push(line); continue; }
      if (isNoise(line)) { ignored += 1; continue; }
      if (DATE_AT_START.test(line)) { current = { page: p + 1, lines: [line] }; blocks.push(current); continue; }
      const hasId = ID_LINE.test(line);
      const startsWithTime = TIME_AT_START.test(line);
      // A second time or id inside one block means the block boundary was lost: start a dateless block, never merge.
      if (current && ((startsWithTime && current.lines.some((l) => TIME_AT_START.test(l))) || (hasId && current.lines.some((l) => ID_LINE.test(l))))) current = null;
      if (!current) { current = { page: p + 1, lines: [] }; blocks.push(current); }
      current.lines.push(line);
    }
  });
  return { blocks, ignored, headerLines };
}

function readHeader(lines: string[]): { totals: StatementTotals; start: Date | null; end: Date | null } {
  const figure = new RegExp(`${SYMBOL}\\s*(\\d[\\d,]*(?:\\.\\d{1,2})?)`, 'gi');
  let sent: number | null = null; let received: number | null = null;
  // "Sent ₹30,383.88 Received ₹33,005" on one row, or the labels on one row and their figures on the row below.
  for (let i = 0; i < lines.length && (sent === null || received === null); i += 1) {
    const sentAt = lines[i].search(/\bSent\b/i); const receivedAt = lines[i].search(/\bReceived\b/i);
    if (sentAt < 0 || receivedAt < 0) continue;
    const inline = [...lines[i].matchAll(figure)].map((m) => ({ at: m.index ?? 0, paise: parseAmountPaise(m[1]) }));
    const found = inline.length >= 2 ? inline : [...(lines[i + 1] ?? '').matchAll(figure)].map((m) => ({ at: m.index ?? 0, paise: parseAmountPaise(m[1]) }));
    if (found.length !== 2) continue;
    // the label that comes first owns the figure that comes first
    [sent, received] = sentAt < receivedAt ? [found[0].paise, found[1].paise] : [found[1].paise, found[0].paise];
  }
  const period = /(\d{1,2})\s*([A-Za-z]{3,9})\.?,?\s*(\d{4})\s*(?:-|–|to)\s*(\d{1,2})\s*([A-Za-z]{3,9})\.?,?\s*(\d{4})/i.exec(lines.join(' | ').replace(/\s+/g, ' '));
  const start = period ? parseDate(period[1], period[2], period[3]) : null;
  const end = period ? parseDate(period[4], period[5], period[6]) : null;
  const ok = !!start && !!end && start <= end;
  return { totals: { sentPaise: sent, receivedPaise: received }, start: ok ? start : null, end: ok ? end : null };
}

/** Stage: read the fields of one block. */
function readBlock(block: Block, index: number): UpiRecord {
  const rec: UpiRecord = {
    index, page: block.page, dateText: null, timeText: null, date: null, hasTime: false, description: '', counterparty: '', reference: '',
    bankName: null, accountLast4: null, accountRole: null, amountText: null, amountPaise: null, direction: 'unknown', transfer: false,
    evidence: [], confidence: 'low', reviewReasons: [], original: [...block.lines],
  };
  const descriptionParts: string[] = [];
  let sawIdLine = false;
  block.lines.forEach((line, i) => {
    let rest = line;
    const dm = i === 0 ? DATE_AT_START.exec(rest) : null;
    if (dm) { rec.dateText = clean(dm[0]); rec.date = parseDate(dm[1], dm[2], dm[3]); rest = clean(rest.slice(dm[0].length)); if (!rec.date) rec.reviewReasons.push('Uncertain date'); }
    const tm = TIME_AT_START.exec(rest);
    if (tm && rec.timeText === null) {
      rec.timeText = clean(tm[0]);
      const applied = rec.date ? applyTime(rec.date, tm) : null;
      if (applied?.ok) { rec.date = applied.date; rec.hasTime = true; } else if (applied) rec.reviewReasons.push('Uncertain time');
      rest = clean(rest.slice(tm[0].length));
    }
    if (!rest) return;
    const idm = ID_LINE.exec(rest);
    if (idm) {
      rec.reference ||= idm[1];
      sawIdLine = true;
      // the amount may share the id row when the description is on the row above
      const a = AMOUNT_AT_END.exec(rest.replace(ID_LINE, ' '));
      if (a && !rec.amountText) { rec.amountText = clean(a[0]); }
      return;
    }
    if (sawIdLine) {
      const ins = INSTRUMENT.exec(rest.replace(AMOUNT_AT_END, '').trim());
      if (ins && !rec.accountRole) {
        rec.accountRole = /^(?:paid\s+by|debited\s+from)/i.test(ins[1]) ? 'from' : 'to';
        rec.bankName = clean(ins[2]) || null;
        rec.accountLast4 = ins[3] ?? null;
        // "State Bank of India4823": the digits can be glued to the name when the extractor drops the space.
        if (!rec.accountLast4) { const g = /^(.*?[A-Za-z])(\d{4})$/.exec(rec.bankName ?? ''); if (g) { rec.bankName = clean(g[1]); rec.accountLast4 = g[2]; } }
        const a = AMOUNT_AT_END.exec(rest); if (a && !rec.amountText && i === 0) rec.amountText = clean(a[0]);
        return;
      }
    }
    if (i === 0 || descriptionParts.length === 0 || !sawIdLine) {
      // the amount is the last thing on the block's date row
      const a = i === 0 ? AMOUNT_AT_END.exec(rest) : null;
      let text = rest;
      if (a) { rec.amountText = clean(a[0]); text = clean(rest.slice(0, a.index)); }
      if (text) descriptionParts.push(text);
      return;
    }
    // a money-looking token on any other row cannot be tied to this payment with confidence
    if (AMOUNT_AT_END.test(rest)) rec.reviewReasons.push('Ambiguous transaction boundary');
    else rec.reviewReasons.push('Ambiguous description');
  });
  rec.description = clean(descriptionParts.join(' '));
  rec.amountPaise = rec.amountText ? parseAmountPaise(rec.amountText) : null;
  return rec;
}

/** Stage: direction from stated evidence. The description wording and the account line must agree. */
function classify(rec: UpiRecord): void {
  const d = rec.description;
  const wording: PdfDirection | null = WORDING_IN.test(d) ? 'income' : WORDING_OUT.test(d) ? 'expense' : WORDING_SELF.test(d) ? 'transfer'
    : WORDING_REFUND.test(d) ? 'refund' : WORDING_REVERSAL.test(d) ? 'reversal' : null;
  rec.counterparty = clean(d.replace(WORDING_IN, '').replace(WORDING_OUT, '').replace(WORDING_SELF, ''));
  if (WORDING_SELF.test(d)) rec.counterparty = clean(d.replace(/^self[\s-]*transfer(?:\s+to)?\s*/i, '')) || 'Own account';
  // what the account line says about the money: left the "from" account, or arrived in the "to" account
  const account: 'out' | 'in' | null = rec.accountRole === 'from' ? 'out' : rec.accountRole === 'to' ? 'in' : null;
  const wordingSide: 'out' | 'in' | null = wording === 'expense' ? 'out' : wording === 'income' || wording === 'refund' || wording === 'reversal' ? 'in' : null;

  if (wording) rec.evidence.push(`wording: "${clean(d).slice(0, 24)}"`);
  if (rec.accountRole) rec.evidence.push(`account line: ${rec.accountRole === 'from' ? 'paid by' : 'paid to'} your account`);

  if (wording === 'transfer') {
    // an own-account transfer is a transfer whichever way it points; it is excluded from income and expense
    rec.direction = 'transfer'; rec.transfer = true;
    rec.confidence = rec.accountRole ? 'high' : 'medium';
    return;
  }
  if (wording && account && wordingSide !== account) {
    rec.direction = 'unknown'; rec.confidence = 'low';
    rec.reviewReasons.push('Conflicting direction');
    return;
  }
  const side = wordingSide ?? account;
  if (!side) { rec.direction = 'unknown'; rec.confidence = 'low'; rec.reviewReasons.push('Unknown direction'); return; }
  rec.direction = wording ?? (side === 'in' ? 'income' : 'expense');
  rec.confidence = wording && account ? 'high' : 'medium';
  // refund / reversal wording inside an outgoing payment's name is not a refund: say so rather than guess
  if (rec.direction === 'expense' && /\brefund|\brevers/i.test(rec.counterparty)) rec.reviewReasons.push('Ambiguous description');
}

function validate(rec: UpiRecord, seenRefs: Set<string>): void {
  if (!rec.dateText) rec.reviewReasons.push('Missing date');
  else if (!rec.date) { /* "Uncertain date" already recorded */ }
  if (rec.amountPaise === null) rec.reviewReasons.push(rec.amountText ? 'Uncertain amount' : 'Missing amount');
  else if (rec.amountPaise <= 0) rec.reviewReasons.push('Uncertain amount');
  if (!rec.description) rec.reviewReasons.push('Ambiguous description');
  if (rec.reference) {
    if (seenRefs.has(rec.reference)) rec.reviewReasons.push('Duplicate reference');
    seenRefs.add(rec.reference);
  }
  rec.reviewReasons = [...new Set(rec.reviewReasons)];
}

/** Reasons that make a record unsafe to import at all: the amount, date or direction cannot be trusted. */
export const BLOCKING_REASONS = new Set(['Missing date', 'Uncertain date', 'Missing amount', 'Uncertain amount', 'Unknown direction', 'Conflicting direction', 'Ambiguous transaction boundary']);
export const isWithheld = (rec: UpiRecord): boolean => rec.reviewReasons.some((r) => BLOCKING_REASONS.has(r)) || rec.direction === 'unknown';

function reconcile(records: UpiRecord[], stated: StatementTotals): Reconciliation {
  let sent = 0; let received = 0; let withheldPaise = 0; let withheldCount = 0;
  for (const r of records) {
    if (isWithheld(r)) { withheldCount += 1; withheldPaise += r.amountPaise ?? 0; continue; }
    if (r.transfer) continue; // the statement excludes own-account transfers from its totals
    const paise = r.amountPaise ?? 0;
    if (r.direction === 'expense') sent += paise; else received += paise; // income, refund and reversal are all money in
  }
  const sentDiff = stated.sentPaise === null ? null : sent - stated.sentPaise;
  const receivedDiff = stated.receivedPaise === null ? null : received - stated.receivedPaise;
  const known = sentDiff !== null || receivedDiff !== null;
  const matched = known && (sentDiff ?? 0) === 0 && (receivedDiff ?? 0) === 0 && withheldCount === 0;
  const status: Reconciliation['status'] = !known ? 'no_statement_totals' : matched ? 'matched' : 'mismatch';
  const note = status === 'matched' ? 'Sent and received totals match the statement exactly.'
    : status === 'no_statement_totals' ? 'This statement does not print totals to check against.'
    : withheldCount ? `${withheldCount} record${withheldCount === 1 ? '' : 's'} could not be read with confidence, so the totals are incomplete.`
    : 'The totals do not match the statement. Review the records before relying on them.';
  return { status, stated, computed: { sentPaise: sent, receivedPaise: received }, sentDifferencePaise: sentDiff, receivedDifferencePaise: receivedDiff, withheldCount, withheldPaise, note };
}

/** Pages in, records out. `onPage` reports progress after each page's rows have been cut into blocks. */
export function parseUpiStatement(pages: string[][], onPage?: (page: number, total: number) => void): UpiParseResult {
  const { blocks, ignored, headerLines } = segment(pages.map((rows, i) => { onPage?.(i + 1, pages.length); return rows; }));
  const header = readHeader(headerLines);
  const seenRefs = new Set<string>();
  const records = blocks.map((b, i) => readBlock(b, i + 1));
  for (const r of records) { classify(r); validate(r, seenRefs); }
  const recordsPerPage = pages.map((_, i) => records.filter((r) => r.page === i + 1).length);
  return { records, periodStart: header.start, periodEnd: header.end, totals: header.totals, reconciliation: reconcile(records, header.totals), pagesSeen: pages.length, recordsPerPage, ignoredLines: ignored };
}

/** The ledger's two-way direction for a record (transfers keep the direction the money moved). */
export function ledgerDirection(rec: UpiRecord): Direction | null {
  if (rec.direction === 'income' || rec.direction === 'refund' || rec.direction === 'reversal') return 'income';
  if (rec.direction === 'expense') return 'expense';
  if (rec.direction === 'transfer') return rec.accountRole === 'to' ? 'income' : 'expense';
  return null;
}
