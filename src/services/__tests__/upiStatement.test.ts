/**
 * Google Pay / UPI-app statement reader. All statement text here is invented, laid out the way the real statement is:
 * date + payee + amount on one row, the time + UPI id on the next row, the account line below.
 *
 * VELNORA_REAL_PDF_JSON=<file> additionally runs the reader over the server's extraction of a real statement
 * (kept outside the repository, because it holds personal data) and checks it against the totals the statement prints.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isUpiStatement, parseAmountPaise, parseUpiStatement } from '../upiStatementParser.ts';
import { parsePdfStatement } from '../pdfStatementParser.ts';

let passed = 0;
async function test(name: string, fn: () => unknown) { await fn(); passed += 1; console.log(`✓ ${name}`); }

const W = 96;
const row = (left: string, mid: string, amount = '') => `${left.padEnd(16)}${mid}`.padEnd(W - amount.length) + amount;
const HEADER = ['Transaction statement', '9999999999, someone@example.com', row('Transaction statement period', '', 'Sent') + '        Received', row('01 October 2026 - 31 October 2026', '', '₹100.50') + '       ₹200'];
const COLS = row('Date & time', 'Transaction details', 'Amount');
const NOTE = ['Note: This statement reflects payments made by you on the Google Pay app. Self transfer payments are not included in the total money paid and', 'received. Any payments transactions and activity deleted from your Google Account will not show up in this statement.'];
const tx = (date: string, time: string, who: string, id: string, account: string, amount: string) => [row(date, who, amount), row(time, `UPI Transaction ID: ${id}`), `${' '.repeat(16)}${account}`];
const out = (date: string, time: string, who: string, id: string, amount: string, bank = 'State Bank of India 4823') => tx(date, time, `Paid to ${who}`, id, `Paid by ${bank}`, amount);
const inn = (date: string, time: string, who: string, id: string, amount: string, bank = 'State Bank of India 4823') => tx(date, time, `Received from ${who}`, id, `Paid to ${bank}`, amount);
const page = (n: number, total: number, ...txs: string[][]) => [...(n === 1 ? HEADER : ['Transaction statement', '9999999999, someone@example.com']), COLS, ...txs.flat(), ...NOTE, `Page ${n} of ${total}`];

const SAMPLE = [page(1, 1,
  inn('01 Oct, 2026', '01:28 PM', 'Asha Rao', '627404356150', '₹100'),
  out('01 Oct, 2026', '06:43 PM', 'Night canteen', '627425966121', '₹43'),
  out('01 Oct, 2026', '07:02 PM', 'Night canteen', '664027330542', '₹43', 'Bank of Baroda 6044'),
  tx('02 Oct, 2026', '10:22 AM', 'Self transfer to Bank of Baroda 6044', '628969853628', 'Paid by State Bank of India 4823', '₹300'),
)];

async function main() {
  await test('format is recognised from the Date & time / Transaction details / Amount header and UPI ids', () => {
    assert.equal(isUpiStatement(SAMPLE), true);
    assert.equal(isUpiStatement([['Date  Narration  Debit  Credit', '01/10/2026 SWIGGY 120.00']]), false);
  });

  await test('"Received from" is money in, "Paid to" is money out, whatever the account line wording under it', () => {
    const r = parsePdfStatement(SAMPLE);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rows.map((x) => [x.narration, x.direction, x.kind, x.amount]), [
      ['Received from Asha Rao', 'income', 'payment', 100],
      ['Paid to Night canteen', 'expense', 'payment', 43],
      ['Paid to Night canteen', 'expense', 'payment', 43],
      ['Self transfer to Bank of Baroda 6044', 'expense', 'transfer', 300],
    ]);
  });

  await test('merchant, UPI id, bank and account suffix are separate fields; none leaks into the description', () => {
    const [income, expense] = parsePdfStatement(SAMPLE).rows;
    assert.equal(income.counterparty, 'Asha Rao');
    assert.equal(expense.counterparty, 'Night canteen');
    assert.deepEqual([income.referenceId, income.bankName, income.accountLast4], ['627404356150', 'State Bank of India', '4823']);
    assert.deepEqual([expense.bankName, expense.accountLast4], ['State Bank of India', '4823']);
    for (const r of parsePdfStatement(SAMPLE).rows) assert.doesNotMatch(r.narration, /UPI|\d{2} Oct|2026|State Bank|4823|PM/);
    assert.equal(income.timeText, '01:28 PM');
  });

  await test('the same payee and amount with different UPI ids are two transactions with their own identities', () => {
    const rows = parsePdfStatement(SAMPLE).rows;
    assert.notEqual(rows[1].referenceId, rows[2].referenceId);
    assert.notEqual(rows[1].fingerprint, rows[2].fingerprint);
    assert.equal(rows[2].accountLast4, '6044');
  });

  await test('dates keep the statement day and printed time; the import day is never used', () => {
    const rows = parsePdfStatement(SAMPLE).rows;
    const d = new Date(rows[0].date);
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), rows[0].hasTime], [2026, 9, 1, 13, 28, true]);
    const pm = new Date(rows[1].date);
    assert.deepEqual([pm.getHours(), pm.getMinutes()], [18, 43]);
  });

  await test('amounts: Indian grouping, decimals, symbols; ids, dates, times and page numbers are never money', () => {
    const cases: [string, number | null][] = [['₹43', 4300], ['₹200', 20000], ['₹1250', 125000], ['₹1,250', 125000], ['₹1,250.00', 125000], ['₹1,25,000', 12500000],
      ['₹1,25,000.00', 12500000], ['INR 1250.00', 125000], ['Rs. 1250', 125000], ['Rs 1,250.00', 125000], ['₹30,383.88', 3038388], ['₹1,25', null], ['₹12,34', null], ['62742596121x', null]];
    for (const [text, want] of cases) assert.equal(parseAmountPaise(text), want, text);
    const withIdOnly = parseUpiStatement([['Date & time  Transaction details  Amount', '01 Oct, 2026   Paid to Shop', '01:28 PM   UPI Transaction ID: 62742596121', '    Paid by State Bank of India 4823']]);
    assert.equal(withIdOnly.records[0].amountPaise, null, 'a UPI id, bank digits or time is not an amount');
  });

  await test('a missing amount is withheld and never borrowed from the next transaction', () => {
    const lines = page(1, 1, out('01 Oct, 2026', '06:43 PM', 'Night canteen', '627425966121', ''), inn('02 Oct, 2026', '05:52 PM', 'Aksh', '130593396828', '₹200'));
    const r = parsePdfStatement([lines]);
    assert.deepEqual(r.rows.map((x) => x.amount), [200]);
    assert.equal(r.withheld!.length, 1);
    assert.ok(r.withheld![0].reasons.includes('Missing amount'));
    assert.equal(r.withheld![0].choosable, null, 'with no amount there is nothing the person could confirm');
  });

  await test('conflicting or missing direction evidence is withheld with the evidence, never classed as an expense', () => {
    const conflict = tx('01 Oct, 2026', '06:43 PM', 'Paid to Night canteen', '627425966121', 'Paid to State Bank of India 4823', '₹43');
    const unknown = tx('02 Oct, 2026', '06:43 PM', 'Night canteen', '627425966122', 'Some line', '₹50');
    const r = parsePdfStatement([page(1, 1, conflict, unknown)]);
    assert.equal(r.rows.length, 0);
    assert.ok(r.withheld![0].reasons.includes('Conflicting direction'));
    assert.ok(r.withheld![1].reasons.includes('Unknown direction'));
    assert.equal(r.withheld![0].choosable?.amount, 43, 'date and amount are certain, so the person may choose the direction');
    assert.ok(r.withheld![0].original.length >= 3, 'the original lines are kept for the review screen');
  });

  await test('refund and reversal wording is money back, not income; own transfers are not income or expense', () => {
    const lines = page(1, 1,
      tx('01 Oct, 2026', '06:43 PM', 'Refund from Night canteen', '627425966121', 'Paid to State Bank of India 4823', '₹43'),
      tx('02 Oct, 2026', '06:43 PM', 'Payment reversed', '627425966122', 'Paid to State Bank of India 4823', '₹50'),
      tx('03 Oct, 2026', '06:43 PM', 'Self transfer to State Bank of India 4823', '627425966123', 'Paid by Bank of Baroda 6044', '₹300'));
    const r = parsePdfStatement([lines]);
    assert.deepEqual(r.rows.map((x) => [x.direction, x.kind]), [['income', 'refund'], ['income', 'reversal'], ['expense', 'transfer']]);
  });

  await test('a block continues across a page break and a page break never merges two payments', () => {
    const a = out('01 Oct, 2026', '06:43 PM', 'Night canteen', '627425966121', '₹43');
    const first = [...HEADER, COLS, ...a.slice(0, 2)];
    const second = ['Transaction statement', COLS, a[2], ...inn('02 Oct, 2026', '05:52 PM', 'Aksh', '130593396828', '₹200')];
    const r = parsePdfStatement([first, second]);
    assert.deepEqual(r.rows.map((x) => [x.amount, x.referenceId, x.accountLast4]), [[43, '627425966121', '4823'], [200, '130593396828', '4823']]);
  });

  await test('layout noise does not break it: glued words, doubled spaces, missing space before the account digits', () => {
    const messy = [
      ...HEADER, 'Date  &  time        Transaction   details          Amount',
      '31Oct,  2026         Paid  to  Go  Grab                                   ₹20',
      '06:23 PM             UPI Transaction   ID:630440103840',
      '                     Paid by State Bank  of India4823',
    ];
    const r = parsePdfStatement([messy]);
    assert.deepEqual(r.rows.map((x) => [x.narration, x.amount, x.referenceId, x.bankName, x.accountLast4]), [['Paid to Go Grab', 20, '630440103840', 'State Bank of India', '4823']]);
  });

  await test('an extra id or time inside a block starts a new record instead of merging into the previous one', () => {
    const lines = [...HEADER, COLS, ...out('01 Oct, 2026', '06:43 PM', 'Night canteen', '627425966121', '₹43'), row('07:00 PM', 'UPI Transaction ID: 999999999999'), '                Paid by State Bank of India 4823'];
    const r = parseUpiStatement([lines]);
    assert.equal(r.records.length, 2);
    assert.ok(r.records[1].reviewReasons.includes('Missing date'));
    assert.equal(parsePdfStatement([lines]).rows.length, 1);
  });

  await test('reconciliation: computed totals match the totals the statement prints, and say so when they do not', () => {
    const good = parseUpiStatement([page(1, 1, out('01 Oct, 2026', '06:43 PM', 'Night canteen', '627425966121', '₹100.50'), inn('02 Oct, 2026', '05:52 PM', 'Aksh', '130593396828', '₹200'),
      tx('03 Oct, 2026', '09:00 AM', 'Self transfer to Bank of Baroda 6044', '628969853628', 'Paid by State Bank of India 4823', '₹999'))]);
    assert.equal(good.reconciliation.status, 'matched');
    assert.deepEqual(good.reconciliation.computed, { sentPaise: 10050, receivedPaise: 20000 });
    const bad = parseUpiStatement([page(1, 1, out('01 Oct, 2026', '06:43 PM', 'Night canteen', '627425966121', '₹100.50'))]);
    assert.equal(bad.reconciliation.status, 'mismatch');
    assert.equal(bad.reconciliation.receivedDifferencePaise, -20000);
  });

  await test('a record that could not be read makes the reconciliation a mismatch, not a quiet success', () => {
    const r = parseUpiStatement([page(1, 1, out('01 Oct, 2026', '06:43 PM', 'Night canteen', '627425966121', '₹100.50'), inn('02 Oct, 2026', '05:52 PM', 'Aksh', '130593396828', ''))]);
    assert.equal(r.reconciliation.status, 'mismatch');
    assert.equal(r.reconciliation.withheldCount, 1);
  });

  await test('a repeated UPI id inside one statement is flagged for review, not silently dropped or doubled', () => {
    const r = parsePdfStatement([page(1, 1, out('01 Oct, 2026', '06:43 PM', 'Night canteen', '627425966121', '₹43'), out('02 Oct, 2026', '06:43 PM', 'Night canteen', '627425966121', '₹43'))]);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows.map((x) => x.reviewReasons), [[], ['Duplicate reference']]);
    assert.equal(r.rows[1].needsReview, true);
  });

  await test('a missing UPI id is not invented and identical lines keep distinct, stable fingerprints', () => {
    const noId = (t: string) => [row('01 Oct, 2026', 'Paid to Night canteen', '₹43'), row(t, ''), `${' '.repeat(16)}Paid by State Bank of India 4823`];
    const run = () => parsePdfStatement([[...HEADER, COLS, ...noId('06:43 PM'), ...noId('06:43 PM')]]).rows;
    const [a, b] = run();
    assert.equal(a.referenceId, ''); assert.notEqual(a.fingerprint, b.fingerprint);
    assert.deepEqual(run().map((x) => x.fingerprint), [a.fingerprint, b.fingerprint], 'the same file re-read gives the same keys');
  });

  await test('large statements: 100 pages, every record on every page, progress reported page by page', () => {
    const pages: string[][] = [];
    let n = 0; let sent = 0; let received = 0;
    for (let p = 1; p <= 100; p += 1) {
      const txs: string[][] = [];
      for (let i = 0; i < 10; i += 1) {
        n += 1; const paise = (n % 97) + 1; const id = String(600000000000 + n);
        if (n % 4 === 0) { received += paise; txs.push(inn('05 Oct, 2026', `${String((n % 11) + 1).padStart(2, '0')}:15 AM`, `Friend ${n}`, id, `₹${paise}`)); }
        else { sent += paise; txs.push(out('05 Oct, 2026', `${String((n % 11) + 1).padStart(2, '0')}:15 PM`, `Shop ${n % 7}`, id, `₹${paise}`)); }
      }
      pages.push(page(p, 100, ...txs));
    }
    const seen: number[] = [];
    const started = Date.now();
    const r = parseUpiStatement(pages, (p) => seen.push(p));
    assert.equal(r.records.length, 1000);
    assert.deepEqual(r.recordsPerPage, new Array(100).fill(10));
    assert.equal(seen.length, 100);
    assert.equal(new Set(r.records.map((x) => x.reference)).size, 1000);
    assert.deepEqual(r.reconciliation.computed, { sentPaise: sent * 100, receivedPaise: received * 100 });
    assert.ok(Date.now() - started < 5000, 'parses in well under a second per hundred pages');
  });

  await test('privacy: reading a statement logs nothing', () => {
    const logged: unknown[] = []; const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...a: unknown[]) => { logged.push(a); };
    try { parsePdfStatement(SAMPLE); } finally { Object.assign(console, orig); }
    assert.equal(logged.length, 0);
  });

  const realPath = process.env.VELNORA_REAL_PDF_JSON;
  if (realPath && existsSync(realPath)) {
    await test('REAL statement: every page and record read, directions classified, totals equal the statement\'s own', () => {
      const body = JSON.parse(readFileSync(realPath, 'utf8')) as { pages: string[][]; page_count: number; pages_processed: number; page_issues: unknown[] };
      assert.equal(body.pages.length, body.page_count);
      assert.equal(body.pages_processed, body.page_count);
      assert.deepEqual(body.page_issues, []);
      const r = parseUpiStatement(body.pages);
      const by = (d: string) => r.records.filter((x) => x.direction === d).length;
      console.log(`  real statement: ${body.page_count} pages, ${r.records.length} records (income ${by('income')}, expense ${by('expense')}, transfer ${by('transfer')}, unknown ${by('unknown')}), withheld ${r.reconciliation.withheldCount}, flagged ${r.records.filter((x) => x.reviewReasons.length).length}`);
      console.log(`  stated sent ${r.totals.sentPaise}, received ${r.totals.receivedPaise}; computed ${r.reconciliation.computed.sentPaise}, ${r.reconciliation.computed.receivedPaise}; status ${r.reconciliation.status}`);
      assert.equal(r.reconciliation.status, 'matched');
      assert.equal(r.records.length, r.recordsPerPage.reduce((a, b) => a + b, 0));
      assert.ok(r.recordsPerPage.every((c) => c > 0), 'no page was skipped');
      assert.equal(new Set(r.records.map((x) => x.reference)).size, r.records.length, 'every record has its own UPI id');
      assert.equal(r.records.filter((x) => x.reviewReasons.length).length, 0);
    });
  } else console.log('- REAL statement test skipped (set VELNORA_REAL_PDF_JSON to the extracted statement JSON)');

  console.log(`\n${passed} UPI statement tests passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
