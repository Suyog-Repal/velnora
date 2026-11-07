import assert from 'node:assert/strict';
import { greetingForIndia, msUntilGreetingChange } from '../greeting.ts';
import {
  daysInMonth, formatDisplayDate, formatDisplayTime, formatRange, inDateRange, isWithin, localYmd, monthCells, parseYmd,
  rangeToIsoInterval, shiftMonth, toYmd, validateRange,
} from '../dateUtils.ts';
import { createSyncNotifier } from '../syncNotices.ts';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

// IST = UTC+05:30, so IST HH:MM on a given day is UTC (HH:MM − 5:30).
const ist = (h: number, m = 0, s = 0) => new Date(Date.UTC(2026, 10, 7, h, m, s) - 330 * 60 * 1000);

// ── Greeting ────────────────────────────────────────────────────────────────
test('greeting: morning 05:00–11:59 IST', () => {
  assert.equal(greetingForIndia(ist(5, 0)), 'Good morning');
  assert.equal(greetingForIndia(ist(8, 30)), 'Good morning');
  assert.equal(greetingForIndia(ist(11, 59, 59)), 'Good morning');
});
test('greeting: afternoon 12:00–16:59 IST', () => {
  assert.equal(greetingForIndia(ist(12, 0)), 'Good afternoon');
  assert.equal(greetingForIndia(ist(16, 59, 59)), 'Good afternoon');
});
test('greeting: evening 17:00–20:59 IST', () => {
  assert.equal(greetingForIndia(ist(17, 0)), 'Good evening');
  assert.equal(greetingForIndia(ist(20, 59, 59)), 'Good evening');
});
test('greeting: night 21:00–04:59 IST, including midnight', () => {
  assert.equal(greetingForIndia(ist(21, 0)), 'Good night');
  assert.equal(greetingForIndia(ist(23, 59, 59)), 'Good night');
  assert.equal(greetingForIndia(ist(0, 0)), 'Good night');
  assert.equal(greetingForIndia(ist(4, 59, 59)), 'Good night');
});
test('greeting: follows IST even when the UTC date differs (18:30 UTC is already 00:00 IST next day)', () => {
  assert.equal(greetingForIndia(new Date('2026-11-07T18:30:00Z')), 'Good night');
  assert.equal(greetingForIndia(new Date('2026-11-07T23:30:00Z')), 'Good morning'); // 05:00 IST
});
test('greeting: msUntilGreetingChange lands exactly on the next boundary', () => {
  assert.equal(msUntilGreetingChange(ist(11, 59, 0)), 60_000);
  assert.equal(msUntilGreetingChange(ist(16, 0, 0)), 60 * 60_000);
  assert.equal(msUntilGreetingChange(ist(20, 30, 0)), 30 * 60_000);
  assert.equal(msUntilGreetingChange(ist(23, 0, 0)), 6 * 60 * 60_000);      // → 05:00 next day
  assert.equal(msUntilGreetingChange(ist(2, 0, 0)), 3 * 60 * 60_000);       // → 05:00 same day
  assert.ok(msUntilGreetingChange(ist(5, 0, 0)) > 0);
  const after = new Date(ist(11, 59, 30).getTime() + msUntilGreetingChange(ist(11, 59, 30)));
  assert.equal(greetingForIndia(after), 'Good afternoon');
});

