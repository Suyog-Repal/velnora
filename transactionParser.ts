import { suggestCategory, type KindForCategory } from './src/services/transactionClassifier.ts';

export type SmsTransactionStatus = 'success' | 'pending' | 'failed' | 'ambiguous';
export type SmsDirection = 'income' | 'expense';

export type SmsParsingRule = {
  senderPattern: string;
  successPatterns: string[];
  pendingPatterns: string[];
  failedPatterns: string[];
  debitPatterns: string[];
  creditPatterns: string[];
  amountPattern: string;
  merchantPattern: string;
  referencePattern: string;
  datePattern: string;
  /** Messages that mention a debit/credit but are NOT a completed transaction (future debits, dues, requests). */
  ignorePatterns?: string[];
};

export type SmsReceivedPayload = {
  sender: string;
  receivedAt: number;
  partCount: number;
  body: string;
  /** Which channel observed it; absent = plain SMS. For notifications `sender` is the notification title. */
  source?: 'sms' | 'truecaller_notification' | 'payment_notification';
  /** Display name of the payment app that posted the notification ("Google Pay"). Says nothing about the bank. */
  sourceApp?: string;
};

export type ParsedPaymentMethod = 'UPI' | 'Card' | 'Cash' | 'Net banking';

export type ParsedSmsTransaction = {
  status: SmsTransactionStatus;
  direction: SmsDirection;
  amount: number;
  merchant: string;
  transactionDate: string;
  bankSender: string;
  /** Bank reference / UTR when the SMS carries one; '' when it does not (many alerts have none). */
  referenceId: string;
  fingerprint: string;
  /**
   * Source-independent identity of the bank event (no sender label, which differs between the raw SMS "AX-HDFCBK-S"
   * and Truecaller's "HDFC Bank"). Present only when the message itself pins the event down (a stated time, or a
   * date plus balance); '' otherwise. Used to recognise the same event arriving via SMS and via a notification.
   */
  eventKey: string;
  /** Epoch ms the message reached the device; the basis for matching events that carry no stated time. */
  receivedAt: number;
  /** Extras read from the message (no schema change; shown in the description / payment method). */
  accountLast4?: string;
  balance?: number;
  paymentMethod?: ParsedPaymentMethod;
  kind: KindForCategory;
  /** Default-category suggestion for this message. */
  category: string;
  /** Only set when the sender or the text names a bank. A payment app is never treated as a bank. */
  bankName?: string;
  paymentApp?: string;
  /** 0..1: how much of the transaction the message actually pinned down. */
  confidence: number;
};

const AMOUNT = '(?:\\bINR|\\bRs\\.?|\\u20B9)\\s*([\\d,]+(?:\\.\\d{1,2})?)|([\\d,]+(?:\\.\\d{1,2})?)\\s*(?:INR|Rs\\.?|\\u20B9)';
const DEFAULT_MERCHANT = "(?:at|to|from|merchant|beneficiary)\\s+([A-Za-z0-9][A-Za-z0-9 &.'/-]{1,80}?)(?=\\s+(?:on|at|for|ref|txn|utr|ending|via)\\b|[.,;]|$)";
const DEFAULT_REFERENCE = '(?:ref(?:erence)?|txn|transaction|utr|id)\\s*(?:no\\.?|number|id)?\\s*[:#-]?\\s*([A-Z0-9-]{6,})';
const DEFAULT_DATE = '(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:AM|PM)?)?)';

