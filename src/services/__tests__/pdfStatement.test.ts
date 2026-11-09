/**
 * PDF statement import: layout parsing, categorisation, the pipeline's failure states, and (against the real services and
 * SQLite) duplicate handling, persistence, sync queueing and totals. All statement text is invented. The PDF-to-text
 * step runs on the server (backend/app/test_statements.py); here its output is supplied as page text.
 */
import assert from 'node:assert/strict';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import { setCustomDatabase } from '../../db/database.ts';
import { addTransaction, setTransactionServiceAdapter } from '../transactionService.ts';
import { getCashFlowSummary } from '../cashFlowService.ts';
import { processIncomingSms } from '../smsIntegrationService.ts';
import { breakdownForMonth } from '../analyticsService.ts';
import { buildMonthly, loadPoints, totalsOf } from '../cashFlowSeries.ts';
import { rememberAlias } from '../merchantAliasService.ts';
import { parsePdfStatement } from '../pdfStatementParser.ts';
import { PDF_FAILURE_MESSAGES, readPdfStatement, validatePdfFile, type PdfExtractPort } from '../pdfStatementImport.ts';
import { categorizeRow, categorizeRows } from '../statementCategorizer.ts';
import { applyStatement, defaultExcludedLines, flagStatementOverlaps, parseStatementCsv, previewStatement, type StatementRow } from '../statementImport.ts';
import type { IDatabase, Session } from '../../db/types.ts';

const A: Session = { user: { id: 'user-A', full_name: 'A', email: 'a@x.com' }, access_token: 't1', refresh_token: 'r', token_type: 'bearer' };

/** Places each text at a column; `R` right-aligns a number so it ends at that column, like a printed amount. */
const L = (...cells: [number, string][]) => cells.reduce((line, [at, text]) => line.padEnd(at, ' ') + text, '');
const R = (end: number, text: string): [number, string] => [end - text.length, text];
const HEADER = L([0, 'Date'], [14, 'Narration'], [52, 'Chq/Ref No'], [70, 'Withdrawal Amt.'], [90, 'Deposit Amt.'], [110, 'Closing Balance']);
const tx = (date: string, narration: string, ref: string, debit: string, credit: string, balance: string) =>
  L([0, date], [14, narration], ...(ref ? [[52, ref] as [number, string]] : []), ...(debit ? [R(85, debit)] : []), ...(credit ? [R(105, credit)] : []), R(125, balance));
const ymd = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const PAGE_1 = [
  'HDFC BANK LIMITED  Statement of Account',
  'Statement period: 01/10/2026 to 31/10/2026',
  HEADER,
  L([14, 'Opening Balance'], R(125, '1,00,000.00')),
  tx('01/10/2026', 'UPI-SWIGGY-swiggy@icici', '412345678901', '1,250.00', '', '98,750.00'),
  tx('02/10/2026', 'NEFT CR-ACME CORP-SALARY OCT', 'N123456789', '', '1,25,000.00', '2,23,750.00'),
  L([14, 'UPI-AMAZON PAY INDIA PRIVATE'], R(85, '999.00'), R(125, '2,22,751.00')) && tx('03/10/2026', 'UPI-AMAZON PAY INDIA PRIVATE', '', '999.00', '', '2,22,751.00'),
  L([14, 'LIMITED-ORDER 4411']),
  'Page 1 of 2',
];
const PAGE_2 = [
  HEADER,
  tx('05/10/2026', 'ATM WDL-MG ROAD', '', '2,000.00', '', '2,20,751.00'),
  tx('06/10/2026', 'RANDOM SHOP PVT', '', '350.50', '', '2,20,400.50'),
  tx('06/10/2026', 'RANDOM SHOP PVT', '', '350.50', '', '2,20,050.00'),
  L([14, 'Closing Balance'], R(125, '2,20,050.00')),
  'Page 2 of 2',
];

let passed = 0;
async function test(name: string, fn: () => unknown) { await fn(); passed += 1; console.log(`✓ ${name}`); }
const text = (p: StatementRow[]) => p.map((r) => `${ymd(r.date)}|${r.direction}|${r.amount}|${r.narration}`);

async function fresh(): Promise<IDatabase> {
  const db = new NodeSqliteAdapter(); await runMigrations(db);
  setCustomDatabase(db); setTransactionServiceAdapter(db);
  (globalThis as { fetch: unknown }).fetch = async () => { throw new Error('offline'); };
  return db as unknown as IDatabase;
}
const live = (db: IDatabase) => db.getAllAsync<Record<string, unknown>>('SELECT * FROM transactions WHERE deleted_at IS NULL ORDER BY transaction_date, created_at');

