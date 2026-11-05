/** Merchant phone, details sheet, categories, merchant aliases, budgets, analytics, receipts, receipt parser, sync. */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { TransactionRepository } from '../../db/repositories/transactionRepository.ts';
import { SyncEngine } from '../syncEngine.ts';
import { buildMerchantPhone, parseLocalDateTime, formatDateInput, formatTimeInput } from '../transactionDetails.ts';
import { addSmsTransaction, addTransaction, setTransactionServiceAdapter, updateTransactionDetails } from '../transactionService.ts';
import { createCategory, deleteCategory, listCategories, updateCategory } from '../categoryService.ts';
import { applyAlias, normalizeMerchantKey, rememberAlias, removeAlias, listAliases } from '../merchantAliasService.ts';
import { deleteBudget, getBudgetProgress, monthRange, progressFor, saveBudget, spentPaise } from '../budgetService.ts';
import { breakdownForMonth } from '../analyticsService.ts';
import { attachReceipt, findPossibleDuplicate, removeReceipt, uploadPendingReceipts, type ReceiptFs } from '../receiptService.ts';
import { parseReceiptText } from '../receiptParser.ts';
import type { IDatabase, Session } from '../../db/types.ts';
import type { ParsedSmsTransaction } from '../../../transactionParser.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 'tok-A', refresh_token: 'r', token_type: 'bearer' };
const B: Session = { user: { id: 'user-B', full_name: 'B', email: 'b@x.com' }, access_token: 'tok-B', refresh_token: 'r', token_type: 'bearer' };

async function fresh() {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  return db as unknown as IDatabase & { close(): void };
}
const sms = (merchant: string, ref = 'REF000001'): ParsedSmsTransaction => ({ status: 'success', direction: 'expense', amount: 150, merchant, transactionDate: new Date().toISOString(), bankSender: 'HDFCBK', referenceId: ref, fingerprint: `fp-${ref}` });
const month = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const manual = (s: Session | null, over: Record<string, unknown> = {}) => addTransaction({ amount: 100, direction: 'expense', counterparty: 'Shop', category: 'Groceries', ...over } as never, s);

async function phone() {
  const ok = (n: string, d?: string) => { const r = buildMerchantPhone(n, d); assert.ok(r.ok, `${n} should be valid`); return (r as { value: string | null }).value; };
  assert.equal(ok(''), null); assert.equal(ok('   '), null); assert.equal(ok(null as never), null);
  assert.equal(ok('98765 43210'), '+919876543210'); assert.equal(ok('098765-43210'), '+919876543210');
  assert.equal(ok('+91 98765 43210'), '+919876543210'); assert.equal(ok('+14155552671', '+91'), '+14155552671', 'own + prefix wins');
  assert.equal(ok('0044 7911 123456'), '+447911123456'); assert.equal(ok('7911123456', '+44'), '+447911123456');
  for (const bad of ['12345', '5876543210', 'abcdefghij', '+91 12345', '+0123456789', '98765432101', '++919876543210', '+1']) {
    assert.equal(buildMerchantPhone(bad).ok, false, `${bad} should be invalid`);
  }
  assert.equal(buildMerchantPhone('9876543210', 'xx').ok, false);
}

async function dateInputs() {
  const iso = parseLocalDateTime('2026-03-05', '14:30')!;
  assert.equal(formatDateInput(iso), '2026-03-05'); assert.equal(formatTimeInput(iso), '14:30');
  assert.equal(parseLocalDateTime('2026-02-31', '10:00'), null); assert.equal(parseLocalDateTime('05/03/2026', '10:00'), null);
  assert.equal(parseLocalDateTime('2026-03-05', '25:00'), null); assert.ok(parseLocalDateTime('2026-03-05', ''));
}