export const DEFAULT_SMS_RULE: SmsParsingRule = {
  senderPattern: '^[A-Z0-9 -]{4,30}$',
  successPatterns: ['successful', 'successfully', 'debited', 'credited', 'paid', 'received', 'withdrawn', 'spent', 'deposited', 'transferred', 'sent', 'purchase', '\\bdebit\\b(?!\\s+card)', '\\bcredit\\b(?!\\s+card)', 'withdrawal', '\\brefund(?:ed)?\\b'],
  pendingPatterns: ['pending', 'processing', 'awaiting'],
  failedPatterns: ['failed', 'declined', 'unsuccessful', 'reversed', 'cancelled', 'rejected', 'insufficient (?:funds|balance)', 'not (?:been )?(?:processed|completed)'],
  // "debit card" / "credit card" are not transactions by themselves, so the bare words are excluded when followed by "card".
  debitPatterns: ['\\bdebit(?:ed)?\\b(?!\\s+card)', 'withdrawn', 'withdrawal', '\\bspent\\b', '\\bpurchase(?:d)?\\b', '\\bpaid\\b', '\\bsent\\b', 'transferred to', '\\btrf to\\b'],
  creditPatterns: ['\\bcredit(?:ed)?\\b(?!\\s+card)', 'deposited', '\\breceived\\b', '\\brefund(?:ed)?\\b', 'transferred from', '\\btrf from\\b'],
  amountPattern: AMOUNT,
  merchantPattern: DEFAULT_MERCHANT,
  referencePattern: DEFAULT_REFERENCE,
  datePattern: DEFAULT_DATE,
  ignorePatterns: [
    '\\bwill be (?:debited|charged|deducted|auto-?debited)\\b',
    '\\b(?:is|are|has been) (?:due|overdue)\\b',
    '\\b(?:payment|amount|bill) due\\b',
    '\\bdue (?:on|by|date)\\b',
    '\\b(?:e-?mandate|mandate) (?:request|registered)\\b',
    '\\bpayment (?:request|link|reminder)\\b',
    '\\brequested? (?:you )?(?:to pay|money)\\b',
    '\\bpre-?approved\\b',
    '\\brequest(?:ed|ing|s)?\\b[^.]{0,30}(?:\\u20B9|\\bRs\\.?|\\bINR)',
    // Promised, not yet received: the credit message that follows is the transaction.
    '\\bwill be (?:credited|refunded|reversed)\\b',
    '\\brefund\\b[^.]{0,30}\\b(?:initiated|requested)\\b',
  ],
};

// ───────────────────────── messages that are never transactions ─────────────────────────

