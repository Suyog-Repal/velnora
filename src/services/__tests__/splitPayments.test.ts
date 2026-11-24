/**
 * Payment details, UPI link, reminder text, WhatsApp links and the QR matrix. All local: nothing here may reach the sync queue.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import type { IDatabase } from '../../db/types.ts';
import { deleteUserLocalData } from '../localDataService.ts';
import { claimGuestPaymentDetails, getPaymentDetails, paymentKeys, removePaymentQr, replacePaymentQr, savePaymentDetails, type QrFilePort } from '../paymentDetails.ts';
import { SELF, SplitError } from '../splitMath.ts';
import { createContact, createGroup, createSplitExpense, recordSettlement } from '../splitService.ts';
import { buildReminderMessage, buildUpiLink, formatRupees, qrChoice, sendOnWhatsApp, upiAmount, whatsAppLinks, whatsAppNumber } from '../upiLinks.ts';
import { qrMatrix, qrPath } from '../upiQr.ts';

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => { await fn(); passed += 1; console.log(`✓ ${name}`); };
const fresh = async () => { const db = new NodeSqliteAdapter() as unknown as IDatabase; await runMigrations(db); return db; };
const rejectsSplit = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof SplitError && re.test(e.message));

function fakeFiles() {
  const files = new Set<string>(); let n = 0; const removed: string[] = [];
  const port: QrFilePort = {
    async importImage(src, scope) { const p = `/docs/payment/qr-${scope ?? 'guest'}-${++n}.jpg`; files.add(p); void src; return p; },
    async remove(path) { files.delete(path); removed.push(path); },
  };
  return { port, files, removed };
}

await test('rupee formatting: Indian grouping, no float drift, no trailing .00', () => {
  assert.equal(formatRupees(45000), 'Rs 450'); assert.equal(formatRupees(12_500_000), 'Rs 1,25,000'); assert.equal(formatRupees(12_500_050), 'Rs 1,25,000.50');
  assert.equal(formatRupees(7), 'Rs 0.07'); assert.equal(formatRupees(1_000_000_000), 'Rs 1,00,00,000'); assert.equal(formatRupees(99_999), 'Rs 999.99'); assert.equal(formatRupees(0), 'Rs 0');
  assert.equal(upiAmount(45050), '450.50'); assert.equal(upiAmount(45000), '450.00'); assert.equal(upiAmount(5), '0.05');
});

await test('UPI link: pa, pn, am, cu, tn in that order; amount optional; encoded safely', () => {
  assert.equal(buildUpiLink({ pa: 'asha@okbank', pn: 'Asha Rao', amountPaise: 45000, note: 'Goa trip' }), 'upi://pay?pa=asha@okbank&pn=Asha%20Rao&am=450.00&cu=INR&tn=Goa%20trip');
  assert.equal(buildUpiLink({ pa: 'asha@okbank' }), 'upi://pay?pa=asha@okbank&pn=asha%40okbank&cu=INR', 'name falls back to the id; no amount when none given');
  assert.equal(buildUpiLink({ pa: ' ' }), null);
  assert.equal(buildUpiLink({ pa: 'a@b', pn: 'R&D <x>', amountPaise: 1, note: 'a&b=c#d' }), 'upi://pay?pa=a@b&pn=R%26D%20%3Cx%3E&am=0.01&cu=INR&tn=a%26b%3Dc%23d', 'special characters cannot break the query');
  assert.ok((buildUpiLink({ pa: 'a@b', note: 'x'.repeat(80) }) ?? '').endsWith(`tn=${'x'.repeat(50)}`), 'note is capped');
});

await test('reminder text: friendly, with the amount, UPI ID and link when there are any; optional signature', () => {
  const link = buildUpiLink({ pa: 'me@upi', pn: 'Suyog', amountPaise: 45000, note: 'Goa trip' });
  assert.equal(buildReminderMessage({ name: 'Asha Rao', forWhat: 'Goa trip', amountPaise: 45000, upiId: 'me@upi', upiLink: link }),
    `Hey Asha, your share for Goa trip is Rs 450.\nUPI ID: me@upi\nPay here: ${link}`);
  assert.equal(buildReminderMessage({ name: 'Asha', forWhat: 'Goa trip', amountPaise: 45050 }), 'Hey Asha, your share for Goa trip is Rs 450.50.', 'works with no payment details at all');
  assert.equal(buildReminderMessage({ name: 'Asha', forWhat: 'our shared expenses', amountPaise: 100, upiId: 'me@upi' }), 'Hey Asha, your share for our shared expenses is Rs 1.\nYou can pay on UPI: me@upi', 'UPI ID without a link (only a saved QR picture or no amount)');
  assert.ok(buildReminderMessage({ name: 'Asha', forWhat: 'x', amountPaise: 100, signature: true }).endsWith('\nSent from Velnora'));
});

await test('WhatsApp numbers and links', () => {
  assert.equal(whatsAppNumber('98765 43210'), '919876543210'); assert.equal(whatsAppNumber('+91 98765-43210'), '919876543210');
  assert.equal(whatsAppNumber('+1 (415) 555-0100'), '14155550100'); assert.equal(whatsAppNumber('12345'), null); assert.equal(whatsAppNumber(null), null); assert.equal(whatsAppNumber('1234567890123456'), null);
  const l = whatsAppLinks('Hi there & thanks', '+919876543210');
  assert.equal(l.app, 'whatsapp://send?phone=919876543210&text=Hi%20there%20%26%20thanks'); assert.equal(l.web, 'https://wa.me/919876543210?text=Hi%20there%20%26%20thanks');
  const nobody = whatsAppLinks('Hi', null);
  assert.equal(nobody.app, 'whatsapp://send?text=Hi'); assert.equal(nobody.web, 'https://wa.me/?text=Hi');
});

await test('sending on WhatsApp falls back: app, then wa.me, then the share sheet; text only', async () => {
  const calls: string[] = [];
  const mk = (failApp: boolean, failWeb: boolean, failShare = false) => ({
    async open(url: string) { calls.push(url); if ((url.startsWith('whatsapp:') && failApp) || (url.startsWith('https:') && failWeb)) throw new Error('nope'); },
    async share(text: string) { calls.push(`share:${text}`); if (failShare) throw new Error('nope'); },
  });
  assert.equal(await sendOnWhatsApp('hello', '9876543210', mk(false, false)), 'app'); assert.deepEqual(calls, ['whatsapp://send?phone=919876543210&text=hello']);
  calls.length = 0; assert.equal(await sendOnWhatsApp('hello', '9876543210', mk(true, false)), 'web'); assert.equal(calls.length, 2); assert.ok(calls[1].startsWith('https://wa.me/919876543210'));
  calls.length = 0; assert.equal(await sendOnWhatsApp('hello', null, mk(true, true)), 'share'); assert.equal(calls[2], 'share:hello');
  assert.equal(await sendOnWhatsApp('hello', null, mk(true, true, true)), 'failed');
  assert.ok(calls.every((c) => !/image|png|jpg/i.test(c)), 'no image is ever attached to a deep link');
});

await test('which QR is shown: generated by default, saved picture on request or when it is all there is', () => {
  assert.equal(qrChoice({ hasUpiId: true, hasSavedQr: true, useSaved: false }), 'generated');
  assert.equal(qrChoice({ hasUpiId: true, hasSavedQr: true, useSaved: true }), 'saved');
  assert.equal(qrChoice({ hasUpiId: true, hasSavedQr: false, useSaved: true }), 'generated');
  assert.equal(qrChoice({ hasUpiId: false, hasSavedQr: true, useSaved: false }), 'saved');
  assert.equal(qrChoice({ hasUpiId: false, hasSavedQr: false, useSaved: false }), 'none');
});

await test('QR matrix: square, deterministic, finder pattern present, amount changes the code', () => {
  const link = buildUpiLink({ pa: 'asha@okbank', pn: 'Asha', amountPaise: 45000 })!;
  const m = qrMatrix(link); const again = qrMatrix(link);
  assert.ok(m.size >= 21 && (m.size - 17) % 4 === 0, `valid QR size ${m.size}`);
  assert.equal(m.modules.length, m.size); assert.ok(m.modules.every((r) => r.length === m.size));
  assert.deepEqual(m, again);
  assert.deepEqual(m.modules[0].slice(0, 7), [true, true, true, true, true, true, true], 'top-left finder pattern');
  assert.deepEqual(m.modules[6].slice(0, 7), [true, true, true, true, true, true, true]);
  assert.notDeepEqual(m, qrMatrix(buildUpiLink({ pa: 'asha@okbank', pn: 'Asha', amountPaise: 45100 })!));
  const path = qrPath(m); assert.ok(path.startsWith('M4 4h7v1h-7z'), path.slice(0, 20)); assert.ok(!/NaN|undefined/.test(path));
});

await test('payment details: validated, saved per account, cleared by empty values, never queued for sync', async () => {
  const db = await fresh();
  assert.deepEqual(await getPaymentDetails(db, 'u1'), { upiId: null, displayName: null, qrPath: null });
  await rejectsSplit(savePaymentDetails(db, 'u1', { upiId: 'not-an-id', displayName: '' }), /valid UPI ID/);
  await rejectsSplit(savePaymentDetails(db, 'u1', { upiId: 'ab@bank', displayName: 'x'.repeat(61) }), /too long/);
  const saved = await savePaymentDetails(db, 'u1', { upiId: ' suyog@okicici ', displayName: '  Suyog   R ' });
  assert.deepEqual(saved, { upiId: 'suyog@okicici', displayName: 'Suyog R', qrPath: null });
  assert.equal((await getPaymentDetails(db, 'u2')).upiId, null, 'another account sees nothing');
  assert.equal((await getPaymentDetails(db, null)).upiId, null, 'and neither does the guest');
  await savePaymentDetails(db, 'u1', { upiId: '', displayName: '' });
  assert.deepEqual(await getPaymentDetails(db, 'u1'), { upiId: null, displayName: null, qrPath: null });
  assert.equal((await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM sync_queue'))!.n, 0, 'nothing queued');
});

await test('saved QR picture: stored by path, replace deletes the old file, remove deletes the file', async () => {
  const db = await fresh(); const f = fakeFiles();
  const p1 = await replacePaymentQr(db, 'u1', f.port, 'file:///picked/one.png');
  assert.deepEqual([...f.files], [p1]); assert.equal((await getPaymentDetails(db, 'u1')).qrPath, p1);
  const p2 = await replacePaymentQr(db, 'u1', f.port, 'file:///picked/two.png');
  assert.deepEqual([...f.files], [p2], 'the old picture is gone'); assert.deepEqual(f.removed, [p1]);
  await removePaymentQr(db, 'u1', f.port);
  assert.equal(f.files.size, 0, 'the file is deleted, not just forgotten'); assert.equal((await getPaymentDetails(db, 'u1')).qrPath, null);
  await removePaymentQr(db, 'u1', f.port); // removing twice is harmless
  const failing: QrFilePort = { async importImage() { throw new Error('unreadable'); }, async remove() { /* none */ } };
  await assert.rejects(replacePaymentQr(db, 'u1', failing, 'x'), /unreadable/);
  assert.equal((await getPaymentDetails(db, 'u1')).qrPath, null, 'a failed import changes nothing');
});

