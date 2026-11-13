/**
 * Monthly Financial Report: data service, CSV, PDF html and export flow, checked against a dataset whose totals were
 * worked out by hand (see the table in knownDataset) and against the app's existing SQL ledger rules.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NodeSqliteAdapter } from '../../db/__tests__/testAdapter.ts';
import { runMigrations } from '../../db/migrations.ts';
import type { IDatabase } from '../../db/types.ts';
import { buildCsv, buildMonthlyReport, csvCell, csvHeader, listReportMonths, paiseToPlain, reportFileName, reportMonthLabel, verifyReport, type MonthlyReport } from '../monthlyReportService.ts';
import { donutSvg, escapeHtml, pieSlicesFor, renderReportHtml, reportPageCount, wrapLines } from '../monthlyReportHtml.ts';
import { exportReportCsv, exportReportPdf, safeErrorCode, saveExportedFile, type ExportedFile, type ReportExportPort } from '../monthlyReportExport.ts';
import { REPORT_LOGO_PNG_BASE64 } from '../reportLogo.ts';
import { categoryBreakdown } from '../analyticsService.ts';
import { getCashFlowSummary } from '../cashFlowService.ts';
import { monthRange } from '../budgetService.ts';
import { SQL_COUNTS_AS_EXPENSE, SQL_COUNTS_AS_INCOME, SQL_COUNTS_AS_REFUND } from '../ledgerRules.ts';

const fmt = (p: number) => `R${paiseToPlain(p)}`; // locale-independent money for string assertions

let seq = 0;
interface Tx { date: Date; direction: 'income' | 'expense'; paise: number; counterparty?: string; category?: string; description?: string; kind?: string; dup?: string | null; deleted?: boolean; user?: string | null; ref?: string | null; verification?: string }
async function insert(db: IDatabase, t: Tx): Promise<string> {
  const id = `tx${++seq}`; const iso = t.date.toISOString();
  await db.runAsync(
    `INSERT INTO transactions (id, user_id, amount, amount_paise, direction, counterparty, category, description, transaction_date, source, reference_id, sync_status, deleted_at, created_at, updated_at, txn_kind, possible_duplicate_of, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'synced', ?, ?, ?, ?, ?, ?)`,
    id, t.user ?? null, t.paise / 100, t.paise, t.direction, t.counterparty ?? `Merchant ${id}`, t.category ?? 'Food & Dining', t.description ?? '', iso, t.ref ?? null,
    t.deleted ? iso : null, iso, iso, t.kind ?? 'payment', t.dup ?? null, t.verification ?? 'verified');
  return id;
}
const at = (y: number, m1: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, m1 - 1, d, h, mi, s);

async function freshDb(): Promise<IDatabase> { const db = new NodeSqliteAdapter(); await runMigrations(db); return db as unknown as IDatabase; }

/**
 * October 2026, guest scope. Hand-worked expectations (paise):
 *   expenses  1,000.50 + 250.25 (Food) + 300 + 100 (Transport, mixed case) + 12,000 (Rent) + 2,000 (Cash withdrawal) + 99.99 = 15,750.74  -> 1575074, 7 rows
 *   income    50,000 (Salary) + 1,234.56 (Interest)                                                                          -> 5123456, 2 rows
 *   refunds   150 refund + 75 reversal                                                                                      -> 22500, 2 rows
 *   net       5123456 + 22500 - 1575074                                                                                     -> 3570882
 *   not counted: 2 own transfers, 1 possible duplicate, 1 deleted, 1 other user, and four rows just outside the month.
 */