const SAFETY_ADVICE = /\b(?:never|do not|don'?t|dont)\s+share\b[^.]*/gi;
const OTP_WORD = '(?:otp|one[- ]time[- ](?:password|pin)|verification code|security code|passcode)';
const OTP_MESSAGES = [
  new RegExp(`\\b${OTP_WORD}\\b[^.]{0,40}?\\b\\d{4,8}\\b`, 'i'),
  new RegExp(`\\b\\d{4,8}\\b[^.]{0,30}?\\b${OTP_WORD}\\b`, 'i'),
  new RegExp(`\\b(?:use|enter)\\b[^.]{0,20}\\b${OTP_WORD}\\b`, 'i'),
];

/** An authentication code. Alerts that merely add "never share your OTP" as advice are not one. */
export function isOtpMessage(body: string): boolean {
  const text = body.replace(SAFETY_ADVICE, ' ');
  return OTP_MESSAGES.some((pattern) => pattern.test(text));
}

const PROMO = /\b(?:apply now|click here|t&c|tnc|limited (?:period|time)|offer|win|won|voucher|coupon|upgrade|eligible|flat \d+%|\d+% off|up to (?:₹|rs\.?|inr)|upto (?:₹|rs\.?|inr)|loan of|instant loan|get (?:₹|rs\.?|inr|flat|up))\b/i;
const COMPLETED_ON_ACCOUNT = /\b(?:a\/c|acct?|account|card)\b[^.]{0,40}\b(?:is |has been |was )?(?:debited|credited)\b|\b(?:debited|credited)\b[^.]{0,40}\b(?:a\/c|acct?|account|card)\b/i;

/** Marketing that borrows transaction words. A message stating a completed movement on an account is not rejected. */
export function isPromotionalMessage(body: string): boolean {
  return PROMO.test(body) && !COMPLETED_ON_ACCOUNT.test(body);
}

// ───────────────────────── bank / app evidence ─────────────────────────

const BANK_SENDERS: [RegExp, string][] = [
  [/HDFC/i, 'HDFC Bank'], [/^SBI|SBIINB|SBIUPI|SBIPSG|ATMSBI|CBSSBI/i, 'SBI'], [/ICICI/i, 'ICICI Bank'], [/AXIS/i, 'Axis Bank'],
  [/KOTAK/i, 'Kotak Bank'], [/^PNB|PNBSMS/i, 'PNB'], [/BOBTXN|BOBSMS|^BOB/i, 'Bank of Baroda'], [/CANBNK|CANARA/i, 'Canara Bank'],
  [/IDFC/i, 'IDFC First Bank'], [/YESBNK|YESBANK/i, 'Yes Bank'], [/UNIONB/i, 'Union Bank'], [/INDUSB/i, 'IndusInd Bank'], [/FEDBNK|FEDERAL/i, 'Federal Bank'],
];
const BANK_IN_TEXT: [RegExp, string][] = [
  [/\bHDFC\b/i, 'HDFC Bank'], [/\bSBI\b|State Bank of India/i, 'SBI'], [/\bICICI\b/i, 'ICICI Bank'], [/\bAxis Bank\b/i, 'Axis Bank'],
  [/\bKotak\b/i, 'Kotak Bank'], [/\bPNB\b|Punjab National/i, 'PNB'], [/Bank of Baroda/i, 'Bank of Baroda'], [/Canara Bank/i, 'Canara Bank'],
  [/\bIDFC\b/i, 'IDFC First Bank'], [/\bYes Bank\b/i, 'Yes Bank'], [/Union Bank/i, 'Union Bank'], [/IndusInd/i, 'IndusInd Bank'], [/Federal Bank/i, 'Federal Bank'],
];

function identifyBank(sender: string, body: string, source: SmsReceivedPayload['source']): string | undefined {
  // A notification's sender label is an app or a free-text title, so only the wording can name a bank there.
  if (source !== 'payment_notification') {
    const fromSender = BANK_SENDERS.find(([pattern]) => pattern.test(cleanSenderLabel(sender)));
    if (fromSender) return fromSender[1];
  }
  return BANK_IN_TEXT.find(([pattern]) => pattern.test(body))?.[1];
}

export const REVERSAL_DONE = /\b(?:reversed|reversal)\b/i;
export const REVERSAL_FUTURE = /\bwill be\b[^.]{0,30}\b(?:reversed|refunded|credited)\b|\breversal (?:is )?(?:pending|initiated)\b/i;
const CREDIT_TO_YOU = /\b(?:paid|sent|transferred)\s+you\b|\byou(?:'ve| have)?\s+received\b/i;
const OWN_TRANSFER = /\b(?:self[- ]transfer|to self|own account|between your accounts)\b/i;
const REFUND = /\brefund(?:ed)?\b/i;
const CASH = /\bATM\b|\bcash withdrawal\b|\bwithdrawn\b/i;

function detectKind(body: string, isReversal: boolean): KindForCategory {
  if (isReversal) return 'reversal';
  if (REFUND.test(body)) return 'refund';
  if (OWN_TRANSFER.test(body)) return 'transfer';
  if (CASH.test(body)) return 'cash_withdrawal';
  return 'payment';
}

const escapeForFingerprint = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

function firstMatch(body: string, pattern: string): string | null {
  const match = new RegExp(pattern, 'i').exec(body);
  return match?.slice(1).find(Boolean)?.trim() ?? null;
}

function includesPattern(body: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, 'i').test(body));
}

