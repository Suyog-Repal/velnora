/**
 * "Fill in from receipt" review rules: manual values are kept where the receipt shows nothing, conflicts with values the
 * person ENTERED are reported (defaults are not), and a date-only receipt never resets the time to midnight.
 */
import assert from 'node:assert/strict';
import { initialReviewValues, reviewConflicts, type ReceiptFormValues } from '../receiptReview.ts';
import { formatDateInput, formatTimeInput } from '../transactionDetails.ts';
import type { ReceiptSuggestion } from '../receiptParser.ts';

const categories = [
  { name: 'Groceries', type: 'expense' as const }, { name: 'Food & Dining', type: 'expense' as const },
  { name: 'Salary', type: 'income' as const },
];
const blank = (over: Partial<ReceiptSuggestion> = {}): ReceiptSuggestion => ({
  merchant: null, merchantCandidates: [], amountPaise: null, ambiguousTotal: false, amountCandidates: [], date: null,
  currency: null, categoryHint: null, looksLikeReceipt: true, hasTime: false, payee: null, payer: null, direction: null,
  referenceId: null, paymentStatus: null, isPaymentScreen: false, ...over,
});
const form = (over: Partial<ReceiptFormValues> = {}): ReceiptFormValues => ({
  direction: 'expense', merchant: '', amount: '', date: '', time: '', category: '', ...over,
});
const NOW = '2026-11-13T09:30:00.000Z';
const receiptDay = new Date(2026, 10, 10, 0, 0, 0).toISOString(); // local midnight, no time of day
const receiptAt = new Date(2026, 10, 10, 18, 45, 0).toISOString();

// 1. OCR failed entirely: every manual value is kept, nothing invented, no conflicts.
{
  const current = form({ merchant: 'AutoTest Bakery', amount: '250', date: '2026-11-12', time: '08:15', category: 'Food & Dining' });
  const v = initialReviewValues(null, current, categories, NOW);
  assert.deepEqual(
    { m: v.merchant, a: v.amount, d: v.date, t: v.time, c: v.category, r: v.reference },
    { m: 'AutoTest Bakery', a: '250', d: '2026-11-12', t: '08:15', c: 'Food & Dining', r: '' },
  );
  assert.deepEqual(reviewConflicts(null, current, categories), []);
  console.log('ok: OCR failure keeps every manual value');
}

// 2. Receipt shows only an amount: merchant/date/time/category keep the manual values.
{
  const current = form({ merchant: 'AutoTest Bakery', date: '2026-11-12', time: '08:15', category: 'Food & Dining' });
  const v = initialReviewValues(blank({ amountPaise: 50300 }), current, categories, NOW);
  assert.equal(v.amount, '503');
  assert.equal(v.merchant, 'AutoTest Bakery');
  assert.equal(v.date, '2026-11-12');
  assert.equal(v.time, '08:15');
  assert.equal(v.category, 'Food & Dining');
  console.log('ok: partial OCR fills only what it found');
}

// 3. Date without time: the form's time is kept (never reset to 00:00).
{
  const v = initialReviewValues(blank({ date: receiptDay, hasTime: false }), form({ time: '19:05' }), categories, NOW);
  assert.equal(v.date, formatDateInput(receiptDay));
  assert.equal(v.time, '19:05');
  const v2 = initialReviewValues(blank({ date: receiptAt, hasTime: true }), form({ time: '19:05' }), categories, NOW);
  assert.equal(v2.time, formatTimeInput(receiptAt));
  console.log('ok: a date-only receipt keeps the form time');
}

// 4. Empty form and empty receipt: date/time default to now, category empty (person must choose), no conflicts.
{
  const v = initialReviewValues(blank(), form(), categories, NOW);
  assert.equal(v.date, formatDateInput(NOW));
  assert.equal(v.time, formatTimeInput(NOW));
  assert.equal(v.category, '');
  assert.deepEqual(reviewConflicts(blank(), form(), categories), []);
  console.log('ok: empty form + empty receipt');
}

// 5. Conflicts with ENTERED values are reported for every field; equal values are not conflicts.
{
  const current = form({ merchant: 'AutoTest Bakery', amount: '250.00', date: '2026-11-12', time: '08:15', category: 'Food & Dining' });
  const s = blank({ merchant: 'Fresh Mart', amountPaise: 50300, date: receiptAt, hasTime: true, categoryHint: 'groceries' });
  const fields = reviewConflicts(s, current, categories).map((c) => c.field).sort();
  assert.deepEqual(fields, ['amount', 'category', 'date', 'merchant', 'time']);
  const cat = reviewConflicts(s, current, categories).find((c) => c.field === 'category')!;
  assert.deepEqual([cat.entered, cat.read], ['Food & Dining', 'Groceries']);
  // Same values in different spelling/format are not conflicts
  const same = reviewConflicts(blank({ merchant: 'autotest bakery', amountPaise: 25000 }), current, categories);
  assert.deepEqual(same, []);
  console.log('ok: conflicts reported for entered values only when they differ');
}

// 6. Defaults are not entries: an untouched date / category never conflicts.
{
  const current = form({ date: formatDateInput(NOW), time: formatTimeInput(NOW), category: 'Groceries',
    entered: { merchant: true, amount: true, date: false, time: false, category: false } });
  const s = blank({ date: receiptAt, hasTime: true, categoryHint: 'Food & Dining' });
  assert.deepEqual(reviewConflicts(s, current, categories), []);
  const v = initialReviewValues(s, current, categories, NOW);
  assert.equal(v.category, 'Food & Dining', 'receipt hint replaces an untouched default');
  assert.equal(v.date, formatDateInput(receiptAt));
  console.log('ok: untouched defaults are not reported as conflicts');
}

// 7. Receipt says income: an expense category cannot carry over; the review asks for one.
{
  const v = initialReviewValues(blank({ direction: 'income' }), form({ category: 'Groceries' }), categories, NOW);
  assert.equal(v.direction, 'income');
  assert.equal(v.category, '');
  console.log('ok: direction change never keeps a category of the other type');
}

// 8. Reference is taken from the receipt only (never invented).
{
  assert.equal(initialReviewValues(blank({ referenceId: 'UTR123456789' }), form(), categories, NOW).reference, 'UTR123456789');
  assert.equal(initialReviewValues(blank(), form(), categories, NOW).reference, '');
  console.log('ok: reference only from the receipt');
}

console.log('receiptReview: all passed');
