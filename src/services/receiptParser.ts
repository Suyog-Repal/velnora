/**
 * Extracts *suggestions* from OCR text of a receipt. Nothing here creates a transaction: the review screen always
 * shows the values for the user to confirm or correct. Missing/ambiguous values are reported, never invented.
 */
export interface ReceiptSuggestion {
  merchant: string | null;
  merchantCandidates: string[];
  amountPaise: number | null;
  /** True when several different totals were found and the largest was chosen: user must verify. */
  ambiguousTotal: boolean;
  /** Amounts seen on the receipt (largest first) so the user can tap the right one when no total was found. */
  amountCandidates: number[];
  date: string | null; // ISO instant (local midnight)
  currency: 'INR' | 'USD' | 'EUR' | 'GBP' | null;
  categoryHint: string | null;
  looksLikeReceipt: boolean;
  /** True when the date carried a time of day (otherwise the date is local midnight). */
  hasTime: boolean;
  /** Payment-app screenshots / bank slips: who was paid, who paid, direction and reference. Never guessed from thin air. */
  payee: string | null;
  payer: string | null;
  direction: 'expense' | 'income' | null;
  referenceId: string | null;
  paymentStatus: 'success' | 'failed' | 'pending' | null;
  isPaymentScreen: boolean;
}

const MONEY = /(?:₹|rs\.?|inr)?\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?)/gi;
const STRONG_TOTAL = /(grand\s*total|net\s*(?:amount|payable|total)|amount\s*(?:payable|due)|total\s*(?:amount|payable|due)|bill\s*amount|total\s*invoice\s*value|to\s*pay)/i;
const WEAK_TOTAL = /\btotal\b/i;
const NOT_TOTAL = /(sub\s*-?\s*total|total\s*(?:items?|qty|quantity|savings?|discount|tax|gst)|cgst|sgst|igst|vat|\btax\b|discount|saved|savings|change|tendered|cash\s*(?:given|paid)|round(?:ing)?\s*off|points|tip)/i;
const NOT_MERCHANT = /(invoice|receipt|bill\b|tax|gstin|gst\b|fssai|phone|ph[:.]|tel|mobile|www\.|\.com|date|time|welcome|thank|cashier|table|order|token|copy|duplicate|customer)/i;

const CATEGORY_HINTS: [RegExp, string][] = [
  [/(restaurant|cafe|café|mess|canteen|kitchen|biryani|pizza|burger|bakery|dhaba|tiffin|food|diner|eatery|sweets|juice|swiggy|zomato)/i, 'Food & Dining'],
  [/(supermarket|mart\b|grocer|kirana|provision|dmart|bigbasket|fresh|vegetable|fruit)/i, 'Groceries'],
  [/(pharmacy|chemist|medical|clinic|hospital|diagnostic|dental|apollo|medplus)/i, 'Health'],
  [/(petrol|fuel|diesel|uber|ola\b|rapido|metro|taxi|cab\b|parking|toll)/i, 'Transportation'],
  [/(cinema|movie|pvr|inox|theatre|gaming|amusement)/i, 'Entertainment'],
  [/(book|stationery|school|college|tuition|academy)/i, 'Education'],
  [/(salon|spa\b|parlour|parlor|barber|beauty)/i, 'Personal Care'],
];

function toPaise(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return null;
  return Math.round(n * 100);
}

/** Removes dates, times, ids and phone-like tokens so they are never mistaken for money. */
function stripNonMoney(line: string): string {
  return line
    .replace(/\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, ' ')
    .replace(/\b[A-Z0-9]*\d[A-Z0-9]*[A-Z][A-Z0-9]*\b/g, ' ')
    .replace(/\b\d{8,}\b/g, ' ');
}