/** Index of the earliest match of any pattern, or -1. */
function earliestIndex(body: string, patterns: string[]): number {
  let best = -1;
  for (const pattern of patterns) {
    const m = new RegExp(pattern, 'i').exec(body);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

export function classifySmsStatus(body: string, rule: SmsParsingRule = DEFAULT_SMS_RULE): SmsTransactionStatus {
  if (includesPattern(body, rule.failedPatterns)) return 'failed';
  if (includesPattern(body, rule.pendingPatterns)) return 'pending';
  if (includesPattern(body, rule.successPatterns)) return 'success';
  return 'ambiguous';
}

// ───────────────────────── amount & balance ─────────────────────────

type AmountHit = { value: number; index: number; kind: 'txn' | 'balance' | 'other' };

/** Every currency amount in the message, labelled so a trailing "Avl Bal Rs 12,345" is never mistaken for the payment. */
function extractAmounts(body: string, rule: SmsParsingRule): AmountHit[] {
  const out: AmountHit[] = [];
  for (const m of body.matchAll(new RegExp(rule.amountPattern, 'gi'))) {
    const raw = m.slice(1).find(Boolean)?.replace(/,/g, '');
    const value = raw ? Number(raw) : NaN;
    if (!Number.isFinite(value)) continue;
    const before = body.slice(Math.max(0, (m.index ?? 0) - 32), m.index ?? 0);
    let kind: AmountHit['kind'] = 'txn';
    if (/\b(?:bal(?:ance)?|avl|avail(?:able)?)\b[^.]{0,24}$/i.test(before)) kind = 'balance';
    else if (/\b(?:limit|lmt|outstanding|due|min(?:imum)?)\b[^.]{0,24}$/i.test(before)) kind = 'other';
    out.push({ value, index: m.index ?? 0, kind });
  }
  // Some banks (e.g. SBI) omit the currency symbol: "debited by 250.0", "credited with 5000.00".
  if (!out.some((a) => a.kind === 'txn')) {
    const bare = /\b(?:debited|credited|debit|credit)\s*(?:by|with|for|of)\s*([\d,]+(?:\.\d{1,2})?)\b/i.exec(body);
    const value = bare ? Number(bare[1].replace(/,/g, '')) : NaN;
    if (Number.isFinite(value)) out.unshift({ value, index: bare?.index ?? 0, kind: 'txn' });
  }
  return out;
}

// ───────────────────────── date ─────────────────────────

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function localDate(y: number, m: number, d: number, h = 0, mi = 0, s = 0): Date | null {
  const out = new Date(y, m, d, h, mi, s);
  return out.getFullYear() === y && out.getMonth() === m && out.getDate() === d && h < 24 && mi < 60 && s < 60 ? out : null;
}

function readTime(rest: string): { h: number; mi: number; s: number } | null {
  const t = /^\s*(?:at|,|:|-|@)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(rest);
  if (!t) return null;
  let h = Number(t[1]);
  const meridiem = t[4]?.toUpperCase();
  if (meridiem === 'PM' && h < 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return { h, mi: Number(t[2]), s: Number(t[3] ?? 0) };
}

/** Finds the first calendar date in the message: 12-Nov-26, 12Nov26, 12 November 2026, 12/11/26, 12-11-2026, 2026-11-12, 12.11.2026. */
function findDate(body: string, receivedAt: number): Date | null {
  const recv = new Date(receivedAt);
  const withYear = (yearText: string | undefined, m: number, d: number): number => {
    if (yearText) return Number(yearText.length === 2 ? `20${yearText}` : yearText);
    // no year in the SMS: assume the year it was received, or the previous one if that would be in the future
    const candidate = localDate(recv.getFullYear(), m, d);
    return candidate && candidate.getTime() > receivedAt + 36 * 3600_000 ? recv.getFullYear() - 1 : recv.getFullYear();
  };
  const finish = (y: number, m: number, d: number, end: number): Date | null => {
    const time = readTime(body.slice(end));
    return localDate(y, m, d, time?.h ?? 0, time?.mi ?? 0, time?.s ?? 0) ;
  };

  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(body);
  if (m) { const r = finish(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m.index + m[0].length); if (r) return r; }

  m = /\b(\d{1,2})[-/ ]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:[-/ ,']*(\d{4}|\d{2})(?!\d))?/i.exec(body);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    const r = finish(withYear(m[3], month, Number(m[1])), month, Number(m[1]), m.index + m[0].length);
    if (r) return r;
  }

  m = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/.exec(body) ?? /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/.exec(body);
  if (m) { const r = finish(withYear(m[3], Number(m[2]) - 1, Number(m[1])), Number(m[2]) - 1, Number(m[1]), m.index + m[0].length); if (r) return r; }
  return null;
}

/** Legacy path for custom rules that supply their own datePattern (same output contract as before, minus the time-string bug). */
function parseCustomDate(value: string | null, receivedAt: number): Date | null {
  if (!value) return null;
  const parts = value.replace(/-/g, '/').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(.*))?$/);
  if (!parts) return null;
  const time = parts[4] ? readTime(` ${parts[4]}`) : null;
  return localDate(Number(parts[3].length === 2 ? `20${parts[3]}` : parts[3]), Number(parts[2]) - 1, Number(parts[1]), time?.h ?? 0, time?.mi ?? 0, time?.s ?? 0);
}

/** `iso` is the stored timestamp; `precision` says how much of it the SMS itself actually stated (used for duplicate detection). */
function resolveTransactionDate(body: string, receivedAt: number, rule: SmsParsingRule): { iso: string; precision: 'time' | 'day' | 'arrival'; day: string } {
  const custom = rule.datePattern !== DEFAULT_DATE;
  const found = (custom ? parseCustomDate(firstMatch(body, rule.datePattern), receivedAt) : null) ?? findDate(body, receivedAt);
  const recv = new Date(receivedAt);
  const dayOf = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const arrival = { iso: recv.toISOString(), precision: 'arrival' as const, day: dayOf(recv) };
  if (!found) return arrival;
  // A date outside a sane window is a mis-read (e.g. dd/mm vs mm/dd): trust the delivery time instead.
  if (found.getTime() > receivedAt + 36 * 3600_000 || found.getTime() < receivedAt - 400 * 86400_000) return arrival;
  const dateOnly = found.getHours() === 0 && found.getMinutes() === 0 && found.getSeconds() === 0;
  if (!dateOnly) return { iso: found.toISOString(), precision: 'time', day: dayOf(found) };
  // Date without a time on the day the SMS arrived: store the arrival time so same-day transactions keep their order.
  const sameDay = found.getFullYear() === recv.getFullYear() && found.getMonth() === recv.getMonth() && found.getDate() === recv.getDate();
  return { iso: (sameDay ? recv : found).toISOString(), precision: 'day', day: dayOf(found) };
}

// ───────────────────────── reference, account, balance, payment method ─────────────────────────

export function extractReference(body: string, rule: SmsParsingRule = DEFAULT_SMS_RULE): string {
  if (rule.referencePattern !== DEFAULT_REFERENCE) return firstMatch(body, rule.referencePattern) ?? '';
  const candidates = [
    /\bUPI[/-](?:DR|CR|P2A|P2M|P2P)?[/-]?(\d{9,})/i,
    /\bUPI[:\s]+(\d{9,})/i,
    /\b(?:NEFT|RTGS|IMPS)[-/]([A-Z0-9]{8,})/i,
    /\b(?:ref(?:erence)?|refno|ref\.?\s*no|txn|transaction|utr|rrn|trn|imps)\b\.?\s*(?:no\.?|number|id)?\s*[:#.-]?\s*([A-Z0-9][A-Z0-9-]{5,})/i,
  ];
  for (const pattern of candidates) {
    const m = pattern.exec(body);
    const value = m?.[1]?.replace(/[-.]+$/, '');
    // a reference always contains a digit ("Ref: Shop" is not one)
    if (value && /\d/.test(value)) return value;
  }
  return '';
}

function extractAccountLast4(body: string): string | undefined {
  const m = /\b(?:a\/c|acct?\.?|account|card)\s*(?:no\.?|number|ending(?:\s+(?:with|in))?)?\s*[:-]?\s*(?:[Xx*]+|\.{2,})?\s*(\d{3,})\b/i.exec(body);
  return m ? m[1].slice(-4) : undefined;
}

function extractBalance(body: string): number | undefined {
  const m = /\b(?:avl\.?|avail(?:able)?|closing|clear|total)?\s*bal(?:ance)?\b\s*(?:is|:|-|of)?\s*(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(body);
  const value = m ? Number(m[1].replace(/,/g, '')) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

function detectPaymentMethod(body: string): ParsedPaymentMethod | undefined {
  if (/\bATM\b|withdrawn|withdrawal/i.test(body)) return 'Cash';
  if (/\bUPI\b|[\w.-]+@[a-z]{2,}\b/i.test(body)) return 'UPI';
  if (/\bcard\b|\bPOS\b/i.test(body)) return 'Card';
  if (/\b(?:NEFT|IMPS|RTGS|net\s?banking)\b/i.test(body)) return 'Net banking';
  return undefined;
}

/** "AX-HDFCBK-S" -> "HDFCBK": drops the 2-letter route prefix and the one-letter category suffix. */
export function cleanSenderLabel(sender: string): string {
  return sender.trim().replace(/^[A-Z]{2}-/i, '').replace(/-[A-Z]$/i, '').trim() || sender.trim();
}

// ───────────────────────── counterparty (merchant / payer) ─────────────────────────

const ACCOUNTISH = /^(?:a\/c|acct?|account|your|you|xx+|\*+|card|bank|the|a|an|my|number|no|rs|inr)\b/i;
const NAME_STOP = /\s+(?:on|at|for|ref|refno|reference|txn|utr|rrn|upi|via|using|thru|through|ending|avl|bal|balance|a\/c|acct|no|not|if|call|dated|dt|with|is|has|was|will|info|msg|towards|from)\b.*$/i;

function cleanName(raw: string): string | null {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.split(/[(\[,;]/)[0];                       // "RAHUL (UPI Ref ...)" -> "RAHUL"
  s = s.split(/(?<=[A-Za-z]{3})\.(?:\s|$)/)[0];    // sentence end after a word
  s = s.replace(NAME_STOP, '');
  s = s.replace(/^[\s.,;:\-*_/]+|[\s.,;:\-*_/]+$/g, '').slice(0, 60).trim();
  if (s.length < 2) return null;
  if (ACCOUNTISH.test(s) || /^[Xx*\d\s-]+$/.test(s) || /^\d{1,2}[:/-]\d/.test(s)) return null;
  if (/^(?:ATM|POS|UPI|IMPS|NEFT|RTGS|ECS|NACH)$/i.test(s)) return null; // a payment channel, not a counterparty
  return s;
}

function nameFromVpa(vpa: string): string {
  const local = vpa.split('@')[0];
  return /^\d+$/.test(local) ? vpa : local;
}

const EXPENSE_NAME_PATTERNS: RegExp[] = [
  /[;,]\s*([A-Za-z0-9][A-Za-z0-9 &.'-]{1,40}?)\s+credited\b/gi,              // ICICI: "...debited for Rs 500; ZOMATO credited."
  /\b(?:trf|transfer(?:red)?|paid|sent|payment|pmt|remitted)\s+to\s+(?!A\/c|acct|account|your)(.{2,80})/gi,
  /\b(?:at|@)\s+(?!A\/c|acct|account|your|ATM\b)(.{2,80})/gi,
  /\bto\s+(?!A\/c|acct|account|your)(.{2,80})/gi,
  /\btowards\s+(.{2,80})/gi,
  /\b(?:merchant|beneficiary|payee)\s*[:-]?\s*(.{2,80})/gi,
];
const INCOME_NAME_PATTERNS: RegExp[] = [
  /\b(?:received|transferred|trf|credited|deposited|sent|remitted)\s+(?:by|from)\s+(?!A\/c|acct|account|your)(.{2,80})/gi,
  /\bfrom\s+(?!A\/c|acct|account|your)(.{2,80})/gi,
  /\bby\s+(?!UPI\b|NEFT|IMPS|RTGS|transfer|cash|cheque|chq|clearing|ECS|NACH|Rs\b|INR|₹|ref|\d)(.{2,80})/gi,
  /\b(?:sender|remitter)\s*[:-]?\s*(.{2,80})/gi,
];

function extractCounterparty(body: string, direction: SmsDirection, sender: string, rule: SmsParsingRule): string {
  // a custom rule that supplies its own merchant pattern wins
  if (rule.merchantPattern !== DEFAULT_MERCHANT) {
    const custom = firstMatch(body, rule.merchantPattern);
    if (custom) return custom;
  }
  const vpaTo = /\b(?:to|paid to|sent to|trf to)\s+(?:VPA\s+)?([\w.-]{2,}@[A-Za-z]{2,})/i.exec(body);
  const vpaFrom = /\b(?:from|by)\s+(?:VPA\s+)?([\w.-]{2,}@[A-Za-z]{2,})/i.exec(body);
  const vpa = direction === 'expense' ? vpaTo : vpaFrom;
  if (vpa) return nameFromVpa(vpa[1]);

  // Payment-app wording: "Asha Rao paid you ₹500".
  if (direction === 'income') {
    const payer = /^\s*([A-Za-z][A-Za-z .'&-]{1,40}?)\s+(?:paid|sent|transferred)\s+you\b/i.exec(body);
    const name = payer ? cleanName(payer[1]) : null;
    if (name) return name;
  }

  // Path-style narrations: UPI/P2M/412345678901/AMAZON, UPI-412345678901-RAHUL KUMAR-ICIC0001, NEFT-N123456789-ACME CORP LTD-SALARY
  const narration =
    /\bUPI\/(?:DR|CR|P2A|P2M|P2P)?\/?\d{6,}\/([A-Za-z][^/,;\n]{1,40})/i.exec(body) ??
    /\b(?:UPI|NEFT|RTGS|IMPS)-[A-Z0-9]{6,}-([A-Za-z][^-/,;\n]{1,40})/i.exec(body) ??
    /\b(?:NEFT|RTGS|IMPS)\/[A-Z0-9]{6,}\/([A-Za-z][^/,;\n]{1,40})/i.exec(body);
  const fromNarration = narration ? cleanName(narration[1]) : null;
  if (fromNarration) return fromNarration;

  for (const pattern of direction === 'expense' ? EXPENSE_NAME_PATTERNS : INCOME_NAME_PATTERNS) {
    for (const m of body.matchAll(pattern)) {
      const name = cleanName(m[1]);
      if (name) return name;
    }
  }
  const legacy = firstMatch(body, DEFAULT_MERCHANT);
  const legacyName = legacy ? cleanName(legacy) : null;
  if (legacyName) return legacyName;

  // No name in the message: still record the payment, labelled by what it was.
  if (/\bATM\b|withdrawn|withdrawal/i.test(body)) return 'ATM withdrawal';
  if (/\bUPI\b/i.test(body)) return direction === 'expense' ? 'UPI payment' : 'UPI credit';
  if (/\bcard\b|\bPOS\b/i.test(body)) return 'Card payment';
  return `${cleanSenderLabel(sender)} ${direction === 'expense' ? 'debit' : 'credit'}`;
}

// ───────────────────────── fingerprint & parse ─────────────────────────

function fingerprint(
  input: Pick<ParsedSmsTransaction, 'amount' | 'direction' | 'merchant' | 'transactionDate' | 'bankSender' | 'accountLast4' | 'balance' | 'referenceId'>,
  when: { precision: 'time' | 'day' | 'arrival'; day: string },
): string {
  // The same alert delivered twice (duplicate broadcast, restart, another sender route) must collapse to one record,
  // so the key uses only what the SMS itself states: its time (to the minute) if it has one; otherwise its date, as long
  // as the alert also carries a balance or reference that tells two same-day purchases apart; only a message with
  // none of those falls back to its arrival minute. The sender is route-independent (AX-HDFCBK-S == VM-HDFCBK).
  const dateKey = when.precision === 'time' ? input.transactionDate.slice(0, 16)
    : when.precision === 'day' && (input.balance !== undefined || input.referenceId) ? `day:${when.day}`
      : input.transactionDate.slice(0, 16);
  const value = [input.amount.toFixed(2), input.direction, input.merchant, dateKey, cleanSenderLabel(input.bankSender), input.accountLast4 ?? '', input.balance?.toFixed(2) ?? '']
    .map(escapeForFingerprint)
    .join('|');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sms-${(hash >>> 0).toString(16)}`;
}

function eventKey(
  input: Pick<ParsedSmsTransaction, 'amount' | 'direction' | 'merchant' | 'transactionDate' | 'accountLast4' | 'balance'>,
  when: { precision: 'time' | 'day' | 'arrival'; day: string },
): string {
  const strong = when.precision === 'time' || (when.precision === 'day' && input.balance !== undefined);
  if (!strong) return '';
  const dateKey = when.precision === 'time' ? input.transactionDate.slice(0, 16) : `day:${when.day}`;
  const value = [input.amount.toFixed(2), input.direction, input.merchant, dateKey, input.accountLast4 ?? '', input.balance?.toFixed(2) ?? '']
    .map(escapeForFingerprint)
    .join('|');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ev-${(hash >>> 0).toString(16)}`;
}

export function parseSmsTransaction(
  sms: SmsReceivedPayload,
  rules: SmsParsingRule[] = [DEFAULT_SMS_RULE],
): ParsedSmsTransaction | null {
  const rule = rules.find((candidate) => new RegExp(candidate.senderPattern, 'i').test(sms.sender));
  if (!rule) return null;
  const body = sms.body.replace(/\s+/g, ' ').trim();
  if (!body) return null;

  if (isOtpMessage(body) || isPromotionalMessage(body)) return null;

  // Money that already came back is a completed credit, even though the wording overlaps with failed payments.
  const isReversal = REVERSAL_DONE.test(body) && !REVERSAL_FUTURE.test(body);
  const status: SmsTransactionStatus = isReversal ? 'success' : classifySmsStatus(body, rule);
  if (status !== 'success') return null;
  if (rule.ignorePatterns && includesPattern(body, rule.ignorePatterns)) return null;

  // Direction = whichever of the debit / credit words appears FIRST ("credited ... sent by X" is a credit).
  const debitAt = earliestIndex(body, rule.debitPatterns);
  const creditAt = earliestIndex(body, rule.creditPatterns);
  const forcedCredit = isReversal || REFUND.test(body) || CREDIT_TO_YOU.test(body);
  // "Payment of ₹250 to Swiggy successful" (payment apps) names no debit word, but it is money going out.
  const paymentOut = /\bpayment\b[^.]{0,40}\bsuccessful(?:ly)?\b/i.test(body);
  const direction: SmsDirection | null = forcedCredit ? 'income'
    : debitAt === -1 && creditAt === -1 ? (paymentOut ? 'expense' : null)
      : creditAt === -1 || (debitAt !== -1 && debitAt < creditAt) ? 'expense' : 'income';

  const amounts = extractAmounts(body, rule);
  const amount = (amounts.find((a) => a.kind === 'txn') ?? { value: NaN }).value;
  if (!direction || !Number.isFinite(amount) || amount <= 0) return null;

  const balance = extractBalance(body) ?? amounts.find((a) => a.kind === 'balance')?.value;
  const accountLast4 = extractAccountLast4(body);
  const merchant = extractCounterparty(body, direction, sms.sender, rule);
  const referenceId = extractReference(body, rule);
  const when = resolveTransactionDate(body, sms.receivedAt, rule);
  const paymentMethod = detectPaymentMethod(body);

  const kind = detectKind(body, isReversal);
  const bankName = identifyBank(sms.sender, body, sms.source);
  const namedMerchant = !/^(?:upi payment|upi credit|card payment|atm withdrawal|.+ (?:debit|credit))$/i.test(merchant);
  const confidence = Math.min(1, 0.4 + (referenceId ? 0.2 : 0) + (accountLast4 ? 0.15 : 0) + (when.precision !== 'arrival' ? 0.15 : 0) + (namedMerchant ? 0.1 : 0));

  const parsed: ParsedSmsTransaction = {
    status, direction, amount, merchant, transactionDate: when.iso, bankSender: sms.sender, referenceId, fingerprint: '', eventKey: '', receivedAt: sms.receivedAt,
    kind, category: suggestCategory({ merchant, body, direction, kind }), confidence,
  };
  if (bankName) parsed.bankName = bankName;
  if (sms.sourceApp) parsed.paymentApp = sms.sourceApp;
  if (accountLast4) parsed.accountLast4 = accountLast4;
  if (balance !== undefined) parsed.balance = balance;
  if (paymentMethod) parsed.paymentMethod = paymentMethod;
  parsed.fingerprint = fingerprint(parsed, when);
  parsed.eventKey = eventKey(parsed, when);
  return parsed;
}