async function detailsSheet() {
  const db = await fresh();
  const tx = await manual(A);
  assert.equal(tx.merchant_phone ?? null, null, 'optional: absent by default');
  // save without phone, other fields change
  let u = await updateTransactionDetails(tx.id, { counterparty: 'Shop 2', amount: 120.5, category: 'Health' }, A);
  assert.equal(u.merchant_phone ?? null, null); assert.equal(u.amount_paise, 12050);
  // add / edit / clear phone persists locally (offline: no fetch performed)
  u = await updateTransactionDetails(tx.id, { merchantPhone: { number: '9876543210' } }, A);
  assert.equal(u.merchant_phone, '+919876543210');
  assert.equal((await new TransactionRepository(db).getById(tx.id))!.merchant_phone, '+919876543210', 'reopened');
  u = await updateTransactionDetails(tx.id, { merchantPhone: { number: '9123456789' } }, A);
  assert.equal(u.merchant_phone, '+919123456789');
  await assert.rejects(updateTransactionDetails(tx.id, { merchantPhone: { number: '123' } }, A), /valid/);
  assert.equal((await new TransactionRepository(db).getById(tx.id))!.merchant_phone, '+919123456789', 'invalid input does not change data');
  u = await updateTransactionDetails(tx.id, { merchantPhone: { number: '' } }, A);
  assert.equal(u.merchant_phone, null, 'cleared');
  // location add/edit/clear + validation
  u = await updateTransactionDetails(tx.id, { location: { lat: 18.52, lng: 73.85, name: 'Cafe', address: 'FC Road' } }, A);
  assert.deepEqual([u.location_lat, u.location_name, u.location_confirmed], [18.52, 'Cafe', 1]);
  await assert.rejects(updateTransactionDetails(tx.id, { location: { lat: 99, lng: 0 } }, A), /out of range/);
  u = await updateTransactionDetails(tx.id, { location: null }, A);
  assert.deepEqual([u.location_lat, u.location_confirmed], [null, 0]);
  // ownership: B and guest cannot edit A's record
  await assert.rejects(updateTransactionDetails(tx.id, { counterparty: 'x' }, B), /different account/);
  await assert.rejects(updateTransactionDetails(tx.id, { counterparty: 'x' }, null), /different account/);
  // queue holds the latest snapshot including details
  const q = await db.getFirstAsync<{ payload: string }>("SELECT payload FROM sync_queue WHERE entity_id = ?", tx.id);
  assert.equal(JSON.parse(q!.payload).location_lat, null);
  // SMS transactions never get a merchant phone
  const s = await addSmsTransaction({ ...sms('ACME STORE 9876543210') }, A);
  assert.equal(s.merchant_phone ?? null, null, 'SMS content is never turned into a merchant number');
  const g = await manual(null);
  assert.equal(g.user_id, null);
  const gu = await updateTransactionDetails(g.id, { merchantPhone: { number: '9876543210' } }, null);
  assert.equal(gu.merchant_phone, '+919876543210', 'guest edits work offline, no session');
  db.close();
}