/** `strict`: only numbers with decimals or a currency marker (used for loose candidates); total lines accept plain integers. */
function amountsIn(line: string, strict = false): number[] {
  const out: number[] = [];
  for (const m of stripNonMoney(line).matchAll(MONEY)) {
    if (strict && !/[.₹]|rs|inr/i.test(m[0])) continue;
    const p = toPaise(m[1]);
    if (p !== null) out.push(p);
  }
  return out;
}

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_INDEX: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const monthOf = (name: string): number | undefined => MONTH_INDEX[name.slice(0, 3).toLowerCase()];
const NOT_A_BILL_DATE = /(exp(?:iry|ires)?|valid(?:\s*(?:till|until|upto|thru))?|due\s*date|best\s*before|use\s*by|mfg|manufactur|batch)/i;

/** OCR often reads 0 as O and 1 as l/I inside numbers; fix those inside date-shaped tokens only. */
function fixOcrDigits(line: string): string {
  return line.replace(/(?<![A-Za-z])[0-9OolI|]{1,4}(?:[/\-.][0-9OolI|]{1,4}){2}(?![A-Za-z])/g, (t) => t.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1'));
}

function validDate(y: number, m: number, d: number, now: Date): Date | null {
  if (y < 100) y += 2000;
  const date = new Date(y, m, d);
  if (date.getFullYear() !== y || date.getMonth() !== m || date.getDate() !== d) return null;
  if (y < 2000 || date.getTime() > now.getTime() + 24 * 3600 * 1000) return null;
  return date;
}

function numericDate(a: number, b: number, y: number, now: Date): Date | null {
  // Day-first (Indian convention) unless the numbers prove month-first.
  if (a > 12 && b <= 12) return validDate(y, b - 1, a, now);
  if (b > 12 && a <= 12) return validDate(y, a - 1, b, now);
  return validDate(y, b - 1, a, now);
}

interface DateHit { date: Date; keyword: boolean; line: number }

function datesInLine(raw: string, now: Date): Date[] {
  const line = fixOcrDigits(raw);
  const out: Date[] = [];
  const push = (d: Date | null) => { if (d) out.push(d); };
  for (const m of line.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) push(validDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), now));
  for (const m of line.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g)) push(numericDate(Number(m[1]), Number(m[2]), Number(m[3]), now));
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s,.\\-]*${MONTH_RE}\\.?[\\s,.\\-']*(\\d{4}|\\d{2})\\b`, 'gi');
  for (const m of line.matchAll(dayMonth)) { const mo = monthOf(m[2]); if (mo !== undefined) push(validDate(Number(m[3]), mo, Number(m[1]), now)); }
  const monthDay = new RegExp(`\\b${MONTH_RE}\\.?[\\s,.\\-]*(\\d{1,2})(?:st|nd|rd|th)?[\\s,.\\-']*(\\d{4})\\b`, 'gi');
  for (const m of line.matchAll(monthDay)) { const mo = monthOf(m[1]); if (mo !== undefined) push(validDate(Number(m[3]), mo, Number(m[2]), now)); }
  return out;
}