await test('guest signs in: UPI ID and name move to the account (not over an existing one); the QR file stays with the guest', async () => {
  const db = await fresh(); const f = fakeFiles();
  await savePaymentDetails(db, null, { upiId: 'guest@upi', displayName: 'Guest' });
  const qr = await replacePaymentQr(db, null, f.port, 'file:///x.png');
  await claimGuestPaymentDetails(db, 'u1');
  assert.deepEqual(await getPaymentDetails(db, 'u1'), { upiId: 'guest@upi', displayName: 'Guest', qrPath: null });
  assert.deepEqual(await getPaymentDetails(db, null), { upiId: null, displayName: null, qrPath: qr });
  await savePaymentDetails(db, null, { upiId: 'g2@upi', displayName: '' });
  await claimGuestPaymentDetails(db, 'u1');
  assert.equal((await getPaymentDetails(db, 'u1')).upiId, 'guest@upi', 'the account keeps its own');
});

await test('delete local data removes that account\'s split data and payment details, and nothing of anyone else\'s', async () => {
  const db = await fresh();
  for (const scope of ['u1', 'u2']) {
    const a = await createContact(db, scope, { name: 'Asha', phone: '+919800000001', upiId: 'asha@upi' });
    const g = await createGroup(db, scope, { name: 'Goa', memberIds: [a.id] });
    await createSplitExpense(db, scope, { groupId: g.id, title: 'Dinner', category: 'Food & Dining', expenseDate: new Date().toISOString(), mode: 'equal', totalPaise: 1000, participants: [{ party: SELF }, { party: a.id }], payers: [{ party: SELF, paidPaise: 1000 }] });
    await recordSettlement(db, scope, { from: a.id, to: SELF, amountPaise: 100, groupId: g.id });
    await savePaymentDetails(db, scope, { upiId: 'me@upi', displayName: 'Me' });
  }
  await deleteUserLocalData('u1', db);
  const count = async (table: string, scope: string) => (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`, scope))!.n;
  for (const t of ['contacts', 'split_groups', 'split_expenses', 'settlements']) { assert.equal(await count(t, 'u1'), 0, t); assert.equal(await count(t, 'u2'), 1, `${t} of the other account`); }
  assert.equal((await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM split_shares'))!.n, 2, 'only the other account\'s shares remain');
  assert.equal((await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) n FROM group_members'))!.n, 1);
  assert.equal((await getPaymentDetails(db, 'u1')).upiId, null); assert.equal((await getPaymentDetails(db, 'u2')).upiId, 'me@upi');
  assert.deepEqual(Object.keys(paymentKeys('u1')).sort(), ['name', 'qr', 'upi']);
});

console.log(`${passed} passed`);