async function categories() {
  const db = await fresh();
  const defaults = await listCategories(db, 'user-A');
  for (const n of ['Food & Dining', 'Groceries', 'Shopping', 'Health', 'Education', 'Entertainment', 'Travel', 'Personal Care', 'Rent', 'Salary', 'Freelance', 'Business', 'Investment', 'Other Income']) {
    assert.ok(defaults.some((c) => c.name === n), `default ${n}`);
  }
  assert.equal(new Set(defaults.map((c) => `${c.name}|${c.type}`)).size, defaults.length, 'no duplicates');
  const pets = await createCategory(db, 'user-A', { name: 'Pets', type: 'expense', color: '#112233', icon: 'Tag' });
  await assert.rejects(createCategory(db, 'user-A', { name: 'pets', type: 'expense' }), /already exists/);
  await assert.rejects(createCategory(db, 'user-A', { name: 'Health', type: 'expense' }), /already exists/);
  await assert.rejects(createCategory(db, 'user-A', { name: '  ', type: 'expense' }), /name/);
  assert.ok((await listCategories(db, 'user-A')).some((c) => c.id === pets.id));
  assert.ok(!(await listCategories(db, 'user-B')).some((c) => c.id === pets.id), 'account isolation');
  assert.ok(!(await listCategories(db, null)).some((c) => c.id === pets.id), 'guest cannot see account category');
  const q = await db.getFirstAsync<{ operation: string; payload: string }>("SELECT operation, payload FROM sync_queue WHERE entity_id = ?", pets.id);
  assert.equal(q!.operation, 'create'); assert.equal(JSON.parse(q!.payload).user_id, 'user-A');
  // assign + rename cascades to transactions
  const tx = await manual(A, { category: 'Pets' });
  await updateCategory(db, 'user-A', pets.id, { name: 'Pet Care' });
  assert.equal((await new TransactionRepository(db).getById(tx.id))!.category, 'Pet Care');
  await assert.rejects(updateCategory(db, 'user-B', pets.id, { name: 'Hack' }), /own custom/);
  await assert.rejects(updateCategory(db, 'user-A', 'cat-food', { name: 'X' }), /own custom/, 'defaults cannot be edited');
  // delete requires reassignment when used
  await assert.rejects(deleteCategory(db, 'user-A', pets.id), /CATEGORY_IN_USE:1/);
  await assert.rejects(deleteCategory(db, 'user-A', pets.id, 'cat-salary'), /same type/);
  await saveBudget(db, 'user-A', { category: 'Pet Care', amountPaise: 100000 });
  const res = await deleteCategory(db, 'user-A', pets.id, 'cat-other-exp');
  assert.equal(res.reassigned, 1);
  assert.equal((await new TransactionRepository(db).getById(tx.id))!.category, 'Other Expenses', 'history kept, valid category');
  assert.ok(!(await listCategories(db, 'user-A')).some((c) => c.id === pets.id));
  assert.equal((await db.getAllAsync("SELECT 1 FROM budgets WHERE category = 'Pet Care' AND deleted_at IS NULL")).length, 0, 'orphan budget removed');
  await assert.rejects(deleteCategory(db, 'user-A', 'cat-food'), /own custom/, 'defaults cannot be deleted');
  // unused category deletes without target; never-synced create+delete leaves nothing queued
  const tmp = await createCategory(db, 'user-A', { name: 'Tmp', type: 'income' });
  await deleteCategory(db, 'user-A', tmp.id);
  assert.equal((await db.getFirstAsync<{ c: number }>("SELECT COUNT(*) c FROM sync_queue WHERE entity_id = ?", tmp.id))!.c, 0, 'created+deleted before sync: nothing is sent');
  db.close();
}

async function aliases() {
  const db = await fresh();
  assert.equal(normalizeMerchantKey('  SPJIMR   MESS! '), 'spjimr mess');
  assert.notEqual(normalizeMerchantKey('SPJIMR MESS 2'), normalizeMerchantKey('SPJIMR MESS'));
  // before remembering: untouched
  const first = await addSmsTransaction(sms('SPJIMR MESS', 'REF000001'), A);
  assert.equal(first.counterparty, 'SPJIMR MESS');
  // user corrects + agrees to remember (with category)
  await rememberAlias(db, 'user-A', 'SPJIMR MESS', 'SPJIMR Mess', 'Food & Dining');
  // old transaction is not rewritten
  assert.equal((await new TransactionRepository(db).getById(first.id))!.counterparty, 'SPJIMR MESS');
  const next = await addSmsTransaction(sms('spjimr  mess', 'REF000002'), A);
  assert.equal(next.counterparty, 'SPJIMR Mess'); assert.equal(next.category, 'Food & Dining');
  assert.match(next.description, /spjimr {1,2}mess/i, 'original text preserved');
  assert.doesNotMatch(next.description, /9876543210|OTP/i);
  // unrelated / similar merchants are not merged
  for (const m of ['SPJIMR MESS 2', 'SPJ MESS', 'MESS']) assert.equal((await addSmsTransaction(sms(m, `REF${m.length}00099`), A)).counterparty, m);
  // account isolation: B and guest unaffected
  assert.equal((await addSmsTransaction(sms('SPJIMR MESS', 'REF000777'), B)).counterparty, 'SPJIMR MESS');
  assert.equal((await applyAlias(db, null, 'SPJIMR MESS')).matched, false);
  assert.equal((await listAliases(db, 'user-B')).length, 0);
  // manual entry applies name only, keeps chosen category
  const m = await manual(A, { counterparty: 'spjimr mess', category: 'Groceries' });
  assert.equal(m.counterparty, 'SPJIMR Mess'); assert.equal(m.category, 'Groceries');
  // update keeps one alias per key; remove stops matching; B cannot remove A's
  const upd = await rememberAlias(db, 'user-A', 'SPJIMR MESS', 'Spjimr Canteen');
  assert.equal((await listAliases(db, 'user-A')).length, 1); assert.equal(upd.category, 'Food & Dining');
  assert.equal(await removeAlias(db, 'user-B', upd.id), false);
  assert.equal(await removeAlias(db, 'user-A', upd.id), true);
  assert.equal((await applyAlias(db, 'user-A', 'SPJIMR MESS')).matched, false);
  assert.equal((await db.getAllAsync("SELECT 1 FROM sync_queue WHERE entity_id = ? AND entity_type = 'merchant_alias'", upd.id)).length, 0, 'never-synced alias removed: nothing to send');
  db.close();
}