function timeNear(lines: string[], at: number): { h: number; m: number } | null {
  for (const i of [at, at + 1, at + 2, at - 1]) {
    const line = lines[i];
    if (!line) continue;
    const t = /\b(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*([AaPp])\.?\s*[Mm]?\.?/.exec(line) ?? /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/.exec(line);
    if (!t) continue;
    let h = Number(t[1]); const m = Number(t[2]);
    const ap = t[3]?.toLowerCase();
    if (ap) { if (h < 1 || h > 12) continue; h = (h % 12) + (ap === 'p' ? 12 : 0); }
    if (h > 23 || m > 59) continue;
    return { h, m };
  }
  return null;
}

function findDate(lines: string[], now: Date): { iso: string; hasTime: boolean } | null {
  const hits: DateHit[] = [];
  lines.forEach((line, i) => {
    if (NOT_A_BILL_DATE.test(line)) return;
    const keyword = /\b(date|dt|billed|invoice|paid\s+on|completed|transaction\s+(?:date|time)|on)\b/i.test(line);
    for (const date of datesInLine(line, now)) hits.push({ date, keyword, line: i });
  });
  if (hits.length === 0) return null;
  const pick = hits.find((h) => h.keyword) ?? hits[0];
  const t = timeNear(lines, pick.line);
  const d = new Date(pick.date.getFullYear(), pick.date.getMonth(), pick.date.getDate(), t?.h ?? 0, t?.m ?? 0);
  return { iso: d.toISOString(), hasTime: t !== null };
}

function findMerchants(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines.slice(0, 8)) {
    const line = raw.replace(/[|*_=#~]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (line.length < 3 || line.length > 50) continue;
    const letters = (line.match(/\p{L}/gu) ?? []).length;
    const digits = (line.match(/\d/g) ?? []).length;
    if (letters < 3 || digits > letters / 2) continue;
    if (NOT_MERCHANT.test(line)) continue;
    out.push(line);
    if (out.length === 3) break;
  }
  return out;
}

const PAYEE_STRONG = /^(?:paid\s+to|payment\s+to|sent\s+to|transferred\s+to|money\s+sent\s+to|payee|beneficiary)\b\s*[:\-]?\s*(.*)$/i;
const PAYEE_WEAK = /^(?:to|merchant)\b\s*[:\-]?\s*(.*)$/i; // only trusted on payment screenshots
const PAYER_STRONG = /^(?:received\s+from|money\s+received\s+from|paid\s+by|credited\s+by|payer|sender)\b\s*[:\-]?\s*(.*)$/i;
const PAYER_WEAK = /^from\b\s*[:\-]?\s*(.*)$/i; // only trusted on payment screenshots
const PAYMENT_SIGNS = /(paid\s+to|payment\s+(?:successful|completed|to)|sent\s+to|received\s+from|money\s+(?:sent|received)|upi\s*(?:ref|transaction|id)|\butr\b|transaction\s+id|banking\s+name)/i;
const REF_RE = /(?:upi\s*(?:ref(?:erence)?)?|utr|txn|transaction|ref(?:erence)?)\s*(?:no\.?|number|id)?\s*[:#\-]?\s*((?=[A-Z0-9]{8,22}\b)[A-Z0-9]*\d[A-Z0-9]*)\b/i;

/** Clean a person/merchant name captured after "Paid to": drop UPI ids, phone numbers, bank suffixes and noise. */
function cleanName(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = raw.replace(/\S+@\S+/g, ' ').replace(/[+]?\d[\d\s-]{6,}/g, ' ').replace(/[|*_=#~]+/g, ' ').replace(/\s+/g, ' ').trim();
  const letters = (name.match(/\p{L}/gu) ?? []).length;
  if (name.length < 2 || name.length > 60 || letters < 2) return null;
  if (/^(you|your|account|bank|upi|ref|transaction|payment|successful|completed|rs|inr)$/i.test(name)) return null;
  return name;
}

/** Name is either on the same line ("Paid to Ravi Kumar") or on the next line ("Paid to" / "Ravi Kumar"). */
function nameAfter(lines: string[], re: RegExp): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const same = cleanName(m[1]);
    if (same) return same;
    if (!m[1]) { const next = cleanName(lines[i + 1]); if (next && !PAYMENT_SIGNS.test(lines[i + 1])) return next; }
  }
  return null;
}

export function parseReceiptText(text: string, now: Date = new Date()): ReceiptSuggestion {
  const lines = (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const empty: ReceiptSuggestion = { merchant: null, merchantCandidates: [], amountPaise: null, ambiguousTotal: false, amountCandidates: [], date: null, currency: null, categoryHint: null, looksLikeReceipt: false, hasTime: false, payee: null, payer: null, direction: null, referenceId: null, paymentStatus: null, isPaymentScreen: false };
  if (lines.length === 0) return empty;

  const joined = lines.join('\n');
  const isPaymentScreen = PAYMENT_SIGNS.test(joined);

  const strong: number[] = []; const weak: number[] = []; const all: number[] = [];
  lines.forEach((line, i) => {
    const amounts = amountsIn(line);
    all.push(...amountsIn(line, true));
    if (NOT_TOTAL.test(line) && !STRONG_TOTAL.test(line)) return;
    const isStrong = STRONG_TOTAL.test(line);
    const isWeak = !isStrong && WEAK_TOTAL.test(line);
    if (!isStrong && !isWeak) return;
    // value on the same line, otherwise on the next line (common for OCR of columnar receipts)
    const values = amounts.length ? amounts : amountsIn(lines[i + 1] ?? '');
    if (values.length) (isStrong ? strong : weak).push(values[values.length - 1]);
  });

  const pool = strong.length ? strong : weak;
  const distinct = [...new Set(pool)];
  let amountPaise = distinct.length ? Math.max(...distinct) : null;
  let ambiguousTotal = distinct.length > 1;
  if (amountPaise === null && isPaymentScreen) {
    // Payment apps show the amount alone, prefixed by the currency symbol. Use the first marked amount; the user still confirms.
    for (const line of lines) {
      const marked = /(?:₹|rs\.?|inr)\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?)/i.exec(stripNonMoney(line));
      const p = marked ? toPaise(marked[1]) : null;
      if (p !== null) { amountPaise = p; break; }
    }
    ambiguousTotal = false;
  }

  const currency: ReceiptSuggestion['currency'] = /₹|\brs\.?\s*\d|\binr\b/i.test(joined) ? 'INR' : /\$/.test(joined) ? 'USD' : /€/.test(joined) ? 'EUR' : /£/.test(joined) ? 'GBP' : null;

  const payee = nameAfter(lines, PAYEE_STRONG) ?? (isPaymentScreen ? nameAfter(lines, PAYEE_WEAK) : null);
  const payer = nameAfter(lines, PAYER_STRONG) ?? (isPaymentScreen ? nameAfter(lines, PAYER_WEAK) : null);
  let direction: ReceiptSuggestion['direction'] = null;
  if (/(received\s+from|money\s+received|credited\s+by|received\s+by\s+you)/i.test(joined)) direction = 'income';
  else if (/(paid\s+to|payment\s+to|sent\s+to|money\s+sent|transferred\s+to)/i.test(joined)) direction = 'expense';
  const refMatch = REF_RE.exec(joined);
  const referenceId = refMatch && /\d/.test(refMatch[1]) ? refMatch[1] : null;
  const paymentStatus: ReceiptSuggestion['paymentStatus'] = /(failed|declined|unsuccessful|rejected)/i.test(joined) ? 'failed'
    : /(pending|processing|in\s+progress)/i.test(joined) ? 'pending'
      : /(success|completed|paid)/i.test(joined) ? 'success' : null;

  const merchantCandidates = [...new Set([...(direction === 'income' ? [payer] : [payee]), ...findMerchants(lines)].filter((x): x is string => !!x))].slice(0, 4);
  const merchant = merchantCandidates[0] ?? null;
  const found = findDate(lines, now);
  const hint = CATEGORY_HINTS.find(([re]) => re.test(merchant ?? '') || re.test(joined.slice(0, 400)));
  const looksLikeReceipt = amountPaise !== null || (all.length >= 2 && merchant !== null);

  return {
    merchant,
    merchantCandidates,
    amountPaise,
    ambiguousTotal,
    amountCandidates: [...new Set(all)].sort((a, b) => b - a).slice(0, 4),
    date: found?.iso ?? null,
    hasTime: found?.hasTime ?? false,
    currency,
    categoryHint: hint ? hint[1] : null,
    looksLikeReceipt,
    payee, payer, direction, referenceId, paymentStatus, isPaymentScreen,
  };
}

/** Stable key used to warn about the same receipt being entered twice (same merchant, same total, same day). */
export function receiptFingerprint(merchantKey: string, amountPaise: number, isoDate: string): string {
  const day = new Date(isoDate);
  const value = `${merchantKey}|${amountPaise}|${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `rcpt-${(hash >>> 0).toString(16)}`;
}
