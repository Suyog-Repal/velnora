/**
 * Reminding someone about an expected payment. Pure and read-only: nothing here records a payment, a settlement or a
 * transaction, and nothing leaves the device until the person sends the message themselves.
 */
import { isOverdue, outstandingPaise, type ExpectedPayment } from './expectedPaymentService.ts';
import type { Contact } from './splitService.ts';
import { buildExpectedReminderMessage, greetingName, noPhoneNote, whatsAppNumber } from './upiLinks.ts';

/** Only money still owed TO the person: never for what they owe someone else, never once settled. */
export const canRemind = (e: ExpectedPayment): boolean => e.direction === 'receive' && e.status === 'pending' && outstandingPaise(e) > 0;

/** The standard message, without the optional sign-off. */
export function expectedReminderBody(e: ExpectedPayment, upiId: string | null, now: Date = new Date()): string {
  return buildExpectedReminderMessage({
    name: e.person, amountPaise: outstandingPaise(e), reason: e.note, overdueSince: isOverdue(e, now) ? e.due_date : null, upiId,
  });
}

export interface ReminderPhone {
  /** The number to open a chat with, or null to let WhatsApp ask. */
  phone: string | null;
  /** What to tell the person when there is no number to use. */
  note: string | null;
}

/**
 * The phone of the friend this expected payment is about, matched by the same name key the Friend sheet uses. Two friends of
 * that name with different numbers are ambiguous: no chat is guessed.
 */
export function reminderPhone(contacts: Pick<Contact, 'name_key' | 'phone'>[], e: Pick<ExpectedPayment, 'person' | 'person_key'>): ReminderPhone {
  const numbers = new Map<string, string>();
  for (const c of contacts) {
    const number = c.name_key === e.person_key ? whatsAppNumber(c.phone) : null;
    if (number) numbers.set(number, c.phone!);
  }
  if (numbers.size === 1) return { phone: [...numbers.values()][0], note: null };
  if (numbers.size === 0) return { phone: null, note: noPhoneNote(e.person) };
  return { phone: null, note: `More than one friend called ${greetingName(e.person)} has a number: WhatsApp will ask you to choose the chat.` };
}
