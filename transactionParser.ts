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
};

export type SmsReceivedPayload = {
  sender: string;
  receivedAt: number;
  partCount: number;
  body: string;
};

export type ParsedSmsTransaction = {
  status: SmsTransactionStatus;
  direction: SmsDirection;
  amount: number;
  merchant: string;
  transactionDate: string;
  bankSender: string;
  referenceId: string;
  fingerprint: string;
};

export const DEFAULT_SMS_RULE: SmsParsingRule = {
  senderPattern: '^[A-Z0-9 -]{4,30}$',
  successPatterns: ['successful', 'successfully', 'debited', 'credited', 'paid', 'received'],
  pendingPatterns: ['pending', 'processing', 'awaiting'],
  failedPatterns: ['failed', 'declined', 'unsuccessful', 'reversed', 'cancelled'],
  debitPatterns: ['debited', 'paid', 'spent', 'purchase', 'sent', 'transferred to'],
  creditPatterns: ['credited', 'received', 'deposited', 'transferred from'],
  amountPattern: '(?:INR|Rs\\.?|\\u20B9)\\s*([\\d,]+(?:\\.\\d{1,2})?)|([\\d,]+(?:\\.\\d{1,2})?)\\s*(?:INR|Rs\\.?|\\u20B9)',
  merchantPattern: "(?:at|to|from|merchant|beneficiary)\\s+([A-Za-z0-9][A-Za-z0-9 &.'/-]{1,80}?)(?=\\s+(?:on|at|for|ref|txn|utr|ending|via)\\b|[.,;]|$)",
  referencePattern: '(?:ref(?:erence)?|txn|transaction|utr|id)\\s*(?:no\\.?|number|id)?\\s*[:#-]?\\s*([A-Z0-9-]{6,})',
  datePattern: '(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:AM|PM)?)?)',
};

const escapeForFingerprint = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

function firstMatch(body: string, pattern: string): string | null {
  const match = new RegExp(pattern, 'i').exec(body);
  return match?.slice(1).find(Boolean)?.trim() ?? null;
}

function includesPattern(body: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, 'i').test(body));
}

export function classifySmsStatus(body: string, rule: SmsParsingRule = DEFAULT_SMS_RULE): SmsTransactionStatus {
  if (includesPattern(body, rule.failedPatterns)) return 'failed';
  if (includesPattern(body, rule.pendingPatterns)) return 'pending';
  if (includesPattern(body, rule.successPatterns)) return 'success';
  return 'ambiguous';
}

function parseDate(value: string | null, receivedAt: number): string {
  if (!value) return new Date(receivedAt).toISOString();
  const normalized = value.replace(/-/g, '/');
  const parts = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(.*))?$/);
  if (!parts) return new Date(receivedAt).toISOString();
  const year = Number(parts[3].length === 2 ? `20${parts[3]}` : parts[3]);
  const parsed = new Date(`${year}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}T${parts[4] ?? '00:00'}:00`);
  return Number.isNaN(parsed.getTime()) ? new Date(receivedAt).toISOString() : parsed.toISOString();
}

function fingerprint(input: Pick<ParsedSmsTransaction, 'amount' | 'direction' | 'merchant' | 'transactionDate' | 'bankSender'>): string {
  const value = [input.amount.toFixed(2), input.direction, input.merchant, input.transactionDate, input.bankSender]
    .map(escapeForFingerprint)
    .join('|');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sms-${(hash >>> 0).toString(16)}`;
}

export function parseSmsTransaction(
  sms: SmsReceivedPayload,
  rules: SmsParsingRule[] = [DEFAULT_SMS_RULE],
): ParsedSmsTransaction | null {
  const rule = rules.find((candidate) => new RegExp(candidate.senderPattern, 'i').test(sms.sender));
  if (!rule || !sms.body.trim()) return null;

  const status = classifySmsStatus(sms.body, rule);
  if (status !== 'success') return null;

  const direction: SmsDirection | null = includesPattern(sms.body, rule.debitPatterns)
    ? 'expense'
    : includesPattern(sms.body, rule.creditPatterns)
      ? 'income'
      : null;
  const amountValue = firstMatch(sms.body, rule.amountPattern)?.replace(/,/g, '');
  const amount = amountValue ? Number(amountValue) : NaN;
  const merchant = firstMatch(sms.body, rule.merchantPattern);
  const referenceId = firstMatch(sms.body, rule.referencePattern);
  if (!direction || !Number.isFinite(amount) || amount <= 0 || !merchant || !referenceId) return null;

  const transactionDate = parseDate(firstMatch(sms.body, rule.datePattern), sms.receivedAt);
  const parsed: ParsedSmsTransaction = { status, direction, amount, merchant, transactionDate, bankSender: sms.sender, referenceId, fingerprint: '' };
  parsed.fingerprint = fingerprint(parsed);
  return parsed;
}