// ── Dates / calendar ────────────────────────────────────────────────────────
test('calendar: month grid sizes and weekday offsets', () => {
  assert.equal(daysInMonth(2026, 1), 28); assert.equal(daysInMonth(2028, 1), 29); assert.equal(daysInMonth(2026, 10), 30);
  const nov = monthCells(2026, 10); // 1 Nov 2026 is a Sunday
  assert.equal(nov[0], 1); assert.equal(nov.filter(Boolean).length, 30); assert.equal(nov.length % 7, 0);
  const jan = monthCells(2026, 0);  // 1 Jan 2026 is a Thursday
  assert.deepEqual(jan.slice(0, 5), [null, null, null, null, 1]);
});
test('calendar: month navigation wraps years', () => {
  assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month0: 0 });
  assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month0: 11 });
  assert.deepEqual(shiftMonth(2026, 5, 0), { year: 2026, month0: 5 });
});
test('dates: parse rejects impossible dates, formats are friendly', () => {
  assert.equal(parseYmd('2026-02-31'), null); assert.equal(parseYmd('nope'), null); assert.ok(parseYmd('2028-02-29'));
  assert.equal(formatDisplayDate('2026-11-07'), '07 Nov 2026'); assert.equal(formatDisplayDate('x'), '');
  assert.equal(formatDisplayTime('19:05'), '07:05 PM'); assert.equal(formatDisplayTime('00:00'), '12:00 AM'); assert.equal(formatDisplayTime('12:30'), '12:30 PM');
  assert.equal(toYmd(2026, 10, 7), '2026-11-07');
  assert.equal(localYmd(new Date(2026, 10, 7, 23, 59)), '2026-11-07');
  assert.equal(isWithin('2026-11-07', '2026-11-07', '2026-11-07'), true); assert.equal(isWithin('2026-11-08', null, '2026-11-07'), false);
  assert.equal(formatRange('2026-11-01', '2026-11-07'), '01 Nov 2026 – 07 Nov 2026'); assert.equal(formatRange(), 'All dates');
});

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).toISOString(); // device-local → stored ISO
test('filter: start and end dates are inclusive, including 00:00 and 23:59:59 on the boundaries', () => {
  const from = '2026-11-03'; const to = '2026-11-05';
  assert.equal(inDateRange(at(2026, 11, 2, 23, 59, 59), from, to), false);
  assert.equal(inDateRange(at(2026, 11, 3, 0, 0, 0), from, to), true);
  assert.equal(inDateRange(at(2026, 11, 4, 12), from, to), true);
  assert.equal(inDateRange(at(2026, 11, 5, 23, 59, 59), from, to), true);   // last moment of the end day is NOT dropped
  assert.equal(inDateRange(at(2026, 11, 6, 0, 0, 0), from, to), false);
});
test('filter: same-day range, one-sided ranges and no filter', () => {
  assert.equal(inDateRange(at(2026, 11, 7, 9), '2026-11-07', '2026-11-07'), true);
  assert.equal(inDateRange(at(2026, 11, 7, 23, 59), '2026-11-07', '2026-11-07'), true);
  assert.equal(inDateRange(at(2026, 11, 8, 0, 1), '2026-11-07', '2026-11-07'), false);
  assert.equal(inDateRange(at(2026, 1, 1), '2026-06-01', null), false); assert.equal(inDateRange(at(2026, 12, 1), '2026-06-01', null), true);
  assert.equal(inDateRange(at(2026, 1, 1), null, null), true);
});
test('range: validation messages and ISO interval for analytics', () => {
  assert.equal(validateRange('2026-11-01', '2026-11-07').ok, true);
  assert.equal(validateRange('2026-11-07', '2026-11-07').ok, true);
  const bad = validateRange('2026-11-08', '2026-11-07'); assert.equal(bad.ok, false); assert.match(bad.ok ? '' : bad.error, /cannot be before/);
  assert.equal(validateRange(null, '2026-11-07').ok, false);
  const iv = rangeToIsoInterval('2026-11-03', '2026-11-05')!;
  assert.equal(iv.start, at(2026, 11, 3)); assert.equal(iv.end, at(2026, 11, 6)); // half-open: includes all of 5 Nov
  assert.ok(at(2026, 11, 5, 23, 59, 59) >= iv.start && at(2026, 11, 5, 23, 59, 59) < iv.end);
  assert.equal(rangeToIsoInterval('bad', '2026-11-05'), null);
});

// ── Notifications ───────────────────────────────────────────────────────────
function harness() {
  const shown: { message: string; kind: string; key: string }[] = [];
  const n = createSyncNotifier((message, kind, key) => shown.push({ message, kind, key }));
  return { n, shown, messages: () => shown.map((s) => s.message) };
}
test('notices: guest saves are local-only and never claim a sync', () => {
  const h = harness();
  h.n.localSave('expense', false); h.n.localSave('income', false);
  assert.deepEqual(h.messages(), ['Expense saved on this device', 'Income saved on this device']);
  h.n.syncResult({ pushed: 3, errors: [] });
  assert.equal(h.shown.length, 2); assert.equal(h.n.pending, false);
});
test('notices: signed-in save confirms locally, then "synced" only after a confirmed push', () => {
  const h = harness();
  h.n.localSave('income', true);
  assert.deepEqual(h.messages(), ['Income recorded successfully']);
  h.n.syncResult({ pushed: 0, errors: ['Sync already in progress'] });   // overlapping sync: nothing confirmed, nothing said
  h.n.syncResult({ pushed: 0, errors: [] });                              // nothing pushed yet
  assert.equal(h.shown.length, 1); assert.equal(h.n.pending, true);
  h.n.syncResult({ pushed: 1, errors: [] });
  assert.deepEqual(h.messages(), ['Income recorded successfully', 'Transaction synced successfully']);
  h.n.syncResult({ pushed: 2, errors: [] });                              // later background sync: no duplicate
  assert.equal(h.shown.length, 2); assert.equal(h.n.pending, false);
});
test('notices: failed sync says "saved offline" once, keeps the change pending, then confirms when a retry succeeds', () => {
  const h = harness();
  h.n.localSave('expense', true);
  h.n.syncResult({ pushed: 0, errors: ['Network request failed'] });
  h.n.syncResult({ pushed: 0, errors: ['Network request failed'] });      // retries stay silent
  h.n.syncResult({ pushed: 0, errors: ['HTTP 503'] });
  assert.deepEqual(h.messages(), ['Expense recorded successfully', 'Transaction saved offline. Sync will retry.']);
  assert.equal(h.shown[1].kind, 'warning'); assert.equal(h.n.pending, true);
  h.n.syncResult({ pushed: 1, errors: [] });
  assert.equal(h.messages().at(-1), 'Transaction synced successfully');
});
test('notices: a pull-only/background failure with nothing pending stays quiet; edits are announced too', () => {
  const h = harness();
  h.n.syncResult({ pushed: 0, errors: ['Network request failed'] });
  assert.equal(h.shown.length, 0);
  h.n.localSave('edit', true); h.n.localSave('edit', false);
  assert.deepEqual(h.messages(), ['Changes saved', 'Changes saved on this device']);
});

console.log(`\n${passed} UI helper tests passed`);
