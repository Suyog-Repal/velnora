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

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function validDate(y: number, m: number, d: number, now: Date): Date | null {
  if (y < 100) y += 2000;
  const date = new Date(y, m, d);
  if (date.getFullYear() !== y || date.getMonth() !== m || date.getDate() !== d) return null;
  if (y < 2000 || date.getTime() > now.getTime() + 24 * 3600 * 1000) return null;
  return date;
}

function findDate(lines: string[], now: Date): string | null {
  const found: { date: Date; keyword: boolean }[] = [];
  for (const line of lines) {
    const keyword = /date|dt[:.]|billed|invoice/i.test(line);
    for (const m of line.matchAll(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/g)) {
      const d = validDate(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), Number(m[2]) - 1, Number(m[1]), now);
      if (d) found.push({ date: d, keyword });
    }
    for (const m of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
      const d = validDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), now);
      if (d) found.push({ date: d, keyword });
    }
    for (const m of line.matchAll(/\b(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s,-]+(\d{2,4})\b/g)) {
      const mon = MONTHS[m[2].toLowerCase()];
      if (mon === undefined) continue;
      const d = validDate(Number(m[3].length === 2 ? `20${m[3]}` : m[3]), mon, Number(m[1]), now);
      if (d) found.push({ date: d, keyword });
    }
  }
  if (found.length === 0) return null;
  const pick = found.find((f) => f.keyword) ?? found[0];
  return pick.date.toISOString();
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

export function parseReceiptText(text: string, now: Date = new Date()): ReceiptSuggestion {
  const lines = (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const empty: ReceiptSuggestion = { merchant: null, merchantCandidates: [], amountPaise: null, ambiguousTotal: false, amountCandidates: [], date: null, currency: null, categoryHint: null, looksLikeReceipt: false };
  if (lines.length === 0) return empty;

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
  const amountPaise = distinct.length ? Math.max(...distinct) : null;
  const joined = lines.join('\n');
  const currency: ReceiptSuggestion['currency'] = /₹|\brs\.?\s*\d|\binr\b/i.test(joined) ? 'INR' : /\$/.test(joined) ? 'USD' : /€/.test(joined) ? 'EUR' : /£/.test(joined) ? 'GBP' : null;
  const merchantCandidates = findMerchants(lines);
  const merchant = merchantCandidates[0] ?? null;
  const date = findDate(lines, now);
  const hint = CATEGORY_HINTS.find(([re]) => re.test(merchant ?? '') || re.test(joined.slice(0, 400)));
  const looksLikeReceipt = amountPaise !== null || (all.length >= 2 && merchant !== null);

  return {
    merchant,
    merchantCandidates,
    amountPaise,
    ambiguousTotal: distinct.length > 1,
    amountCandidates: [...new Set(all)].sort((a, b) => b - a).slice(0, 4),
    date,
    currency,
    categoryHint: hint ? hint[1] : null,
    looksLikeReceipt,
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
