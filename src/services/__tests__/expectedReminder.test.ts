/**
 * Reminders for expected payments: the message, who it is sent to, when it is offered, that sending records nothing, and that
 * the existing Expected behaviour is unchanged. All people and IDs are invented.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import type { IDatabase } from '../../db/types.ts';
import { canRemind, expectedReminderBody, reminderPhone } from '../expectedReminder.ts';
import { createExpected, expectedBadge, getExpected, markSettled, recordPayment, recordPaymentWithTransaction, summarizeExpected, type ExpectedPayment } from '../expectedPaymentService.ts';
import { createContact, deleteContact, listContacts } from '../splitService.ts';
import { buildExpectedReminderMessage, formatDay, noPhoneNote, sendOnWhatsApp, withSignature } from '../upiLinks.ts';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed += 1; console.log(`✓ ${name}`); };
const fresh = async () => { const db = new NodeSqliteAdapter() as unknown as IDatabase; await runMigrations(db); return db; };
const NOW = new Date(2026, 10, 20, 12, 0, 0);
const item = (over: Partial<ExpectedPayment> = {}): ExpectedPayment => ({
  id: 'e1', user_id: null, person: 'Asha Rao', person_key: 'asha rao', direction: 'receive', amount_paise: 100000, paid_paise: 0, note: 'Dinner split',
  due_date: null, status: 'pending', settled_at: null, payments: [], created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...over,
});

await test('the message: friendly, first name, amount still owed and the reason; it works with no payment details', () => {
  assert.equal(expectedReminderBody(item(), null, NOW), 'Hey Asha, a friendly reminder that Rs 1,000 is still pending for Dinner split.');
  assert.equal(expectedReminderBody(item({ note: null }), null, NOW), 'Hey Asha, a friendly reminder that Rs 1,000 is still pending.');
  assert.equal(expectedReminderBody(item({ note: '  for   the  trip.  ' }), null, NOW), 'Hey Asha, a friendly reminder that Rs 1,000 is still pending for the trip.', 'no "for for", no double full stop');
  assert.equal(expectedReminderBody(item({ note: '   ' }), null, NOW), 'Hey Asha, a friendly reminder that Rs 1,000 is still pending.');
});

await test('partial payments: only what is still owed is asked for', () => {
  assert.match(expectedReminderBody(item({ paid_paise: 35050 }), null, NOW), /that Rs 649\.50 is still pending/);
  assert.match(expectedReminderBody(item({ paid_paise: 99999 }), null, NOW), /that Rs 0\.01 is still pending/);
  assert.doesNotMatch(expectedReminderBody(item({ paid_paise: 35050 }), null, NOW), /1,000/);
});

await test('overdue wording appears only once the date has passed', () => {
  assert.equal(expectedReminderBody(item({ due_date: '2026-11-05' }), null, NOW),
    'Hey Asha, a friendly reminder that Rs 1,000 is still pending for Dinner split.\nIt has been overdue since 5 Nov 2026.');
  for (const due_date of ['2026-11-20', '2026-12-01', null]) assert.doesNotMatch(expectedReminderBody(item({ due_date }), null, NOW), /overdue/i, String(due_date));
  assert.equal(formatDay('2026-01-31'), '31 Jan 2026'); assert.equal(formatDay('soon'), 'soon');
});

await test('the UPI ID is included when saved, as plain text with no link; the sign-off is optional', () => {
  const text = expectedReminderBody(item({ due_date: '2026-11-05' }), 'me@upi', NOW);
  assert.ok(text.endsWith('\nYou can pay on UPI: me@upi'), text);
  assert.doesNotMatch(text, /upi:\/\/|%20/);
  assert.equal(withSignature(text, false), text);
  assert.equal(withSignature(text, true), `${text}\nSent from Velnora`);
  assert.ok(buildExpectedReminderMessage({ name: 'Asha', amountPaise: 100, signature: true }).endsWith('\nSent from Velnora'));
});

await test('long names and reasons stay readable and whole', () => {
  assert.match(expectedReminderBody(item({ person: 'Venkatanarasimharajuvaripeta Subramanian Iyer' }), null, NOW), /^Hey Venkatanarasimharajuvaripeta, /);
  const single = 'A'.repeat(80); const reason = 'r'.repeat(200);
  const text = expectedReminderBody(item({ person: single, note: reason, amount_paise: 1_000_000_000 }), null, NOW);
  assert.ok(text.startsWith(`Hey ${single}, `) && text.includes(`for ${reason}.`) && text.includes('Rs 1,00,00,000'));
  assert.match(expectedReminderBody(item({ person: '  Ravi  ' }), null, NOW), /^Hey Ravi, /);
});

await test('offered only for money still owed to me', () => {
  assert.equal(canRemind(item()), true);
  assert.equal(canRemind(item({ paid_paise: 1 })), true);
  assert.equal(canRemind(item({ direction: 'pay' })), false, 'I owe them');
  assert.equal(canRemind(item({ status: 'settled', paid_paise: 100000 })), false);
  assert.equal(canRemind(item({ paid_paise: 100000 })), false, 'nothing left');
});

await test('the phone comes from a friend with the same name key, as the Friend sheet matches', async () => {
  const db = await fresh();
  const expected = await createExpected(db, null, { person: 'asha  rao', amountPaise: 100 });
  const phone = async () => reminderPhone(await listContacts(db, null), expected);
  assert.deepEqual(await phone(), { phone: null, note: noPhoneNote('asha') });
  await createContact(db, null, { name: 'Asha Rao' });
  assert.equal((await phone()).phone, null, 'a friend without a phone');
  await createContact(db, null, { name: 'Bala', phone: '+919800000009' });
  await createContact(db, 'someone-else', { name: 'Asha Rao', phone: '+919800000008' });
  assert.equal((await phone()).phone, null, 'another name, or another account, never matches');
  const withPhone = await createContact(db, null, { name: 'Asha Rao', phone: '+919800000001' });
  assert.deepEqual(await phone(), { phone: '+919800000001', note: null });
  const same = await createContact(db, null, { name: 'asha rao', phone: '9800000001' });
  assert.equal((await phone()).note, null, 'the same number written two ways is one number');
  await deleteContact(db, null, same.id);
  await createContact(db, null, { name: 'Asha Rao', phone: '+919800000002' });
  const two = await phone();
  assert.equal(two.phone, null, 'two different numbers: no chat is guessed'); assert.match(two.note!, /More than one friend called asha/);
  await deleteContact(db, null, withPhone.id);
  assert.equal((await phone()).phone, '+919800000002', 'a deleted friend is ignored');
});

await test('sending a reminder records nothing', async () => {
  const db = await fresh();
  const contact = await createContact(db, null, { name: 'Asha', phone: '9800000001' });
  const expected = await createExpected(db, null, { person: 'Asha', amountPaise: 45000, note: 'Rent share', dueDate: '2026-11-05' });
  const snapshot = async () => JSON.stringify(await Promise.all(['expected_payments', 'transactions', 'settlements', 'sync_queue']
    .map((table) => db.getAllAsync(`SELECT * FROM ${table} ORDER BY id`))));
  const before = await snapshot();
  const opened: string[] = [];
  const { phone } = reminderPhone([contact], expected);
  assert.equal(await sendOnWhatsApp(expectedReminderBody(expected, 'me@upi', NOW), phone, { async open(url) { opened.push(url); }, async share() {} }), 'app');
  assert.ok(opened[0].startsWith('whatsapp://send?phone=919800000001&text=Hey%20Asha'), opened[0]);
  assert.equal(await snapshot(), before);
  for (const file of ['../expectedReminder.ts', '../../screens/ExpectedReminder.tsx', '../../screens/Reminder.tsx']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /recordPayment|recordSettlement|settleWithFriend|markSettled|addTransaction|createExpected|updateExpected|runAsync/, file);
  }
});

await test('existing Expected behaviour is unchanged: partial, full, with a transaction, and what I owe', async () => {
  const db = await fresh();
  const owedToMe = await createExpected(db, null, { person: 'Asha', amountPaise: 50000 });
  const iOwe = await createExpected(db, null, { person: 'Bala', amountPaise: 20000, direction: 'pay' });
  const part = await recordPayment(db, null, owedToMe.id, { amountPaise: 20000 });
  assert.deepEqual([part.status, part.paid_paise, canRemind(part)], ['pending', 20000, true]);
  assert.match(expectedReminderBody(part, null, NOW), /Rs 300 is still pending/);
  const done = await markSettled(db, null, owedToMe.id);
  assert.deepEqual([done.status, done.paid_paise, canRemind(done)], ['settled', 50000, false]);
  assert.equal((await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM transactions'))!.n, 0, 'recording by hand adds no transaction');
  await recordPaymentWithTransaction(db, null, iOwe.id, { amountPaise: 20000 });
  assert.deepEqual({ ...(await db.getFirstAsync<object>('SELECT direction, amount_paise FROM transactions')) }, { direction: 'expense', amount_paise: 20000 });
  assert.equal((await getExpected(db, null, iOwe.id))!.status, 'settled');
});

await test('the Expected tab dot: present while anything is pending, in either direction, and spoken with its count', () => {
  const badge = (items: ExpectedPayment[]) => expectedBadge(summarizeExpected(items, NOW));
  assert.equal(badge([]), undefined);
  assert.equal(badge([item({ status: 'settled' })]), undefined);
  assert.equal(badge([item()]), '1 pending');
  assert.equal(badge([item(), item({ id: 'e2', direction: 'pay' }), item({ id: 'e3', status: 'settled' })]), '2 pending');
});

console.log(`${passed} passed`);