const IDS: Record<string, string> = {};
async function knownDataset(): Promise<IDatabase> {
  const db = await freshDb();
  const add = async (key: string, t: Tx) => { IDS[key] = await insert(db, t); };
  await add('startBoundary', { date: at(2026, 10, 1, 0, 0, 0), direction: 'expense', paise: 100050, category: 'Food & Dining', counterparty: 'First Moment Cafe' });
  await add('endBoundary', { date: at(2026, 10, 31, 23, 59, 59), direction: 'expense', paise: 25025, category: 'Food & Dining', counterparty: 'Last Moment Cafe' });
  await add('beforeMonth', { date: at(2026, 9, 30, 23, 59, 59), direction: 'expense', paise: 99900, category: 'Food & Dining', counterparty: 'September Shop' });
  await add('afterMonth', { date: at(2026, 11, 1, 0, 0, 0), direction: 'expense', paise: 88800, category: 'Food & Dining', counterparty: 'November Shop' });
  await add('lastYear', { date: at(2025, 10, 12), direction: 'expense', paise: 555500, category: 'Travel', counterparty: 'Last Year Trip' });
  await add('salary', { date: at(2026, 10, 10), direction: 'income', paise: 5000000, category: 'Salary', counterparty: 'Employer Pvt Ltd' });
  await add('interest', { date: at(2026, 10, 11), direction: 'income', paise: 123456, category: 'Interest', counterparty: 'Bank' });
  await add('transport1', { date: at(2026, 10, 12), direction: 'expense', paise: 30000, category: 'Transport', counterparty: 'Metro' });
  await add('transport2', { date: at(2026, 10, 12, 18), direction: 'expense', paise: 10000, category: 'transport', counterparty: 'Cab' });
  await add('rent', { date: at(2026, 10, 15), direction: 'expense', paise: 1200000, category: 'Rent', counterparty: 'Landlord' });
  await add('refund', { date: at(2026, 10, 16), direction: 'income', paise: 15000, category: 'Food & Dining', counterparty: 'Refund Store', kind: 'refund' });
  await add('reversal', { date: at(2026, 10, 17), direction: 'income', paise: 7500, category: 'Shopping', counterparty: 'Reversed Charge', kind: 'reversal' });
  await add('transferOut', { date: at(2026, 10, 18), direction: 'expense', paise: 500000, category: 'Transfer', counterparty: 'To savings', kind: 'transfer' });
  await add('transferIn', { date: at(2026, 10, 18), direction: 'income', paise: 500000, category: 'Transfer', counterparty: 'From current', kind: 'transfer' });
  await add('duplicate', { date: at(2026, 10, 19), direction: 'expense', paise: 77700, category: 'Shopping', counterparty: 'Maybe Twice', dup: IDS.rent, ref: 'DUPREF' });
  await add('deleted', { date: at(2026, 10, 20), direction: 'expense', paise: 60000, category: 'Shopping', counterparty: 'Deleted Shop', deleted: true, ref: 'DELREF' });
  await add('otherUser', { date: at(2026, 10, 21), direction: 'expense', paise: 40000, category: 'Shopping', counterparty: 'Other Persons Shop', user: 'u2' });
  await add('cash', { date: at(2026, 10, 22), direction: 'expense', paise: 200000, category: 'Cash', counterparty: 'ATM', kind: 'cash_withdrawal' });
  await add('tricky', { date: at(2026, 10, 23), direction: 'expense', paise: 9999, category: 'Dining, out', counterparty: 'Joe\'s "Café", Bar ₹', ref: 'UPI/123', verification: 'detected' });
  return db;
}
const id = (key: string) => IDS[key];