async function main() {
  // ── parsing ──
  await test('standard statement: columns, Indian amounts, wrapped description, repeated header, opening/closing balance', () => {
    const r = parsePdfStatement([PAGE_1, PAGE_2]);
    assert.deepEqual(r.errors, []);
    assert.equal(r.meta.bankName, 'HDFC Bank');
    assert.deepEqual([r.meta.openingBalance, r.meta.closingBalance, r.meta.headerFound], [100000, 220050, true]);
    assert.deepEqual(text(r.rows), [
      '2026-10-01|expense|1250|UPI-SWIGGY-swiggy@icici',
      '2026-10-02|income|125000|NEFT CR-ACME CORP-SALARY OCT',
      '2026-10-03|expense|999|UPI-AMAZON PAY INDIA PRIVATE LIMITED-ORDER 4411',
      '2026-10-05|expense|2000|ATM WDL-MG ROAD',
      '2026-10-06|expense|350.5|RANDOM SHOP PVT',
      '2026-10-06|expense|350.5|RANDOM SHOP PVT',
    ]);
    assert.equal(r.rows[0].referenceId, '412345678901');
    assert.equal(r.rows[0].balance, 98750);
    assert.equal(r.rows[3].referenceId, '', 'a missing reference is not invented');
    assert.equal(r.rows[3].kind, 'cash_withdrawal');
    assert.notEqual(r.rows[4].fingerprint, r.rows[5].fingerprint, 'two identical lines stay two transactions');
    assert.deepEqual(r.rows.map((x) => x.origin), Array(6).fill('pdf'));
  });
  await test('the transaction date is the printed date, never today', () => {
    const r = parsePdfStatement([PAGE_1, PAGE_2]);
    assert.equal(ymd(r.rows[0].date), '2026-10-01');
    assert.equal(r.rows[0].hasTime, undefined);
  });
  await test('single Amount column with Dr/Cr, DD MMM YYYY, and no balance column', () => {
    const r = parsePdfStatement([[
      L([0, 'Txn Date'], [16, 'Description'], [60, 'Amount']),
      L([0, '05 Nov 2026'], [16, 'Netflix subscription'], R(75, '649.00 Dr')),
      L([0, '07 Nov 2026'], [16, 'Interest credit'], R(75, '125.75 Cr')),
    ]]);
    assert.deepEqual(text(r.rows), ['2026-11-05|expense|649|Netflix subscription', '2026-11-07|income|125.75|Interest credit']);
  });
  await test('amount and balance only: the running balance decides the direction', () => {
    const r = parsePdfStatement([[
      L([0, 'Date'], [16, 'Particulars'], [60, 'Amount'], [80, 'Balance']),
      L([14 - 14, '01-11-2026'], [16, 'Opening Balance'], R(95, '10,000.00')),
      L([0, '02-11-2026'], [16, 'UPI-RAHUL'], R(70, '500.00'), R(95, '9,500.00')),
      L([0, '03-11-2026'], [16, 'UPI-PRIYA'], R(70, '1,500.00'), R(95, '11,000.00')),
    ]]);
    assert.deepEqual(text(r.rows), ['2026-11-02|expense|500|UPI-RAHUL', '2026-11-03|income|1500|UPI-PRIYA']);
  });
  await test('a row whose direction cannot be told is reported, not guessed', () => {
    const r = parsePdfStatement([[
      L([0, 'Date'], [16, 'Particulars'], [60, 'Amount']),
      L([0, '02-11-2026'], [16, 'UPI-RAHUL'], R(75, '500.00')),
    ]]);
    assert.equal(r.rows.length, 0);
    assert.equal(r.errors[0].reason, 'Could not tell money in from money out');
  });
  await test('newest-first statements are read correctly', () => {
    const r = parsePdfStatement([[
      L([0, 'Date'], [16, 'Particulars'], [60, 'Amount'], [80, 'Balance']),
      L([0, '03-11-2026'], [16, 'UPI-PRIYA'], R(70, '1,500.00'), R(95, '11,000.00')),
      L([0, '02-11-2026'], [16, 'UPI-RAHUL'], R(70, '500.00'), R(95, '9,500.00')),
      L([0, '01-11-2026'], [16, 'UPI-OLDER'], R(70, '200.00'), R(95, '10,000.00')),
    ]]);
    assert.deepEqual(r.rows.slice(0, 2).map((x) => x.direction), ['income', 'expense']);
  });
  await test('dates without a year take it from the statement period, across a year end', () => {
    const r = parsePdfStatement([[
      'Account statement from 15 Dec 2026 to 14 Jan 2027',
      L([0, 'Date'], [14, 'Narration'], [60, 'Debit'], [80, 'Credit']),
      L([0, '20 Dec'], [14, 'UPI-ZOMATO'], R(65, '300.00')),
      L([0, '05 Jan'], [14, 'SALARY ACME'], R(85, '50,000.00')),
    ]]);
    assert.deepEqual(r.rows.map((x) => ymd(x.date)), ['2026-12-20', '2027-01-05']);
  });
  await test('without a period, a date with no year is an error, not a guess', () => {
    const r = parsePdfStatement([[L([0, 'Date'], [14, 'Narration'], [60, 'Debit'], [80, 'Credit']), L([0, '20 Dec'], [14, 'UPI-ZOMATO'], R(65, '300.00'))]]);
    assert.equal(r.rows.length, 0);
  });
  await test('a printed time is kept; a statement without one gets none', () => {
    const r = parsePdfStatement([[
      L([0, 'Date'], [22, 'Narration'], [60, 'Debit'], [80, 'Credit']),
      L([0, '01/11/2026 14:32:10'], [22, 'UPI-METRO'], R(65, '40.00')),
    ]]);
    assert.equal(r.rows[0].hasTime, true);
    const d = new Date(r.rows[0].date);
    assert.deepEqual([d.getHours(), d.getMinutes(), d.getSeconds()], [14, 32, 10]);
  });
  await test('debit-only and credit-only statements; currency symbols and spaces in amounts', () => {
    const debits = parsePdfStatement([[L([0, 'Date'], [14, 'Narration'], [60, 'Debit'], [80, 'Credit']), L([0, '01/11/2026'], [14, 'SHOP A'], R(68, '₹1,25,000.00')), L([0, '02/11/2026'], [14, 'SHOP B'], R(68, 'INR 2,500.50'))]]);
    assert.deepEqual(debits.rows.map((x) => [x.direction, x.amount]), [['expense', 125000], ['expense', 2500.5]]);
    const credits = parsePdfStatement([[L([0, 'Date'], [14, 'Narration'], [60, 'Debit'], [80, 'Credit']), L([0, '01/11/2026'], [14, 'REFUND AMAZON'], R(88, '1,299.00'))]]);
    assert.deepEqual(credits.rows.map((x) => [x.direction, x.kind]), [['income', 'refund']]);
  });
  await test('unsupported layouts, empty text and foreign currency are recognised', async () => {
    assert.equal(parsePdfStatement([['Dear customer,', 'Your electricity bill is due on 01/11/2026']]).meta.headerFound, false);
    assert.equal(parsePdfStatement([[]]).rows.length, 0);
    assert.equal(parsePdfStatement([[L([0, 'Date'], [14, 'Description'], [60, 'Debit'], [80, 'Credit']), L([0, '01/11/2026'], [14, 'Hotel Paris'], R(68, '120.00 EUR'))]]).meta.unsupportedCurrency, true);
  });

  // ── pipeline ──
  const file = { uri: 'file:///cache/s.pdf', name: 'statement.pdf', mimeType: 'application/pdf', size: 1000 };
  const okBody = { status: 'text', page_count: 2, pages: [PAGE_1, PAGE_2] };
  const port = (responses: { httpStatus: number; body: unknown }[]): PdfExtractPort & { calls: string[] } => {
    const calls: string[] = [];
    return { calls, async extract(_f, s) { calls.push(s.access_token); const r = responses.shift(); if (!r) throw new Error('network'); return r; } };
  };
  await test('file validation: type, extension, empty, large', () => {
    assert.equal(validatePdfFile({ ...file, name: 'a.csv' }), 'not_pdf');
    assert.equal(validatePdfFile({ ...file, mimeType: 'image/png' }), 'not_pdf');
    assert.equal(validatePdfFile({ ...file, size: 0 }), 'empty_file');
    assert.equal(validatePdfFile({ ...file, size: 11 * 1024 * 1024 }), 'too_large');
    assert.equal(validatePdfFile(file), null);
  });
  await test('pipeline: success, and each failure has its own state and message', async () => {
    const ok = await readPdfStatement(file, A, port([{ httpStatus: 200, body: okBody }]));
    assert.ok(ok.ok && ok.rows.length === 6 && ok.pageCount === 2);
    const reason = async (res: { httpStatus: number; body: unknown } | null, f = file, s: Session | null = A) =>
      (await readPdfStatement(f, s, port(res ? [res] : []))) as { ok: false; reason: string; message: string };
    assert.equal((await reason({ httpStatus: 200, body: { status: 'encrypted', page_count: 0, pages: [] } })).reason, 'encrypted');
    assert.equal((await reason({ httpStatus: 200, body: { status: 'scanned', page_count: 3, pages: [[], [], []] } })).reason, 'scanned');
    assert.equal((await reason({ httpStatus: 200, body: { status: 'invalid', page_count: 0, pages: [] } })).reason, 'invalid');
    assert.equal((await reason({ httpStatus: 200, body: { status: 'text', page_count: 1, pages: [['Dear customer']] } })).reason, 'unsupported_layout');
    assert.equal((await reason({ httpStatus: 200, body: { status: 'text', page_count: 1, pages: [[HEADER]] } })).reason, 'no_transactions');
    assert.equal((await reason({ httpStatus: 413, body: { detail: 'Statement is larger than 10 MB' } })).reason, 'too_large');
    assert.equal((await reason({ httpStatus: 413, body: { detail: 'Statement has more than 200 pages' } })).reason, 'too_many_pages');
    assert.equal((await reason({ httpStatus: 500, body: null })).reason, 'server');
    assert.equal((await reason(null)).reason, 'offline');
    assert.equal((await reason(null, file, null)).reason, 'signin_required');
    assert.equal((await reason(null, { ...file, name: 'x.txt' })).reason, 'not_pdf');
    for (const m of Object.values(PDF_FAILURE_MESSAGES)) assert.ok(m.length > 10 && !/\d{6,}/.test(m), 'messages never carry statement data');
  });
  await test('pipeline: an expired session is refreshed once and the request retried; a refused refresh ends cleanly', async () => {
    const p = port([{ httpStatus: 401, body: null }, { httpStatus: 200, body: okBody }]);
    const r = await readPdfStatement(file, A, p, async (s) => ({ ...s, access_token: 't2' }));
    assert.ok(r.ok); assert.deepEqual(p.calls, ['t1', 't2']);
    const refused = await readPdfStatement(file, A, port([{ httpStatus: 401, body: null }]), async () => null);
    assert.ok(!refused.ok && refused.reason === 'session_expired');
  });

  // ── categorisation ──
  const row = (narration: string, direction: 'income' | 'expense' = 'expense', kind: StatementRow['kind'] = 'payment'): StatementRow =>
    ({ line: 1, date: new Date().toISOString(), amount: 10, direction, narration, referenceId: '', fingerprint: 'x', kind });
  await test('categories: known merchants, salary, transfers, charges, unknowns; only unknown spending needs review', () => {
    assert.deepEqual(categorizeRow(row('UPI-SWIGGY')), { category: 'Food & Dining', categoryConfidence: 'high', needsReview: false });
    assert.equal(categorizeRow(row('NEFT CR-ACME SALARY OCT', 'income')).category, 'Salary');
    assert.equal(categorizeRow(row('SELF TRANSFER', 'expense', 'transfer')).category, 'Transfer');
    assert.equal(categorizeRow(row('ATM WDL', 'expense', 'cash_withdrawal')).category, 'Cash Withdrawal');
    assert.deepEqual(categorizeRow(row('SMS ALERT CHARGES')), { category: 'Other Expenses', categoryConfidence: 'medium', needsReview: false });
    assert.deepEqual(categorizeRow(row('CREDIT INTEREST', 'income')), { category: 'Other Income', categoryConfidence: 'medium', needsReview: false });
    assert.deepEqual(categorizeRow(row('QWERTY TRADERS')), { category: 'Other Expenses', categoryConfidence: 'low', needsReview: true });
    assert.equal(categorizeRow(row('RAHUL KUMAR', 'income')).needsReview, false);
  });
  await test('categories: a saved merchant rule wins and is never overwritten by the guess', async () => {
    const db = await fresh();
    await rememberAlias(db, A.user.id, 'QWERTY TRADERS', 'QWERTY TRADERS', 'Groceries');
    const [a, b] = await categorizeRows(db, A.user.id, [row('QWERTY TRADERS'), row('UPI-SWIGGY')]);
    assert.deepEqual([a.category, a.categoryConfidence, a.needsReview], ['Groceries', 'user', false]);
    assert.equal(b.category, 'Food & Dining');
    assert.equal((await categorizeRows(db, null, [row('QWERTY TRADERS')]))[0].categoryConfidence, 'low', 'guests have no saved rules');
  });

  // ── duplicates, persistence, sync, totals ──
  const parsed = () => parsePdfStatement([PAGE_1, PAGE_2]).rows;
  await test('import: nothing is written until confirmed; confirmed rows keep their statement dates and join the ledger', async () => {
    const db = await fresh();
    const rows = await categorizeRows(db, A.user.id, parsed());
    const preview = await previewStatement(db, A.user.id, rows);
    assert.deepEqual(preview.map((p) => p.status), Array(6).fill('new'));
    assert.equal((await live(db)).length, 0, 'preview and cancel leave the ledger untouched');
    assert.equal((await db.getAllAsync("SELECT * FROM sync_queue WHERE entity_type = 'transaction'")).length, 0);

    const summary = await applyStatement(db, A.user.id, preview, () => true);
    assert.deepEqual([summary.found, summary.added], [6, 6]);
    const saved = await live(db);
    assert.deepEqual(saved.map((t) => ymd(String(t.transaction_date))), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05', '2026-10-06', '2026-10-06']);
    assert.ok(saved.every((t) => t.sync_status === 'pending_create' && t.user_id === A.user.id && t.capture_source === 'csv_import'));
    assert.equal(saved[0].category, 'Food & Dining');
    assert.match(String(saved[0].description), /^Imported from PDF statement:/);
    assert.equal((await db.getAllAsync("SELECT * FROM sync_queue WHERE entity_type = 'transaction' AND operation = 'create'")).length, 6, 'saved through the normal sync queue');
    // low-confidence spending is flagged for the existing review queue; everything else is verified
    assert.deepEqual(saved.map((t) => t.verification_status), ['verified', 'verified', 'verified', 'verified', 'needs_review', 'needs_review']);
  });
  await test('import: totals use the statement dates, count each row once, and ignore the import day', async () => {
    const db = await fresh();
    const preview = await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed()));
    await applyStatement(db, A.user.id, preview, () => true);
    const october = await getCashFlowSummary(db, A.user.id, new Date(2026, 9, 15));
    assert.equal(october.monthIncomePaise, 12500000);
    assert.equal(october.monthExpensePaise, (1250 + 999 + 2000 + 350.5 + 350.5) * 100);
    const now = await getCashFlowSummary(db, A.user.id, new Date());
    if (new Date().getFullYear() !== 2026 || new Date().getMonth() !== 9) assert.equal(now.monthIncomePaise + now.monthExpensePaise, 0, 'nothing lands in the import month');
  });
  await test('import: the same statement again adds nothing, even when re-read as a different file', async () => {
    const db = await fresh();
    await applyStatement(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed())), () => true);
    const again = await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsePdfStatement([PAGE_1, PAGE_2]).rows));
    assert.deepEqual(again.map((p) => p.status), Array(6).fill('already_imported'));
    assert.equal((await applyStatement(db, A.user.id, again, () => true)).added, 0);
    assert.equal((await live(db)).length, 6);
  });
  await test('duplicates: an existing manual transaction and an existing CSV import are matched, not doubled, and left unchanged', async () => {
    const db = await fresh();
    const manual = await addTransaction({ amount: 1250, direction: 'expense', counterparty: 'Swiggy', category: 'Groceries', description: 'my note', transaction_date: new Date(2026, 9, 1, 12).toISOString() }, A);
    const csv = 'Date,Narration,Ref No,Withdrawal Amt,Deposit Amt\n05/10/2026,ATM WDL-MG ROAD,,2000.00,\n';
    await applyStatement(db, A.user.id, await previewStatement(db, A.user.id, parseStatementCsv(csv).rows), () => true);
    const before = await live(db);
    const preview = await flagStatementOverlaps(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed())));
    assert.equal(preview[0].status, 'matched'); assert.equal(preview[0].matchId, manual.id);
    assert.equal(preview[3].status, 'possible', 'the same transaction already imported from a CSV is offered for review, not added silently');
    const summary = await applyStatement(db, A.user.id, preview, (p) => p.status !== 'possible');
    assert.equal(summary.matched, 1);
    const after = await live(db);
    assert.equal(after.length, before.length + 4);
    const kept = after.find((t) => t.id === manual.id)!;
    assert.deepEqual([kept.category, kept.description, kept.counterparty, kept.amount_paise], ['Groceries', 'my note', 'Swiggy', 125000], 'the existing record keeps its own category, note and amount');
  });
  await test('duplicates: same amount, different merchant or date is not a duplicate; excluded rows are not saved', async () => {
    const db = await fresh();
    await addTransaction({ amount: 350.5, direction: 'expense', counterparty: 'Chemist', category: 'Health', transaction_date: new Date(2026, 9, 6, 12).toISOString() }, A);
    await addTransaction({ amount: 2000, direction: 'expense', counterparty: 'Landlord', category: 'Rent', transaction_date: new Date(2026, 9, 4, 12).toISOString() }, A);
    const preview = await flagStatementOverlaps(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed())));
    const status = (n: string) => preview.filter((p) => p.row.narration.includes(n)).map((p) => p.status);
    assert.ok(!status('ATM').includes('matched'), 'different day and merchant');
    const skip = new Set([preview[0].row.line]);
    const summary = await applyStatement(db, A.user.id, preview, (p) => !skip.has(p.row.line));
    assert.equal(summary.added + summary.matched + summary.alreadyImported <= 6, true);
    assert.ok(!(await live(db)).some((t) => t.reference_id === '412345678901'), 'an excluded row is not saved');
  });
  await test('the person\'s category correction is saved with the row and then trusted', async () => {
    const db = await fresh();
    const rows = (await categorizeRows(db, A.user.id, parsed())).map((r) => (r.narration.startsWith('RANDOM') ? { ...r, category: 'Groceries', categoryConfidence: 'user' as const, needsReview: false } : r));
    await applyStatement(db, A.user.id, await previewStatement(db, A.user.id, rows), () => true);
    const saved = await live(db);
    assert.deepEqual(saved.filter((t) => String(t.counterparty).startsWith('RANDOM')).map((t) => [t.category, t.verification_status]), [['Groceries', 'verified'], ['Groceries', 'verified']]);
  });
  await test('a failed save keeps what was committed and a re-import completes it without repeats', async () => {
    const db = await fresh();
    const preview = await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed()));
    let n = 0; const real = db.runAsync.bind(db);
    (db as unknown as { runAsync: typeof db.runAsync }).runAsync = (async (sql: string, ...args: unknown[]) => {
      if (/INTO transaction_keys/.test(sql) && (n += 1) === 4) throw new Error('disk full');
      return real(sql, ...(args as never[]));
    }) as typeof db.runAsync;
    await assert.rejects(applyStatement(db, A.user.id, preview, () => true));
    (db as unknown as { runAsync: typeof db.runAsync }).runAsync = real;
    const again = await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed()));
    await applyStatement(db, A.user.id, again, () => true);
    assert.equal((await live(db)).length, 6, 'no row is missing and none is doubled');
  });
  await test('old transactions without any import fields still load and keep their values', async () => {
    const db = await fresh();
    const old = await addTransaction({ amount: 99, direction: 'expense', counterparty: 'Metro', category: 'Transportation', transaction_date: new Date(2026, 9, 9, 12).toISOString() }, A);
    await applyStatement(db, A.user.id, await previewStatement(db, A.user.id, parsed()), () => true);
    const kept = (await live(db)).find((t) => t.id === old.id)!;
    assert.deepEqual([kept.category, kept.amount_paise, kept.source, kept.sync_status], ['Transportation', 9900, 'manual', 'pending_create']);
  });
  await test('offline: imported rows stay local and pending until the server confirms', async () => {
    const db = await fresh();
    await applyStatement(db, A.user.id, await previewStatement(db, A.user.id, parsed()), () => true);
    const states = new Set((await live(db)).map((t) => t.sync_status));
    assert.deepEqual([...states], ['pending_create']);
  });

  // ── whole-number amounts ──
  const wholeStatement = [[
    HEADER,
    tx('01/11/2026', 'RENT PAYMENT', '123456', '1250', '', '98750'),
    tx('02/11/2026', 'SHOP ONE', '', '1,250', '', '97,500'),
    tx('03/11/2026', 'CLIENT PAYMENT', '', '', '1,25,000', '2,22,500'),
    tx('04/11/2026', 'SHOP TWO', '', '₹1250', '', '2,21,250'),
    tx('05/11/2026', 'SHOP THREE', '', 'INR 1250.00', '', '2,20,000.00'),
    tx('06/11/2026', 'BONUS', '', '', '50000', '2,70,000'),
    L([60, '1']),
    'Page 1 of 1',
  ]];
  await test('whole-number amounts: plain, grouped, Indian, symbol-prefixed; references, dates and page numbers are not money', () => {
    const r = parsePdfStatement(wholeStatement);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rows.map((x) => [x.direction, x.amount]), [['expense', 1250], ['expense', 1250], ['income', 125000], ['expense', 1250], ['expense', 1250], ['income', 50000]]);
    assert.equal(r.rows[0].referenceId, '123456', 'a 6-digit reference under the reference column stays a reference');
    assert.equal(r.rows[0].balance, 98750);
    assert.equal(r.rows.length, 6, 'a lone page number is not a transaction or an amount');
  });
  await test('whole numbers: invalid grouping is not an amount; without headings a bare number is not trusted', () => {
    const bad = parsePdfStatement([[HEADER, tx('01/11/2026', 'SHOP', '', '1,25,00', '', '5,000.00')]]);
    assert.equal(bad.rows.length, 0);
    const bare = parsePdfStatement([['01/11/2026   SHOP ONE     500    9500']]);
    assert.equal(bare.rows.length, 0, 'headerless bare numbers are ambiguous, so the row is reported');
    const sure = parsePdfStatement([['01/11/2026   SHOP ONE     500.00 Dr    9,500.00']]);
    assert.deepEqual(sure.rows.map((x) => [x.direction, x.amount, x.balance]), [['expense', 500, 9500]]);
  });

  // ── more duplicate cases ──
  await test('duplicates: a PDF row matches an SMS transaction by reference, and by day when the SMS has none', async () => {
    const db = await fresh();
    const at = new Date(2026, 9, 1, 12).getTime();
    const sms = (body: string, when = at) => ({ sender: 'AX-HDFCBK-S', body, receivedAt: when, partCount: 1, source: 'sms' as const });
    await processIncomingSms(sms('Rs.1250.00 debited from A/c XX1234 to SWIGGY Ref 412345678901 on 01-Oct-26'), A);
    await processIncomingSms(sms('Rs.999.00 debited from A/c XX1234 to AMAZON PAY INDIA on 03-Oct-26', new Date(2026, 9, 3, 12).getTime()), A);
    const before = await live(db);
    assert.equal(before.length, 2);
    const preview = await flagStatementOverlaps(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed())));
    assert.deepEqual(preview.slice(0, 3).map((p) => p.status), ['matched', 'new', 'matched']);
    assert.equal(preview[0].matchId, before[0].id);
    await applyStatement(db, A.user.id, preview, (p) => p.status === 'new');
    assert.equal((await live(db)).length, 2 + 4, 'the SMS rows were matched, not doubled');
  });
  await test('duplicates: two identical statement lines against one existing transaction add exactly one', async () => {
    const db = await fresh();
    await addTransaction({ amount: 350.5, direction: 'expense', counterparty: 'Random Shop', category: 'Shopping', transaction_date: new Date(2026, 9, 6, 12).toISOString() }, A);
    const preview = await flagStatementOverlaps(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed())));
    const shops = preview.filter((p) => p.row.narration.startsWith('RANDOM'));
    assert.equal(shops.filter((p) => p.status === 'matched').length, 1, 'one statement line is the existing transaction');
    assert.equal(shops.filter((p) => p.status === 'new').length, 1, 'the other is a separate payment');
  });
  await test('possible duplicates start excluded and are added only when chosen', async () => {
    const db = await fresh();
    const csv = 'Date,Narration,Withdrawal Amt,Deposit Amt\n05/10/2026,ATM WDL-MG ROAD,2000.00,\n';
    await applyStatement(db, A.user.id, await previewStatement(db, A.user.id, parseStatementCsv(csv).rows), () => true);
    const preview = await flagStatementOverlaps(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed())));
    const excluded = defaultExcludedLines(preview);
    assert.deepEqual([...excluded], preview.filter((p) => p.status === 'possible').map((p) => p.row.line));
    assert.equal(excluded.size, 1);
    await applyStatement(db, A.user.id, preview, (p) => !excluded.has(p.row.line));
    assert.equal((await live(db)).filter((t) => Number(t.amount_paise) === 200000).length, 1, 'excluded by default: still one ATM row');
    const again = await flagStatementOverlaps(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed())));
    await applyStatement(db, A.user.id, again, () => true); // the person chooses to add the possible duplicate
    assert.equal((await live(db)).filter((t) => Number(t.amount_paise) === 200000).length, 2);
  });

  // ── categories, calculations, privacy ──
  await test('import never creates categories and never touches an existing transaction category', async () => {
    const db = await fresh();
    const mine = await addTransaction({ amount: 1250, direction: 'expense', counterparty: 'Swiggy', category: 'My Custom Bucket', transaction_date: new Date(2026, 9, 1, 12).toISOString() }, A);
    const names = async () => (await db.getAllAsync<{ name: string }>('SELECT name FROM categories ORDER BY name')).map((c) => c.name);
    const before = await names();
    await applyStatement(db, A.user.id, await flagStatementOverlaps(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed()))), (p) => p.status === 'new');
    assert.deepEqual(await names(), before);
    assert.equal((await live(db)).find((t) => t.id === mine.id)!.category, 'My Custom Bucket');
    assert.equal(categorizeRow({ ...parsed()[4], narration: 'RANDOM SHOP PVT' }).needsReview, true, 'unknown merchants keep the review indicator');
  });
  await test('known statement: counts, debit, credit, net, category totals, month and series agree with the hand-worked figures', async () => {
    const db = await fresh();
    await applyStatement(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed())), () => true);
    // by hand: 6 rows. debits 1250 + 999 + 2000 + 350.50 + 350.50 = 4950.00. credit 1,25,000.00. net 1,20,050.00 (= closing 2,20,050 - opening 1,00,000)
    assert.equal((await live(db)).length, 6);
    const oct = await getCashFlowSummary(db, A.user.id, new Date(2026, 9, 20));
    assert.deepEqual([oct.monthIncomePaise, oct.monthExpensePaise, oct.netPaise], [12500000, 495000, 12005000]);
    const slices = Object.fromEntries((await breakdownForMonth(db, A.user.id, '2026-10')).slices.map((s) => [s.category, s.totalPaise]));
    assert.deepEqual(slices, { 'Food & Dining': 125000, Shopping: 99900, 'Cash Withdrawal': 200000, 'Other Expenses': 70100 });
    const points = await loadPoints(db, A.user.id, '2026-10', '2026-10');
    const totals = totalsOf(buildMonthly(points, '2026-10', 1), points);
    assert.deepEqual([totals.incomePaise, totals.expensePaise], [12500000, 495000]);
    const nov = await getCashFlowSummary(db, A.user.id, new Date(2026, 10, 5));
    assert.deepEqual([nov.monthIncomePaise, nov.monthExpensePaise], [0, 0], 'the import date never moves a row');
    const again = await flagStatementOverlaps(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsed())));
    await applyStatement(db, A.user.id, again, (p) => !defaultExcludedLines(again).has(p.row.line));
    assert.equal((await getCashFlowSummary(db, A.user.id, new Date(2026, 9, 20))).monthExpensePaise, 495000, 'a re-import changes no total');
  });
  await test('privacy: reading, parsing and importing log nothing, and page text is not kept in the database', async () => {
    const db = await fresh();
    const lines: string[] = []; const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    console.log = console.warn = console.error = console.info = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      const read = await readPdfStatement(file, A, port([{ httpStatus: 200, body: okBody }]));
      assert.ok(read.ok);
      if (read.ok) await applyStatement(db, A.user.id, await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, read.rows)), () => true);
      await readPdfStatement(file, A, port([{ httpStatus: 500, body: okBody }]));
    } finally { Object.assign(console, keep); }
    assert.deepEqual(lines, []);
    const dump = JSON.stringify(await db.getAllAsync('SELECT * FROM transactions')) + JSON.stringify(await db.getAllAsync('SELECT * FROM sync_queue'));
    assert.ok(!dump.includes('Statement period') && !dump.includes('Page 1 of 2') && !dump.includes('Closing Balance'));
  });

  // ── UPI app statements: one payment over several lines, no balance, direction from wording ──
  const UPI_HEADER = L([0, 'Date'], [22, 'Transaction Details'], [70, 'Type'], [85, 'Amount']);
  const upi = (date: string, time: string, who: string, id: string | null, type: string, amount: string) => [
    L([0, date], [22, who], ...(type ? [[70, type] as [number, string]] : []), ...(amount ? [R(95, amount)] : [])),
    L([0, time], ...(id ? [[22, `UPI Transaction ID: ${id}`] as [number, string]] : [])),
    L([22, 'Paid by State Bank of India 4823']),
  ];
  const UPI_PAGE = [
    'Transaction Statement  01 Oct, 2026 - 31 Oct, 2026',
    UPI_HEADER,
    ...upi('01 Oct, 2026', '06:43 PM', 'Paid to Night canteen', '62742596121', 'DEBIT', '₹43'),
    ...upi('02 Oct, 2026', '07:02 PM', 'Received from Aksh', '62742596122', 'CREDIT', '₹200'),
    ...upi('02 Oct, 2026', '10:44 AM', 'Paid to UDUPI KRISHNA CAFETERIA', '62742596123', 'DEBIT', '₹30'),
    ...upi('03 Oct, 2026', '05:52 PM', 'Paid to Night canteen', '62742596124', 'DEBIT', '₹43'),
    ...upi('03 Oct, 2026', '05:55 PM', 'Paid to Night canteen', '62742596125', 'DEBIT', '₹43'),
    'Page 1 of 1',
  ];
  await test('UPI statement: date, time, payee, UPI id and amount are grouped into one transaction each', () => {
    const r = parsePdfStatement([UPI_PAGE]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rows.map((x) => [ymd(x.date), x.direction, x.amount, x.narration, x.referenceId]), [
      ['2026-10-01', 'expense', 43, 'Paid to Night canteen', '62742596121'],
      ['2026-10-02', 'income', 200, 'Received from Aksh', '62742596122'],
      ['2026-10-02', 'expense', 30, 'Paid to UDUPI KRISHNA CAFETERIA', '62742596123'],
      ['2026-10-03', 'expense', 43, 'Paid to Night canteen', '62742596124'],
      ['2026-10-03', 'expense', 43, 'Paid to Night canteen', '62742596125'],
    ]);
    const t = (i: number) => { const d = new Date(r.rows[i].date); return [d.getHours(), d.getMinutes()]; };
    assert.deepEqual([t(0), t(1), t(2), t(3)], [[18, 43], [19, 2], [10, 44], [17, 52]]);
    assert.ok(r.rows.every((x) => x.hasTime === true));
    assert.ok(!r.rows.some((x) => /State Bank|4823|Transaction ID/i.test(x.narration)), 'the paying account and the id line are not part of the payee');
  });
  await test('UPI statement: with no Type column, "Paid to" is an expense and "Received from" is income', () => {
    const r = parsePdfStatement([[
      L([0, 'Date'], [22, 'Transaction Details'], [85, 'Amount']),
      ...upi('01 Oct, 2026', '06:43 PM', 'Paid to Night canteen', '62742596121', '', '₹43'),
      ...upi('02 Oct, 2026', '07:02 PM', 'Received from Aksh', '62742596122', '', '₹200'),
    ]]);
    assert.deepEqual(r.rows.map((x) => [x.direction, x.amount]), [['expense', 43], ['income', 200]]);
  });
  await test('UPI statement: no headings at all still reads (₹ amounts are sure, wording gives direction)', () => {
    const r = parsePdfStatement([upi('01 Oct, 2026', '06:43 PM', 'Paid to Night canteen', '62742596121', '', '₹43')]);
    assert.deepEqual(r.rows.map((x) => [x.direction, x.amount, x.referenceId]), [['expense', 43, '62742596121']]);
  });
  await test('UPI statement: the amount may be on a different line from the description, and month-first dates work', () => {
    const r = parsePdfStatement([[
      UPI_HEADER,
      L([0, 'Oct 05, 2026'], [22, 'Paid to Metro Card']),
      L([0, '08:10 AM'], [22, 'UPI Transaction ID: 62742596130'], R(95, '₹ 1,250')),
      L([22, 'Paid by State Bank of India 4823']),
      L([0, 'Oct 06, 2026'], R(95, '₹16')),
      L([22, 'Received from Priya']),
      L([0, '09:00 AM'], [22, 'UPI Transaction ID: 62742596131']),
    ]]);
    assert.deepEqual(r.rows.map((x) => [ymd(x.date), x.direction, x.amount, x.referenceId]), [['2026-10-05', 'expense', 1250, '62742596130'], ['2026-10-06', 'income', 16, '62742596131']]);
  });
  await test('UPI statement: amounts in the app formats, and ids/bank digits/times are never read as money', () => {
    const r = parsePdfStatement([UPI_PAGE]);
    assert.deepEqual(r.rows.map((x) => x.amount), [43, 200, 30, 43, 43]);
    const indian = parsePdfStatement([[UPI_HEADER, ...upi('01 Oct, 2026', '06:43 PM', 'Paid to Builder', '62742596140', 'DEBIT', '₹1,25,000')]]);
    assert.equal(indian.rows[0].amount, 125000);
  });
  await test('UPI statement: a missing id is not invented; transactions stay separate and keep their own fingerprints', () => {
    const r = parsePdfStatement([[UPI_HEADER, ...upi('01 Oct, 2026', '06:43 PM', 'Paid to Night canteen', null, 'DEBIT', '₹43'), ...upi('01 Oct, 2026', '06:43 PM', 'Paid to Night canteen', null, 'DEBIT', '₹43')]]);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows.map((x) => x.referenceId), ['', '']);
    assert.notEqual(r.rows[0].fingerprint, r.rows[1].fingerprint);
  });
  await test('UPI statement: a missing amount or an unknown direction is reported, never guessed or imported', () => {
    const noAmount = parsePdfStatement([[UPI_HEADER, ...upi('01 Oct, 2026', '06:43 PM', 'Paid to Night canteen', '62742596121', 'DEBIT', ''), ...upi('02 Oct, 2026', '07:02 PM', 'Received from Aksh', '62742596122', 'CREDIT', '₹200')]]);
    assert.deepEqual(noAmount.rows.map((x) => x.amount), [200], 'the next transaction is not given the missing amount');
    assert.deepEqual(noAmount.errors.map((e) => e.reason), ['Amount not understood']);
    const unknown = parsePdfStatement([[UPI_HEADER, ...upi('01 Oct, 2026', '06:43 PM', 'Night canteen', '62742596121', '', '₹43')]]);
    assert.equal(unknown.rows.length, 0);
    assert.deepEqual(unknown.errors.map((e) => e.reason), ['Could not tell money in from money out']);
    const both = parsePdfStatement([[UPI_HEADER, ...upi('01 Oct, 2026', '06:43 PM', 'Paid to Aksh', '62742596121', '', '₹43'), L([22, 'Received from Priya'])]]);
    assert.equal(both.rows.length, 0, 'contradictory wording is ambiguous');
  });
  await test('UPI statement: wording never overrides a debit/credit column', () => {
    const r = parsePdfStatement([[UPI_HEADER, ...upi('01 Oct, 2026', '06:43 PM', 'Paid to Night canteen', '62742596121', 'CREDIT', '₹43')]]);
    assert.equal(r.rows[0].direction, 'income');
  });
  await test('the person-facing message says why lines were not read, with counts only', async () => {
    const body = { status: 'text', page_count: 1, pages: [[UPI_HEADER, ...upi('01 Oct, 2026', '06:43 PM', 'Night canteen', '62742596121', '', '₹43'), ...upi('02 Oct, 2026', '06:43 PM', 'Night canteen', '62742596122', '', '₹43')]] };
    const res = (await readPdfStatement(file, A, port([{ httpStatus: 200, body }]))) as { ok: false; reason: string; message: string };
    assert.equal(res.reason, 'rows_not_understood');
    assert.match(res.message, /Found 2 lines that look like transactions, but all could not tell money received from money paid/);
    assert.ok(!/Night|43|6274/.test(res.message), 'no statement data in the message');
  });
  await test('UPI statement imports end to end with real dates, references kept apart, and correct totals', async () => {
    const db = await fresh();
    const rows = await categorizeRows(db, A.user.id, parsePdfStatement([UPI_PAGE]).rows);
    const preview = await flagStatementOverlaps(db, A.user.id, await previewStatement(db, A.user.id, rows));
    assert.deepEqual(preview.map((p) => p.status), Array(5).fill('new'), 'same payee and amount with different UPI ids are separate');
    await applyStatement(db, A.user.id, preview, () => true);
    const saved = await live(db);
    assert.equal(saved.length, 5);
    assert.deepEqual(saved.map((t) => String(t.reference_id)).sort(), ['62742596121', '62742596122', '62742596123', '62742596124', '62742596125']);
    assert.equal(saved[0].counterparty, 'Night canteen', 'the payee is the name, not the "Paid to" wording');
    const oct = await getCashFlowSummary(db, A.user.id, new Date(2026, 9, 20));
    assert.deepEqual([oct.monthIncomePaise, oct.monthExpensePaise], [20000, (43 + 30 + 43 + 43) * 100]);
    const again = await previewStatement(db, A.user.id, await categorizeRows(db, A.user.id, parsePdfStatement([UPI_PAGE]).rows));
    assert.deepEqual(again.map((p) => p.status), Array(5).fill('already_imported'));
  });

  console.log(`\n${passed} PDF statement tests passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