async function budgetsAndAnalytics() {
  const db = await fresh();
  const now = new Date(); const m = month(now);
  const inMonth = new Date(now.getFullYear(), now.getMonth(), 15, 12).toISOString();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12).toISOString();
  await manual(A, { amount: 1000.1, category: 'Food & Dining', transaction_date: inMonth });
  await manual(A, { amount: 2000.2, category: 'Food & Dining', transaction_date: inMonth });
  await manual(A, { amount: 500, category: 'Transportation', transaction_date: inMonth });
  await manual(A, { amount: 9999, category: 'Food & Dining', transaction_date: lastMonth });
  await manual(A, { amount: 7777, direction: 'income', category: 'Salary', transaction_date: inMonth });
  const gone = await manual(A, { amount: 4444, category: 'Food & Dining', transaction_date: inMonth });
  await new TransactionRepository(db).delete(gone.id);
  await manual(B, { amount: 321, category: 'Food & Dining', transaction_date: inMonth });
  await manual(null, { amount: 55, category: 'Food & Dining', transaction_date: inMonth });

  assert.equal(await spentPaise(db, 'user-A', m, 'Food & Dining'), 300030, 'exact paise, no float drift (1000.10+2000.20)');
  assert.equal(await spentPaise(db, 'user-A', m, null), 350030, 'overall = single sum, no double count');
  assert.equal(await spentPaise(db, null, m, null), 5500, 'guest scope separate');

  const food = await saveBudget(db, 'user-A', { category: 'Food & Dining', amountPaise: 500000 });
  const overall = await saveBudget(db, 'user-A', { category: null, amountPaise: 350030 });
  await assert.rejects(saveBudget(db, 'user-A', { category: 'food & dining', amountPaise: 1 }), /already exists/);
  await assert.rejects(saveBudget(db, 'user-A', { category: null, amountPaise: 1 }), /overall/);
  await assert.rejects(saveBudget(db, 'user-A', { category: 'Rent', amountPaise: 0 }), /greater than zero/);
  await assert.rejects(saveBudget(db, 'user-B', { id: food.id, category: 'Food & Dining', amountPaise: 1 }), /not found/);
  const prog = await getBudgetProgress(db, 'user-A', m);
  const f = prog.find((p) => p.budget.id === food.id)!; const o = prog.find((p) => p.budget.id === overall.id)!;
  assert.deepEqual([f.spentPaise, f.remainingPaise, f.percentUsed, f.state], [300030, 199970, 60, 'within']);
  assert.deepEqual([o.spentPaise, o.remainingPaise, o.state], [350030, 0, 'near'], 'exactly at limit is near, not exceeded');
  assert.equal(progressFor({ ...food, amount_paise: 100000 }, 100001).state, 'exceeded');
  assert.equal(progressFor({ ...food, amount_paise: 100000 }, 79999).state, 'within');
  assert.equal(progressFor({ ...food, amount_paise: 100000 }, 80000).state, 'near');
  assert.equal((await getBudgetProgress(db, 'user-B', m)).length, 0, 'budget isolation');
  const edited = await saveBudget(db, 'user-A', { id: food.id, category: 'Food & Dining', amountPaise: 250000 });
  assert.equal(progressFor(edited, 300030).state, 'exceeded');
  assert.equal(await deleteBudget(db, 'user-B', food.id), false);
  assert.equal(await deleteBudget(db, 'user-A', food.id), true);
  assert.equal((await getBudgetProgress(db, 'user-A', m)).length, 1);

  const bd = await breakdownForMonth(db, 'user-A', m);
  assert.equal(bd.totalPaise, 350030);
  assert.deepEqual(bd.slices.map((s) => [s.category, s.totalPaise, s.percentTenths]), [['Food & Dining', 300030, 857], ['Transportation', 50000, 143]]);
  assert.ok(bd.slices.every((s) => /^#[0-9a-f]{6}$/i.test(s.color)));
  assert.equal((await breakdownForMonth(db, 'user-A', month(new Date(now.getFullYear() - 1, 0, 1)))).isEmpty, true, 'empty state');
  const { start, end } = monthRange('2026-02'); assert.ok(start < end);
  db.close();
}

class FakeFs implements ReceiptFs {
  files = new Set<string>(); n = 0;
  async importImage(src: string, id: string) { const p = `/private/receipts/${id}-${++this.n}.jpg`; if (!src.startsWith('file:')) throw new Error('bad source'); this.files.add(p); return p; }
  async remove(p: string) { this.files.delete(p); }
  async exists(p: string) { return this.files.has(p); }
}

async function receipts() {
  const db = await fresh(); const fs = new FakeFs();
  const tx = await manual(A); const guestTx = await manual(null);
  const p1 = await attachReceipt(db, fs, A, tx.id, 'file:///cache/a.jpg');
  let row = (await new TransactionRepository(db).getById(tx.id))!;
  assert.deepEqual([row.receipt_local_path, row.receipt_upload_pending], [p1, 1]);
  const p2 = await attachReceipt(db, fs, A, tx.id, 'file:///cache/b.jpg');
  assert.ok(!fs.files.has(p1) && fs.files.has(p2), 'replace removes the old private file');
  await assert.rejects(attachReceipt(db, fs, B, tx.id, 'file:///c.jpg'), /different account/);
  await assert.rejects(attachReceipt(db, fs, A, tx.id, 'content://bad'), /bad source/);
  assert.equal((await new TransactionRepository(db).getById(tx.id))!.receipt_local_path, p2, 'failed attach leaves data intact');
  // guest: stored locally, never marked for upload
  await attachReceipt(db, fs, null, guestTx.id, 'file:///cache/g.jpg');
  assert.equal((await new TransactionRepository(db).getById(guestTx.id))!.receipt_upload_pending, 0);
  // upload only after the transaction itself is synced; failure keeps it pending; success records remote id + queues metadata sync
  const uploads: string[] = []; let failNext = true;
  const uploader = { upload: async (_s: Session, id: string) => { if (failNext) throw new Error('offline'); uploads.push(id); return 'remote-rcpt-1'; } };
  assert.deepEqual(await uploadPendingReceipts(db, fs, uploader, A), { uploaded: 0, failed: 0 }, 'not synced yet -> not attempted');
  await new TransactionRepository(db).updateSyncStatus(tx.id, 'synced', 1);
  assert.deepEqual(await uploadPendingReceipts(db, fs, uploader, A), { uploaded: 0, failed: 1 });
  assert.equal((await new TransactionRepository(db).getById(tx.id))!.receipt_upload_pending, 1, 'retry later');
  failNext = false;
  assert.deepEqual(await uploadPendingReceipts(db, fs, uploader, B), { uploaded: 0, failed: 0 }, "other account's receipts are never uploaded");
  assert.deepEqual(await uploadPendingReceipts(db, fs, uploader, A), { uploaded: 1, failed: 0 });
  row = (await new TransactionRepository(db).getById(tx.id))!;
  assert.deepEqual([row.receipt_remote_id, row.receipt_upload_pending, row.receipt_local_path], ['remote-rcpt-1', 0, p2]);
  assert.equal(JSON.parse((await db.getFirstAsync<{ payload: string }>("SELECT payload FROM sync_queue WHERE entity_id = ?", tx.id))!.payload).receipt_remote_id, 'remote-rcpt-1');
  assert.ok(!uploads.includes(guestTx.id));
  // duplicate receipt detection: same merchant+total+day for the same account only
  const day = new Date(new Date().getFullYear(), new Date().getMonth(), 10, 12).toISOString();
  const dup = await manual(A, { amount: 179, counterparty: 'SPJIMR Canteen', transaction_date: day });
  assert.equal((await findPossibleDuplicate(db, 'user-A', { amountPaise: 17900, isoDate: day, merchant: 'spjimr  canteen' }))?.id, dup.id);
  assert.equal(await findPossibleDuplicate(db, 'user-A', { amountPaise: 17900, isoDate: day, merchant: 'Other Cafe' }), null);
  assert.equal(await findPossibleDuplicate(db, 'user-B', { amountPaise: 17900, isoDate: day, merchant: 'SPJIMR Canteen' }), null, 'other account unaffected');
  await removeReceipt(db, fs, A, tx.id);
  row = (await new TransactionRepository(db).getById(tx.id))!;
  assert.deepEqual([row.receipt_local_path, row.receipt_remote_id, fs.files.has(p2)], [null, null, false]);
  db.close();
}

function receiptParser() {
  const good = `SPJIMR Canteen
GSTIN 27ABCDE1234F1Z5
Date: 12/03/2026 13:45
Masala Dosa   2 x 60.00   120.00
Coffee        2 x 30.00    60.00
Sub Total                 180.00
CGST 2.5%                   4.50
SGST 2.5%                   4.50
Discount                  -10.00
Grand Total              ₹ 179.00
Cash                      200.00
Change                     21.00`;
  const r = parseReceiptText(good, new Date('2026-04-01'));
  assert.equal(r.amountPaise, 17900, 'grand total, not last number / subtotal / cash');
  assert.equal(r.merchant, 'SPJIMR Canteen'); assert.equal(r.currency, 'INR');
  assert.equal(new Date(r.date!).getMonth(), 2); assert.equal(r.categoryHint, 'Food & Dining'); assert.equal(r.ambiguousTotal, false);
  // missing total: nothing invented, candidates offered
  const noTotal = parseReceiptText('Corner Store\n12/03/2026\nMilk 52.00\nBread 40.00', new Date('2026-04-01'));
  assert.equal(noTotal.amountPaise, null); assert.deepEqual(noTotal.amountCandidates, [5200, 4000]); assert.equal(noTotal.looksLikeReceipt, true);
  // ambiguous: two different strong totals -> flagged
  const amb = parseReceiptText('Shop One\nTotal Amount 100.00\nAmount Payable 120.00', new Date());
  assert.equal(amb.amountPaise, 12000); assert.equal(amb.ambiguousTotal, true);
  // total on following line (columnar OCR)
  assert.equal(parseReceiptText('Mart\nGrand Total\n₹1,250.50', new Date()).amountPaise, 125050);
  // "Total Items" / tax lines are not totals
  assert.equal(parseReceiptText('Mart\nTotal Items 5\nGST 18.00', new Date()).amountPaise, null);
  // ambiguous merchant: invoice/GSTIN lines skipped, candidates exposed for user choice
  const merch = parseReceiptText('TAX INVOICE\nGSTIN 27AAAA\nBlue Tokai Coffee\nMG Road Pune\nTotal 300', new Date());
  assert.equal(merch.merchant, 'Blue Tokai Coffee'); assert.ok(merch.merchantCandidates.length >= 1);
  // dates: future/invalid rejected, ISO accepted
  assert.equal(parseReceiptText('Shop\nDate 31/02/2026\nTotal 10', new Date('2026-04-01')).date, null);
  assert.equal(parseReceiptText('Shop\nDate 01/01/2090\nTotal 10', new Date('2026-04-01')).date, null);
  assert.ok(parseReceiptText('Shop\n2026-03-05\nTotal 10', new Date('2026-04-01')).date);
  // not a receipt / empty / garbage
  for (const t of ['', '   \n  ', 'hello world', '!!!! ####']) { const x = parseReceiptText(t); assert.equal(x.amountPaise, null); assert.equal(x.looksLikeReceipt, false); }
}

// ----- sync: new entity types round trip, ownership, queue cleared only on ack -----
type Op = { operation_id: string; entity_type: string; entity_id: string; operation: string; payload: Record<string, unknown> };
async function sync() {
  const db = await fresh();
  const tx = await manual(A);
  await updateTransactionDetails(tx.id, { merchantPhone: { number: '9876543210' }, location: { lat: 1.5, lng: 2.5, name: 'P' } }, A);
  const cat = await createCategory(db, 'user-A', { name: 'Pets', type: 'expense' });
  const bud = await saveBudget(db, 'user-A', { category: 'Pets', amountPaise: 123400 });
  const al = await rememberAlias(db, 'user-A', 'XYZ STORE', 'Xyz Store');
  const other = await manual(B); await saveBudget(db, 'user-B', { category: null, amountPaise: 999 });
  const guestBud = await saveBudget(db, null, { category: null, amountPaise: 111 });

  const seen: Op[] = []; let mode: 'down' | 'ok' = 'down';
  const prev = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    if (mode === 'down') throw new TypeError('network');
    const body = JSON.parse(init!.body!) as { items: Op[] };
    seen.push(...body.items);
    return new Response(JSON.stringify({ server_time: new Date().toISOString(), results: body.items.map((o) => ({ operation_id: o.operation_id, entity_id: o.entity_id, operation: o.operation, status: 'synced', server_version: 1 })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const engine = new SyncEngine(db);
    await assert.rejects(engine.pushPendingChanges(A));
    assert.ok((await db.getAllAsync("SELECT 1 FROM sync_queue WHERE json_extract(payload,'$.user_id') = 'user-A' OR entity_id = ?", tx.id)).length >= 4, 'offline: queue preserved, nothing dropped');
    mode = 'ok';
    // retry delay from the failed attempt: reset so this test can push now
    await db.runAsync('UPDATE sync_queue SET next_retry_at = NULL, retry_count = 0');
    const r = await engine.pushPendingChanges(A);
    assert.equal(r.pushed, 4);
    const byType = Object.fromEntries(seen.map((o) => [o.entity_type, o]));
    assert.equal(byType.transaction.payload.merchant_phone, '+919876543210'); assert.equal(byType.transaction.payload.location_lat, 1.5);
    assert.deepEqual(byType.category.payload, { category: 'Pets', direction: 'expense', icon: 'Tag', color: byType.category.payload.color });
    assert.deepEqual(byType.budget.payload, { category: 'Pets', amount_paise: 123400 });
    assert.deepEqual(byType.merchant_alias.payload, { match_key: 'xyz store', original_text: 'XYZ STORE', display_name: 'Xyz Store', category: null });
    assert.ok(seen.every((o) => ![other.id, guestBud.id].includes(o.entity_id)), "B's and guest items never uploaded under A");
    assert.equal((await db.getAllAsync("SELECT 1 FROM sync_queue WHERE entity_id IN (?, ?, ?, ?)", tx.id, cat.id, bud.id, al.id)).length, 0, 'queue cleared only after ack');
    assert.equal((await db.getFirstAsync<{ s: string }>('SELECT sync_status s FROM budgets WHERE id = ?', bud.id))!.s, 'synced');
    assert.equal((await db.getFirstAsync<{ s: string }>('SELECT sync_status s FROM merchant_aliases WHERE id = ?', al.id))!.s, 'synced');
    // B's budget + tx still queued for B
    assert.ok((await db.getAllAsync("SELECT 1 FROM sync_queue WHERE entity_id = ?", other.id)).length === 1);
    // pull: merges server budgets/aliases for A only; local unsynced edits win
    const serverBudget = { id: 'srv-budget-1', category: 'Rent', amount_paise: 800000, deleted_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const serverAlias = { id: 'srv-alias-1', match_key: 'chai point', original_text: 'CHAI POINT', display_name: 'Chai Point', category: 'Food & Dining', deleted_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    globalThis.fetch = (async () => new Response(JSON.stringify({ transactions: [], categories: [], budgets: [serverBudget], merchant_aliases: [serverAlias], server_time: new Date().toISOString(), next_cursor: null, has_more: false, total_active_count: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    await engine.pullRemoteChanges(A);
    assert.equal((await db.getFirstAsync<{ u: string }>("SELECT user_id u FROM budgets WHERE id = 'srv-budget-1'"))!.u, 'user-A');
    assert.equal((await applyAlias(db, 'user-A', 'chai point')).merchant, 'Chai Point');
    assert.equal((await applyAlias(db, 'user-B', 'chai point')).matched, false, 'pulled alias is A-only');
    // A's pull must not prune B's custom categories
    const bCat = await createCategory(db, 'user-B', { name: 'BOnly', type: 'expense' });
    await db.runAsync("UPDATE sync_queue SET entity_id = entity_id WHERE 0");
    await db.runAsync("DELETE FROM sync_queue WHERE entity_id = ?", bCat.id);
    globalThis.fetch = (async () => new Response(JSON.stringify({ transactions: [], categories: [{ id: 'sys-1', user_id: null, name: 'Sys', direction: 'expense', icon: 'x', color: '#000000', is_system: true, created_at: '', updated_at: '' }], categories_complete: true, budgets: [], merchant_aliases: [], server_time: new Date().toISOString(), next_cursor: null, has_more: false, total_active_count: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    await engine.pullRemoteChanges(A);
    assert.ok((await listCategories(db, 'user-B')).some((c) => c.id === bCat.id), "A's sync never deletes B's categories");
  } finally { globalThis.fetch = prev; }
  db.close();
}

async function migrationKeepsExistingData() {
  const { MIGRATIONS } = await import('../../db/schema.ts');
  const db = new NodeSqliteAdapter();
  await db.execAsync('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((x) => x.version <= 2)) { await db.execAsync(m.up); await db.runAsync('INSERT INTO schema_migrations VALUES (?, ?)', m.version, 'x'); }
  await db.runAsync(`INSERT INTO transactions (id, user_id, amount, amount_paise, direction, counterparty, category, transaction_date, source, sync_status, created_at, updated_at) VALUES ('t1','u1',5,500,'expense','M','C','2026-01-01','manual','pending_create','x','x')`);
  await db.runAsync(`INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, retry_count, created_at) VALUES ('q1','transaction','t1','create','{"user_id":"u1"}',3,'x')`);
  assert.equal(await runMigrations(db), 2);
  const q = await db.getFirstAsync<{ retry_count: number; payload: string }>("SELECT * FROM sync_queue WHERE id = 'q1'");
  assert.deepEqual([q!.retry_count, q!.payload], [3, '{"user_id":"u1"}']);
  assert.equal((await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) c FROM transactions'))!.c, 1);
  await db.runAsync(`INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, created_at) VALUES ('q2','budget','b1','create','{}','x')`);
  await assert.rejects(db.runAsync(`INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, created_at) VALUES ('q3','nonsense','b2','create','{}','x')`));
  await assert.rejects(db.runAsync(`INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, created_at) VALUES ('q4','budget','b1','update','{}','x')`), /UNIQUE/);
  db.close();
}

await migrationKeepsExistingData();
await phone();
await dateInputs();
await detailsSheet();
await categories();
await aliases();
await budgetsAndAnalytics();
await receipts();
receiptParser();
await sync();
console.log('features tests passed');