// ---------------------------------------------------------------------------------------------- tiny CSV reader (RFC 4180)
function parseCsv(text: string): string[][] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) { if (ch === '"') { if (body[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && body[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const toPaise = (s: string) => (s === '' ? 0 : Math.round(Number(s) * 100));

// ------------------------------------------------------------------------------------------------------------------ tests

async function reconcilesWithHandCalculation() {
  const db = await knownDataset();
  const r = await buildMonthlyReport(db, null, '2026-10', at(2026, 11, 10, 15, 30));
  const s = r.summary;
  assert.equal(s.expensePaise, 1575074); assert.equal(s.expenseCount, 7);
  assert.equal(s.incomePaise, 5123456); assert.equal(s.incomeCount, 2);
  assert.equal(s.refundPaise, 22500); assert.equal(s.refundCount, 2);
  assert.equal(s.netPaise, 3570882, 'net = income + refunds - expenses');
  assert.equal(s.transferCount, 2, 'own transfers counted separately, never as income or spending');
  assert.equal(s.duplicateCount, 1);
  assert.equal(r.meta.transactionCount, 11); assert.equal(r.transactions.length, 11);
  assert.equal(r.meta.month, '2026-10'); assert.equal(r.meta.year, 2026); assert.equal(r.meta.monthNumber, 10);
  assert.equal(r.meta.monthLabel, 'October 2026'); assert.equal(r.meta.title, 'Monthly Financial Statement');
  assert.equal(r.meta.generatedAtIso, at(2026, 11, 10, 15, 30).toISOString(), 'generation time is when the report is built, not a transaction date');
  assert.equal(r.meta.currencyCode, 'INR');
  assert.deepEqual(verifyReport(r), [], 'rows, categories and headline figures reconcile');

  // Expense categories: mixed-case "Transport"/"transport" are one category; totals reconcile with the expense total.
  assert.deepEqual(r.expenseCategories.map((c) => [c.category.toLowerCase(), c.totalPaise, c.count, c.percentTenths]),
    [['rent', 1200000, 1, 762], ['cash', 200000, 1, 127], ['food & dining', 125075, 2, 79], ['transport', 40000, 2, 25], ['dining, out', 9999, 1, 6]]);
  assert.equal(r.expenseCategories.reduce((a, c) => a + c.totalPaise, 0), s.expensePaise, 'categorised expenses = report expenses');
  assert.equal(r.highestExpenseCategory?.category, 'Rent');
  assert.deepEqual(r.incomeCategories.map((c) => [c.category, c.totalPaise, c.count]), [['Salary', 5000000, 1], ['Interest', 123456, 1]]);
  assert.equal(r.incomeCategories.reduce((a, c) => a + c.totalPaise, 0), s.incomePaise, 'income categories = report income');

  const listed = r.transactions.map((t) => t.id);
  for (const key of ['startBoundary', 'endBoundary', 'salary', 'interest', 'transport1', 'transport2', 'rent', 'refund', 'reversal', 'cash', 'tricky']) assert.ok(listed.includes(id(key)), `${key} is listed`);
  for (const key of ['beforeMonth', 'afterMonth', 'lastYear', 'transferOut', 'transferIn', 'duplicate', 'deleted', 'otherUser']) assert.ok(!listed.includes(id(key)), `${key} is not listed`);
  assert.equal(new Set(listed).size, listed.length, 'each transaction appears once');
  assert.deepEqual(r.transactions.map((t) => t.date), [...r.transactions.map((t) => t.date)].sort(), 'oldest first');
  assert.equal(r.transactions[0].date, '2026-10-01'); assert.equal(r.transactions.at(-1)!.date, '2026-10-31');

  const byId = new Map(r.transactions.map((t) => [t.id, t]));
  assert.equal(byId.get(id('cash'))!.typeLabel, 'Cash withdrawal'); assert.equal(byId.get(id('cash'))!.expensePaise, 200000);
  assert.equal(byId.get(id('refund'))!.typeLabel, 'Refund'); assert.equal(byId.get(id('refund'))!.refundPaise, 15000); assert.equal(byId.get(id('refund'))!.incomePaise, 0, 'a refund is not income');
  assert.equal(byId.get(id('reversal'))!.typeLabel, 'Reversal');
  assert.equal(byId.get(id('salary'))!.typeLabel, 'Income'); assert.equal(byId.get(id('rent'))!.typeLabel, 'Expense');
  assert.equal(byId.get(id('tricky'))!.reference, 'UPI/123');

  assert.ok(r.notes.some((n) => /2 own transfers/.test(n)) && r.notes.some((n) => /1 possible duplicate/.test(n)) && r.notes.some((n) => /1 transaction was detected automatically/.test(n)), 'limitations are reported, not hidden');
}

async function boundariesYearsAndMonths() {
  const db = await knownDataset();
  const oct = await buildMonthlyReport(db, null, '2026-10');
  assert.ok(oct.transactions.some((t) => t.id === id('startBoundary')) && oct.transactions.some((t) => t.id === id('endBoundary')), '00:00:00 on the 1st and 23:59:59 on the 31st are inside October');
  const sep = await buildMonthlyReport(db, null, '2026-09');
  assert.deepEqual(sep.transactions.map((t) => t.id), [id('beforeMonth')], '23:59:59 on 30 Sep belongs to September only');
  assert.equal(sep.summary.expensePaise, 99900);
  const nov = await buildMonthlyReport(db, null, '2026-11');
  assert.deepEqual(nov.transactions.map((t) => t.id), [id('afterMonth')], '00:00:00 on 1 Nov belongs to November only');
  const lastYear = await buildMonthlyReport(db, null, '2025-10');
  assert.deepEqual(lastYear.transactions.map((t) => t.id), [id('lastYear')], 'same month number in another year is a different report');
  assert.equal(lastYear.summary.expensePaise, 555500); assert.equal(lastYear.meta.monthLabel, 'October 2025');
  assert.deepEqual(await listReportMonths(db, null), ['2026-11', '2026-10', '2026-09', '2025-10'], 'available periods come from the transaction history, newest first');
  assert.deepEqual(await listReportMonths(db, 'u2'), ['2026-10']);
  await assert.rejects(() => buildMonthlyReport(db, null, '2026-13')); await assert.rejects(() => buildMonthlyReport(db, null, 'October'));
  assert.equal(reportMonthLabel('2026-02'), 'February 2026');
}

async function emptyMonth() {
  const db = await knownDataset();
  const r = await buildMonthlyReport(db, null, '2026-03');
  assert.equal(r.meta.transactionCount, 0);
  assert.deepEqual([r.summary.incomePaise, r.summary.expensePaise, r.summary.refundPaise, r.summary.netPaise], [0, 0, 0, 0]);
  assert.deepEqual(r.expenseCategories, []); assert.equal(r.highestExpenseCategory, null); assert.deepEqual(r.transactions, []);
  assert.deepEqual(verifyReport(r), []);
  const html = renderReportHtml(r, fmt);
  assert.ok(!html.includes('<svg'), 'no chart (and no percentages) when there is no spending');
  assert.match(html, /No spending was recorded for March 2026/); assert.match(html, /There are no transactions in March 2026/);
  assert.equal(reportPageCount(html), 1);
  assert.deepEqual(parseCsv(buildCsv(r)), [csvHeader('INR')], 'CSV of an empty month is just the header');
}

async function agreesWithExistingLedgerSql() {
  const db = await knownDataset();
  const r = await buildMonthlyReport(db, null, '2026-10');
  const { start, end } = monthRange('2026-10');
  // The very same SQL predicates every other screen uses.
  const sum = async (pred: string) => Number((await db.getFirstAsync<{ t: number | null }>(`SELECT SUM(amount_paise) AS t FROM transactions WHERE ${pred} AND deleted_at IS NULL AND user_id IS NULL AND transaction_date >= ? AND transaction_date < ?`, start, end))!.t ?? 0);
  assert.equal(r.summary.expensePaise, await sum(SQL_COUNTS_AS_EXPENSE));
  assert.equal(r.summary.incomePaise, await sum(SQL_COUNTS_AS_INCOME));
  assert.equal(r.summary.refundPaise, await sum(SQL_COUNTS_AS_REFUND));
  // Analytics' own category breakdown.
  const analytics = await categoryBreakdown(db, null, { start, end });
  assert.equal(analytics.totalPaise, r.summary.expensePaise);
  assert.deepEqual(analytics.slices.map((x) => [x.category.toLowerCase(), x.totalPaise, x.percentTenths]), r.expenseCategories.map((c) => [c.category.toLowerCase(), c.totalPaise, c.percentTenths]), 'same categories, totals and percentages as Analytics');
  // Home cash-flow summary for the same month.
  const cash = await getCashFlowSummary(db, null, at(2026, 10, 15));
  assert.equal(cash.monthIncomePaise, r.summary.incomePaise); assert.equal(cash.monthExpensePaise, r.summary.expensePaise);
  assert.equal(cash.monthRefundPaise, r.summary.refundPaise); assert.equal(cash.netPaise, r.summary.netPaise);
}

async function scopesAreSeparateAndReadOnly() {
  const db = await knownDataset();
  const before = JSON.stringify(await db.getAllAsync('SELECT * FROM transactions ORDER BY id'));
  const queueBefore = JSON.stringify(await db.getAllAsync('SELECT * FROM sync_queue'));
  const u2 = await buildMonthlyReport(db, 'u2', '2026-10');
  assert.deepEqual(u2.transactions.map((t) => t.id), [id('otherUser')]); assert.equal(u2.summary.expensePaise, 40000);
  const guest = await buildMonthlyReport(db, null, '2026-10');
  assert.ok(!guest.transactions.some((t) => t.id === id('otherUser')));
  await buildCsv(guest); renderReportHtml(guest);
  assert.equal(JSON.stringify(await db.getAllAsync('SELECT * FROM transactions ORDER BY id')), before, 'building and rendering a report never changes a transaction');
  assert.equal(JSON.stringify(await db.getAllAsync('SELECT * FROM sync_queue')), queueBefore, 'and queues nothing for sync');
}

async function incomeOnlyAndCreditHeavyMonth() {
  const db = await freshDb();
  await insert(db, { date: at(2026, 5, 3), direction: 'income', paise: 100000, category: 'Salary' });
  await insert(db, { date: at(2026, 5, 4), direction: 'income', paise: 5000, category: 'Food & Dining', kind: 'refund' });
  const r = await buildMonthlyReport(db, null, '2026-05');
  assert.equal(r.summary.expensePaise, 0); assert.equal(r.summary.netPaise, 105000);
  assert.equal(r.highestExpenseCategory, null); assert.deepEqual(r.expenseCategories, []);
  const html = renderReportHtml(r, fmt);
  assert.ok(!html.includes('<svg') && html.includes('No spending was recorded'), 'income-only month: empty-state instead of a chart');
  // Spending above income gives a negative net, shown with its sign.
  const db2 = await freshDb();
  await insert(db2, { date: at(2026, 5, 3), direction: 'income', paise: 10000 }); await insert(db2, { date: at(2026, 5, 4), direction: 'expense', paise: 25000 });
  const r2 = await buildMonthlyReport(db2, null, '2026-05');
  assert.equal(r2.summary.netPaise, -15000); assert.ok(renderReportHtml(r2, fmt).includes('R-150.00'));
}

async function csvStructureAndEscaping() {
  const db = await knownDataset();
  const r = await buildMonthlyReport(db, null, '2026-10');
  const csv = buildCsv(r);
  assert.ok(csv.startsWith('﻿'), 'UTF-8 byte-order mark so Excel reads ₹ and accents'); assert.ok(csv.endsWith('\r\n')); assert.ok(!/[^\r]\n/.test(csv), 'CRLF line endings only');
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['Date', 'Description', 'Category', 'Type', 'Income (INR)', 'Expense (INR)', 'Refund (INR)', 'Reference']);
  assert.equal(rows.length, 1 + r.transactions.length, 'one row per listed transaction, nothing aggregated');
  assert.ok(rows.every((x) => x.length === 8), 'every row has the same eight columns, so commas and quotes cannot shift columns');
  const body = rows.slice(1);
  // Tricky description/category survive a round trip: comma, double quote, apostrophe, accent, rupee sign.
  const tricky = body.find((x) => x[7] === 'UPI/123')!;
  assert.equal(tricky[1], 'Joe\'s "Café", Bar ₹'); assert.equal(tricky[2], 'Dining, out'); assert.equal(tricky[0], '2026-10-23'); assert.equal(tricky[5], '99.99'); assert.equal(tricky[4], '');
  assert.ok(csv.includes('"Joe\'s ""Café"", Bar ₹"'), 'quotes are doubled inside a quoted field');
  // Column sums equal the report headline numbers (exact integer arithmetic).
  const col = (i: number) => body.reduce((a, x) => a + toPaise(x[i]), 0);
  assert.equal(col(4), r.summary.incomePaise); assert.equal(col(5), r.summary.expensePaise); assert.equal(col(6), r.summary.refundPaise);
  assert.equal(col(4) + col(6) - col(5), r.summary.netPaise);
  // Deleted / duplicate / transfer / other-user rows are not exported; references are preserved.
  assert.ok(!csv.includes('DUPREF') && !csv.includes('DELREF') && !csv.includes('Deleted Shop') && !csv.includes('Maybe Twice') && !csv.includes('To savings') && !csv.includes('Other Persons Shop') && !csv.includes('September Shop'));
  // Exactly the same transactions as the report (and so as the PDF).
  assert.deepEqual(body.map((x) => x[1]), r.transactions.map((t) => t.description));
  assert.deepEqual(body.map((x) => x[0]), r.transactions.map((t) => t.date));
  // Numbers are plain decimals a spreadsheet will treat as numbers.
  for (const x of body) for (const i of [4, 5, 6]) assert.match(x[i], /^(\d+\.\d{2})?$/);
}

function csvHelpers() {
  assert.equal(paiseToPlain(0), '0.00'); assert.equal(paiseToPlain(5), '0.05'); assert.equal(paiseToPlain(100), '1.00'); assert.equal(paiseToPlain(123456789), '1234567.89'); assert.equal(paiseToPlain(-150), '-1.50');
  assert.equal(csvCell('plain'), 'plain'); assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"', 'text a spreadsheet would run as a formula is defused'); assert.equal(csvCell('+91 98765'), "'+91 98765"); assert.equal(csvCell('-bad'), "'-bad"); assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('मराठी ₹ 日本語'), 'मराठी ₹ 日本語', 'Unicode passes through untouched');
  assert.equal(reportFileName('pdf', '2026-10'), 'Velnora_Financial_Report_October_2026.pdf'); assert.equal(reportFileName('csv', '2026-10'), 'Velnora_Transactions_October_2026.csv'); assert.equal(reportFileName('csv', '2025-01'), 'Velnora_Transactions_January_2025.csv');
}

async function pdfHtmlContent() {
  const db = await knownDataset();
  const r = await buildMonthlyReport(db, null, '2026-10', at(2026, 11, 10, 15, 30));
  const html = renderReportHtml(r, fmt);
  assert.match(html, /^<!DOCTYPE html>/); assert.ok(html.includes('<meta charset="utf-8"/>'));
  for (const text of ['Monthly Financial Statement', 'October 2026', 'VELNORA', 'Statement period', 'Total income', 'Total expenses', 'Net cash flow', 'Transactions (11)', 'Spending by category', 'Highest spending: <b>Rent</b>', 'not an official bank statement', 'Reporting period: October 2026']) assert.ok(html.includes(text), `PDF contains "${text}"`);
  for (const money of ['R50000.00'.replace('R50000.00', fmt(5000000)), fmt(5123456), fmt(1575074), fmt(3570882), fmt(22500)]) assert.ok(html.includes(money), `PDF shows ${money}`);
  assert.ok(html.includes('10 Nov 2026'), 'generated timestamp is shown');
  assert.ok(html.includes('76.2%') && html.includes('12.7%'), 'category percentages shown');

  // The pie chart is really inside the document: one donut, one path per category, built from the category totals.
  assert.equal((html.match(/<svg /g) ?? []).length, 1); assert.equal((html.match(/<path d=/g) ?? []).length, r.expenseCategories.length);
  assert.ok(!html.includes('Salary') || html.indexOf('<svg') < html.indexOf('Income by category'), 'chart precedes the income table');
  for (const c of r.expenseCategories) assert.ok(html.includes(c.color), 'slice uses the category colour');

  // Each listed transaction once, in the table; rows excluded from the report are absent.
  for (const t of r.transactions) assert.equal(html.split(`>${escapeHtml(t.description)}`).length - 1, 1, `${t.description} appears once in the table`);
  for (const gone of ['September Shop', 'November Shop', 'Deleted Shop', 'Maybe Twice', 'To savings', 'Other Persons Shop', 'DUPREF', 'DELREF']) assert.ok(!html.includes(gone), `${gone} is not in the PDF`);
  assert.ok(html.includes('Ref: UPI/123'));
  assert.ok(html.includes('Joe&#39;s &quot;Café&quot;, Bar ₹'), 'description escaped for HTML, Unicode kept');

  // Branding: the real logo asset, embedded once.
  assert.equal(REPORT_LOGO_PNG_BASE64, readFileSync(new URL('../../../assets/android-icon-foreground.png', import.meta.url)).toString('base64'), 'embedded logo equals the app logo asset (run scripts/generate-report-logo.mjs if this fails)');
  assert.equal(html.split(REPORT_LOGO_PNG_BASE64).length - 1, 1);
  assert.ok(html.includes('#10243E'), 'Velnora navy header');

  // Refund column appears only when the month has refunds.
  assert.ok(html.includes('<th class="num">Refund</th>'));
  const plain = renderReportHtml(await buildMonthlyReport(db, null, '2025-10'), fmt);
  assert.ok(!plain.includes('<th class="num">Refund</th>'));
  // Page footer carries the number on every page.
  const pages = reportPageCount(html);
  for (let p = 1; p <= pages; p += 1) assert.ok(html.includes(`Page ${p} of ${pages}`));
  // Default formatter is the active display currency (Indian grouping for INR).
  assert.match(renderReportHtml(r), /₹50,000/);
}

async function longReportPaginatesWithoutLosingRows() {
  const db = await freshDb();
  const total = 137;
  for (let i = 1; i <= total; i += 1) {
    await insert(db, {
      date: at(2026, 8, 1 + (i % 28), 9, i % 60), direction: i % 10 === 0 ? 'income' : 'expense', paise: 1000 + i * 17,
      counterparty: i % 6 === 0 ? `Row ${i} ` + 'a very long merchant description that must wrap onto several lines instead of being cut off '.repeat(2) : `Row ${i}`,
      category: ['Food & Dining', 'Rent', 'Transport', 'Health', 'Shopping', 'Travel', 'Bills', 'Fun', 'Gifts', 'Pets', 'Fees', 'Misc'][i % 12],
      ref: i % 3 === 0 ? `REF-${i}-0123456789012345678901234567890` : null, kind: i % 25 === 0 ? 'refund' : 'payment',
    });
  }
  const r = await buildMonthlyReport(db, null, '2026-08');
  assert.equal(r.transactions.length, total); assert.deepEqual(verifyReport(r), []);
  const html = renderReportHtml(r, fmt);
  const pages = reportPageCount(html); assert.ok(pages >= 6, `many rows need many pages (got ${pages})`);
  const sections = html.split('<section class="page">').slice(1);
  assert.equal(sections.length, pages);
  let dated = 0; let headerPages = 0;
  for (const [i, sec] of sections.entries()) {
    const rowsHere = (sec.match(/<tr><td class="date">/g) ?? []).length; dated += rowsHere;
    if (rowsHere) { headerPages += 1; assert.ok(sec.includes('<th>Date</th>'), `page ${i + 1}: table header repeated`); }
    assert.ok(sec.includes(`Page ${i + 1} of ${pages}`));
    assert.equal((sec.match(/<table class="t">/g) ?? []).length, (sec.match(/<\/table>/g) ?? []).length, 'tables are balanced on every page');
  }
  assert.equal(dated, total, 'every transaction is printed exactly once across the pages');
  assert.equal(headerPages, sections.filter((s) => /<tr><td class="date">/.test(s)).length);
  for (let i = 1; i <= total; i += 1) assert.equal(html.split(`>Row ${i} `).length - 1 + html.split(`>Row ${i}<`).length - 1, 1, `Row ${i} printed once`);
  assert.equal(html.split('<tr class="total">').length - 1, 3, 'one total row each for expense categories, income categories and transactions');
  assert.ok(html.includes('(continued)'), 'continued tables are labelled');
  // Totals row = report totals.
  assert.ok(html.includes(fmt(r.summary.expensePaise)) && html.includes(fmt(r.summary.refundPaise)));
}

function pieAndHelpers() {
  const many = Array.from({ length: 10 }, (_, i) => ({ category: `C${i}`, totalPaise: 1000 - i * 10, count: 1, percentTenths: 100, color: '#12B886' }));
  const slices = pieSlicesFor(many);
  assert.equal(slices.length, 8); assert.match(slices[7].label, /^Other \(3 categories\)$/);
  assert.equal(slices.reduce((a, s) => a + s.totalPaise, 0), many.reduce((a, c) => a + c.totalPaise, 0), 'grouping into "Other" keeps the total');
  assert.deepEqual(pieSlicesFor([]), []); assert.equal(donutSvg([], 170, 'x', 'y'), '');
  assert.equal(donutSvg([{ label: 'A', totalPaise: 0, percentTenths: 0, color: '#fff' }], 170, 'x', 'y'), '', 'a zero total never produces a chart');
  const one = donutSvg([{ label: 'Only', totalPaise: 500, percentTenths: 1000, color: '#12B886' }], 170, 'Total spent', 'R5.00');
  assert.ok(one.includes('<circle') && !one.includes('<path'), 'a single category is a full ring, not a degenerate arc');
  assert.equal(escapeHtml('<script>alert("x")</script> & \''), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;');
  assert.equal(wrapLines('short', 20), 1); assert.equal(wrapLines('a'.repeat(45), 20), 3); assert.equal(wrapLines('aaaa bbbb cccc dddd', 9), 2);
}

async function htmlCannotBeInjected() {
  const db = await freshDb();
  await insert(db, { date: at(2026, 6, 6), direction: 'expense', paise: 500, counterparty: '<img src=x onerror=alert(1)>', category: '"><script>x()</script>', ref: '<b>ref</b>' });
  const html = renderReportHtml(await buildMonthlyReport(db, null, '2026-06'), fmt);
  assert.ok(!html.includes('<script>') && !html.includes('<img src=x') && !html.includes('<b>ref</b>'), 'user text is escaped everywhere it is placed');
}

function fakePort(log: string[], over: Partial<ReportExportPort> = {}): ReportExportPort & { htmls: string[]; shared: { uri: string; mimeType: string }[]; files: Map<string, string> } {
  const files = new Map<string, string>(); const htmls: string[] = []; const shared: { uri: string; mimeType: string }[] = [];
  return {
    htmls, shared, files,
    async prepareDir() { log.push('prepare'); return 'cache://velnora-reports/'; },
    async printHtmlToPdf(html) { htmls.push(html); files.set('cache://tmp/print.pdf', 'PDFBYTES'); return 'cache://tmp/print.pdf'; },
    async moveFile(from, to) { files.set(to, files.get(from)!); files.delete(from); },
    async writeUtf8(uri, text) { files.set(uri, text); },
    async canShare() { return true; },
    async share(uri, o) { shared.push({ uri, mimeType: o.mimeType }); },
    ...over,
  };
}

async function exportFlow() {
  const db = await knownDataset();
  const report = await buildMonthlyReport(db, null, '2026-10');
  const log: string[] = [];
  const port = fakePort(log);
  const pdf = await exportReportPdf(port, report);
  assert.deepEqual(pdf, { ok: true, fileName: 'Velnora_Financial_Report_October_2026.pdf', file: { uri: 'cache://velnora-reports/Velnora_Financial_Report_October_2026.pdf', fileName: 'Velnora_Financial_Report_October_2026.pdf', mimeType: 'application/pdf' } });
  assert.equal(port.htmls.length, 1); assert.ok(port.htmls[0].includes('October 2026'));
  assert.deepEqual(port.shared, [{ uri: 'cache://velnora-reports/Velnora_Financial_Report_October_2026.pdf', mimeType: 'application/pdf' }]);
  assert.equal(port.files.size, 1, 'only the final, descriptively named file is left');
  const csv = await exportReportCsv(port, report);
  assert.deepEqual(csv, { ok: true, fileName: 'Velnora_Transactions_October_2026.csv', file: { uri: 'cache://velnora-reports/Velnora_Transactions_October_2026.csv', fileName: 'Velnora_Transactions_October_2026.csv', mimeType: 'text/csv' } });
  assert.equal(port.shared[1].mimeType, 'text/csv');
  assert.equal(port.files.get('cache://velnora-reports/Velnora_Transactions_October_2026.csv'), buildCsv(report), 'the shared CSV is exactly the CSV built from the report');

  // Changing the month changes what is exported.
  const sepReport = await buildMonthlyReport(db, null, '2026-09');
  const portSep = fakePort([]); await exportReportCsv(portSep, sepReport);
  const sepCsv = parseCsv([...portSep.files.values()][0]);
  assert.equal(sepCsv.length, 2); assert.equal(sepCsv[1][1], 'September Shop'); assert.equal([...portSep.files.keys()][0], 'cache://velnora-reports/Velnora_Transactions_September_2026.csv');

  // Cancellation, missing share support, platform failures: clean results, never a throw, never a leaked detail.
  const cancelled = await exportReportPdf(fakePort([], { async share() { throw new Error('User cancelled the share sheet'); } }), report);
  assert.equal(cancelled.ok, false); assert.equal((cancelled as { cancelled?: boolean }).cancelled, true);
  const noShare = await exportReportCsv(fakePort([], { async canShare() { return false; } }), report);
  assert.equal(noShare.ok, false); assert.match((noShare as { error: string }).error, /Sharing is not available/);
  assert.ok((noShare as { file?: unknown }).file, 'the created file is still offered for saving');
  const printFail = await exportReportPdf(fakePort([], { async printHtmlToPdf() { throw new Error('ENOSPC /data/user/0/com.x/cache Merchant 5000'); } }), report);
  assert.equal(printFail.ok, false); assert.ok(!(printFail as { error: string }).error.includes('ENOSPC') && !(printFail as { error: string }).error.includes('/data'), 'platform error text is not surfaced');
  assert.match((printFail as { error: string }).error, /PDF could not be created/);
  const writeFail = await exportReportCsv(fakePort([], { async writeUtf8() { throw new Error('EACCES'); } }), report);
  assert.match((writeFail as { error: string }).error, /CSV could not be saved/);
  const shareFail = await exportReportPdf(fakePort([], { async share() { throw Object.assign(new Error('Failed to share the file: /data/user/0/x'), { code: 'ERR_SHARING_FAILED' }); } }), report);
  assert.match((shareFail as { error: string }).error, /created but the share sheet could not open/);
  assert.equal((shareFail as { code?: string }).code, 'ERR_SHARING_FAILED');
  assert.ok(!(shareFail as { error: string }).error.includes('/data'), 'no native path is surfaced');
  assert.equal((shareFail as { file?: { mimeType: string } }).file?.mimeType, 'application/pdf');
  const busyShare = await exportReportPdf(fakePort([], { async share() { throw Object.assign(new Error('Another share request is being processed now.'), { code: 'ERR_SHARING_IN_PROGRESS' }); } }), report);
  assert.match((busyShare as { error: string }).error, /earlier share is still open/);
  // A message-only error never becomes a "code".
  assert.equal(safeErrorCode(new Error('x')), undefined); assert.equal(safeErrorCode({ code: '/data/user/0' }), undefined);

  // Save-to-device fallback works independently of sharing, and reports cancel/failure without throwing.
  const saved: string[] = [];
  const savePort = fakePort([], { async saveToDevice(uri, name) { saved.push(`${uri}|${name}`); return 'saved'; } });
  const file = (shareFail as { file: ExportedFile }).file;
  assert.deepEqual(await saveExportedFile(savePort, file), { ok: true, message: 'Velnora_Financial_Report_October_2026.pdf was saved.' });
  assert.deepEqual(saved, ['cache://velnora-reports/Velnora_Financial_Report_October_2026.pdf|Velnora_Financial_Report_October_2026.pdf']);
  assert.equal((await saveExportedFile(fakePort([], { async saveToDevice() { return 'cancelled'; } }), file)).cancelled, true);
  assert.equal((await saveExportedFile(fakePort([], { async saveToDevice() { throw new Error('denied'); } }), file)).ok, false);
  assert.equal((await saveExportedFile(fakePort([]), file)).ok, false, 'no save support -> clear refusal');

  // A report whose figures disagree is never exported.
  const tampered: MonthlyReport = { ...report, summary: { ...report.summary, expensePaise: report.summary.expensePaise + 1 } };
  assert.ok(verifyReport(tampered).length > 0);
  const refusedPort = fakePort([]); const refused = await exportReportPdf(refusedPort, tampered);
  assert.equal(refused.ok, false); assert.equal(refusedPort.htmls.length, 0); assert.equal(refusedPort.shared.length, 0);
}

await reconcilesWithHandCalculation();
await boundariesYearsAndMonths();
await emptyMonth();
await agreesWithExistingLedgerSql();
await scopesAreSeparateAndReadOnly();
await incomeOnlyAndCreditHeavyMonth();
await csvStructureAndEscaping();
csvHelpers();
await pdfHtmlContent();
await longReportPaginatesWithoutLosingRows();
pieAndHelpers();
await htmlCannotBeInjected();
await exportFlow();
console.log('monthly report tests passed');
