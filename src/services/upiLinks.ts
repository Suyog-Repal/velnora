/**
 * Everything that turns a balance into something to send: the UPI link, the reminder text, and the WhatsApp links.
 * Pure and built on the device. Nothing here touches the network, and nothing from it is ever synced.
 */

/** "Rs 1,25,000" / "Rs 450.50": Indian digit grouping, no trailing .00. Locale independent (the same on every device). */
export function formatRupees(paise: number): string {
  const neg = paise < 0; const abs = Math.abs(Math.round(paise));
  const whole = String(Math.floor(abs / 100)); const frac = abs % 100;
  const last3 = whole.slice(-3); const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}Rs ${grouped}${frac ? `.${String(frac).padStart(2, '0')}` : ''}`;
}

/** 45050 -> "450.50", 45000 -> "450.00" (the amount format UPI links use). */
export const upiAmount = (paise: number): string => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;

export interface UpiLinkInput {
  /** Payee UPI ID (name@bank). */
  pa: string;
  /** Payee name shown by the UPI app. */
  pn?: string | null;
  /** Amount in paise; omit for a link without an amount. */
  amountPaise?: number | null;
  /** Short note shown to the payer. */
  note?: string | null;
}

const enc = (v: string) => encodeURIComponent(v).replace(/%40/g, '@');

/** upi://pay?pa=<id>&pn=<name>&am=<amount>&cu=INR&tn=<note>. Returns null if there is no payee id. */
export function buildUpiLink(i: UpiLinkInput): string | null {
  const pa = i.pa?.trim();
  if (!pa) return null;
  const parts = [`pa=${enc(pa)}`, `pn=${encodeURIComponent((i.pn?.trim() || pa).slice(0, 60))}`];
  if (i.amountPaise && i.amountPaise > 0) parts.push(`am=${upiAmount(i.amountPaise)}`);
  parts.push('cu=INR');
  const tn = i.note?.trim().replace(/\s+/g, ' ').slice(0, 50);
  if (tn) parts.push(`tn=${encodeURIComponent(tn)}`);
  return `upi://pay?${parts.join('&')}`;
}

export interface ReminderInput {
  /** The friend's name. */
  name: string;
  /** What it is for: a group name, or "our shared expenses". */
  forWhat: string;
  amountPaise: number;
  /** The owner's UPI ID and ready-made link, when saved. */
  upiId?: string | null;
  upiLink?: string | null;
  signature?: boolean;
}

/** The name a message greets someone by. */
export const greetingName = (name: string): string => name.trim().split(/\s+/)[0] || name;

/** Adds the optional sign-off, so an edited message can carry it too. */
export const withSignature = (message: string, signature?: boolean): string => (signature ? `${message}\nSent from Velnora` : message);

/** How to pay, as far as the owner has saved it. Nothing when there is neither. */
function paymentLines(upiId?: string | null, upiLink?: string | null): string[] {
  if (upiLink) return [...(upiId ? [`UPI ID: ${upiId}`] : []), `Pay here: ${upiLink}`];
  return upiId ? [`You can pay on UPI: ${upiId}`] : [];
}

/** "Hey Asha, your share for Goa trip is Rs 450. Pay here: upi://...". Plain, friendly, no emoji. */
export function buildReminderMessage(i: ReminderInput): string {
  const lines = [`Hey ${greetingName(i.name)}, your share for ${i.forWhat} is ${formatRupees(i.amountPaise)}.`, ...paymentLines(i.upiId, i.upiLink)];
  return withSignature(lines.join('\n'), i.signature);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-05" -> "5 Nov 2026" (the same on every device); anything else is returned unchanged. */
export function formatDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : ymd;
}

export interface ExpectedReminderInput {
  name: string;
  /** What is still owed: the total minus what has been paid. */
  amountPaise: number;
  /** The person's own words for what it is for. */
  reason?: string | null;
  /** The due date (YYYY-MM-DD), only when it has passed. */
  overdueSince?: string | null;
  /** The owner's UPI ID, when saved. */
  upiId?: string | null;
  signature?: boolean;
}

/** A reminder for money someone is expected to pay: "Hey Asha, a friendly reminder that Rs 450 is still pending for Dinner." */
export function buildExpectedReminderMessage(i: ExpectedReminderInput): string {
  const reason = (i.reason ?? '').replace(/\s+/g, ' ').trim().replace(/^for\s+/i, '').replace(/[.\s]+$/, '');
  const lines = [`Hey ${greetingName(i.name)}, a friendly reminder that ${formatRupees(i.amountPaise)} is still pending${reason ? ` for ${reason}` : ''}.`];
  if (i.overdueSince) lines.push(`It has been overdue since ${formatDay(i.overdueSince)}.`);
  lines.push(...paymentLines(i.upiId));
  return withSignature(lines.join('\n'), i.signature);
}

/** Shown wherever a reminder is sent to someone without a saved number. */
export const noPhoneNote = (name: string): string => `No phone saved for ${greetingName(name)}: WhatsApp will ask you to choose the chat.`;

/**
 * Digits for wa.me / whatsapp://: a bare 10-digit Indian mobile number gets 91 in front; anything with a country code is kept.
 * Returns null when it cannot be a phone number.
 */
export function whatsAppNumber(phone?: string | null): string | null {
  const digits = (phone ?? '').replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
  return digits;
}

export interface WhatsAppLinks { app: string; web: string }
export function whatsAppLinks(text: string, phone?: string | null): WhatsAppLinks {
  const n = whatsAppNumber(phone);
  const q = `text=${encodeURIComponent(text)}`;
  return { app: `whatsapp://send?${n ? `phone=${n}&` : ''}${q}`, web: `https://wa.me/${n ?? ''}?${q}` };
}

export type WhatsAppOutcome = 'app' | 'web' | 'share' | 'failed';
export interface WhatsAppDeps { open(url: string): Promise<unknown>; share(text: string): Promise<unknown> }

/**
 * Opens WhatsApp with the text ready. Tries the app, then the wa.me link, then the system share sheet (WhatsApp not installed).
 * Deep links can carry text only, never an image; the QR is shared separately.
 */
export async function sendOnWhatsApp(text: string, phone: string | null | undefined, deps: WhatsAppDeps): Promise<WhatsAppOutcome> {
  const links = whatsAppLinks(text, phone);
  try { await deps.open(links.app); return 'app'; } catch { /* not installed, or blocked */ }
  try { await deps.open(links.web); return 'web'; } catch { /* no browser either */ }
  try { await deps.share(text); return 'share'; } catch { return 'failed'; }
}

export type QrChoice = 'generated' | 'saved' | 'none';

/**
 * Which QR the settle-up sheet shows: a generated one (it carries the amount) whenever a UPI ID is saved, unless the owner switched to
 * their own saved picture; the saved picture alone when there is no UPI ID (it carries no amount, so the payer types it); nothing otherwise.
 */
export function qrChoice(o: { hasUpiId: boolean; hasSavedQr: boolean; useSaved: boolean }): QrChoice {
  if (o.hasUpiId && o.hasSavedQr) return o.useSaved ? 'saved' : 'generated';
  if (o.hasUpiId) return 'generated';
  if (o.hasSavedQr) return 'saved';
  return 'none';
}
