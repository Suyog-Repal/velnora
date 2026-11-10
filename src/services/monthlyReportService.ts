/**
 * Monthly Financial Report: the data behind the preview, the PDF and the CSV.
 *
 * It reads the same local SQLite ledger as everything else and applies the one set of ledger rules (ledgerRules.ts):
 * possible duplicates and deleted rows count nowhere, own transfers are neither income nor expense, refunds and
 * reversals are money back (not income) and are included in net cash flow. Net uses cashFlowService.summarize.
 * Nothing here writes to the database, logs, or calls the network.
 *
 * All money is integer paise. The month is the device's local calendar month of the transaction's own date.
 */
import type { IDatabase, TransactionKind } from '../db/types.ts';
import { listCategories, fallbackColor, type Scope } from './categoryService.ts';
import { monthRange } from './budgetService.ts';
import { countsAsExpense, countsAsIncome, countsAsRefund } from './ledgerRules.ts';
import { summarize } from './cashFlowService.ts';
import { MONTH_NAMES, localYmd } from './dateUtils.ts';
import { activeCurrency } from '../ui/currency.ts';

export type ReportRowKind = 'income' | 'expense' | 'refund';

export interface ReportTransaction {
  id: string;
  /** Local calendar date of the transaction, YYYY-MM-DD. */
  date: string;
  description: string;
  category: string;
  /** Human label: Income, Expense, Refund, Reversal, Cash withdrawal. */
  typeLabel: string;
  kind: ReportRowKind;
  incomePaise: number;
  expensePaise: number;
  /** Refunds and reversals (money back). Not part of income. */
  refundPaise: number;
  reference: string;
}

export interface ReportCategory { category: string; totalPaise: number; count: number; percentTenths: number; color: string }

export interface MonthlyReport {
  meta: {
    title: string;
    /** 'YYYY-MM' */
    month: string;
    year: number;
    /** 1-12 */
    monthNumber: number;
    monthLabel: string;
    generatedAtIso: string;
    currencyCode: string;
    /** Transactions listed in the report (income + expense + refund rows). */
    transactionCount: number;
  };
  summary: {
    incomePaise: number;
    expensePaise: number;
    refundPaise: number;
    /** income + refunds - expenses (the app's cash-flow definition). */
    netPaise: number;
    incomeCount: number;
    expenseCount: number;
    refundCount: number;
    /** Own transfers dated in the month: neither income nor expense, not listed. */
    transferCount: number;
    /** Possible duplicates dated in the month: left out of every figure until resolved in the app. */
    duplicateCount: number;
  };
  expenseCategories: ReportCategory[];
  highestExpenseCategory: ReportCategory | null;
  incomeCategories: ReportCategory[];
  transactions: ReportTransaction[];
  /** Plain-language limitations of this month's figures, shown in the preview and the PDF. */
  notes: string[];
}

interface Row {
  id: string; counterparty: string; description: string | null; category: string; transaction_date: string; direction: string;
  txn_kind: TransactionKind | null; possible_duplicate_of: string | null; reference_id: string | null;
  amount: number; amount_paise: number | null; verification_status: string | null; created_at: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function parseReportMonth(month: string): { year: number; monthNumber: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error('Invalid month');
  return { year: Number(m[1]), monthNumber: Number(m[2]) };
}

export const reportMonthKey = (year: number, monthNumber: number) => `${year}-${pad(monthNumber)}`;
export const reportMonthLabel = (month: string) => { const p = parseReportMonth(month); return `${MONTH_NAMES[p.monthNumber - 1]} ${p.year}`; };

/** Local calendar months ('YYYY-MM', newest first) that have at least one live transaction in this scope. */
export async function listReportMonths(db: IDatabase, scope: Scope): Promise<string[]> {
  const rows = await db.getAllAsync<{ transaction_date: string }>(
    `SELECT transaction_date FROM transactions WHERE deleted_at IS NULL AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`, scope, scope);
  const months = new Set<string>();
  for (const r of rows) {
    const d = new Date(r.transaction_date);
    if (!Number.isNaN(d.getTime())) months.add(localYmd(d).slice(0, 7));
  }
  return [...months].sort().reverse();
}

function typeLabel(kind: ReportRowKind, txnKind: TransactionKind | null): string {
  if (kind === 'refund') return txnKind === 'reversal' ? 'Reversal' : 'Refund';
  if (kind === 'expense') return txnKind === 'cash_withdrawal' ? 'Cash withdrawal' : 'Expense';
  return 'Income';
}

function groupCategories(rows: { category: string; paise: number }[], colors: Map<string, string>): ReportCategory[] {
  const groups = new Map<string, ReportCategory>();
  for (const r of rows) {
    const key = r.category.trim().toLowerCase();
    const g = groups.get(key);
    if (g) { g.totalPaise += r.paise; g.count += 1; } else groups.set(key, { category: r.category, totalPaise: r.paise, count: 1, percentTenths: 0, color: colors.get(key) ?? fallbackColor(r.category) });
  }
  const list = [...groups.values()].sort((a, b) => b.totalPaise - a.totalPaise || a.category.localeCompare(b.category));
  const total = list.reduce((s, c) => s + c.totalPaise, 0);
  // Same integer rounding as Analytics: tenths of a percent. A month with no total has no percentages at all.
  for (const c of list) c.percentTenths = total > 0 ? Math.round((c.totalPaise * 1000) / total) : 0;
  return list;
}

/** Builds the report for one local calendar month ('YYYY-MM') of one scope (signed-in user, or guest when null). */
export async function buildMonthlyReport(db: IDatabase, scope: Scope, month: string, now: Date = new Date()): Promise<MonthlyReport> {
  const { year, monthNumber } = parseReportMonth(month);
  const { start, end } = monthRange(month);
  const rows = await db.getAllAsync<Row>(
    `SELECT id, counterparty, description, category, transaction_date, direction, txn_kind, possible_duplicate_of, reference_id,
            amount, amount_paise, verification_status, created_at
     FROM transactions
     WHERE deleted_at IS NULL AND (user_id = ? OR (user_id IS NULL AND ? IS NULL)) AND transaction_date >= ? AND transaction_date < ?
     ORDER BY transaction_date ASC, created_at ASC, id ASC`, scope, scope, start, end);
  const colors = new Map((await listCategories(db, scope)).map((c) => [c.name.toLowerCase(), c.color]));

  const transactions: ReportTransaction[] = [];
  const expenseInputs: { category: string; paise: number }[] = [];
  const incomeInputs: { category: string; paise: number }[] = [];
  let incomePaise = 0; let expensePaise = 0; let refundPaise = 0;
  let incomeCount = 0; let expenseCount = 0; let refundCount = 0; let transferCount = 0; let duplicateCount = 0; let unverifiedCount = 0;

  for (const r of rows) {
    const paise = r.amount_paise ?? Math.round(r.amount * 100);
    const ledger = { direction: r.direction, txn_kind: r.txn_kind ?? undefined, possible_duplicate_of: r.possible_duplicate_of };
    const category = r.category?.trim() || 'Uncategorized';
    let kind: ReportRowKind;
    if (countsAsExpense(ledger)) { kind = 'expense'; expensePaise += paise; expenseCount += 1; expenseInputs.push({ category, paise }); }
    else if (countsAsIncome(ledger)) { kind = 'income'; incomePaise += paise; incomeCount += 1; incomeInputs.push({ category, paise }); }
    else if (countsAsRefund(ledger)) { kind = 'refund'; refundPaise += paise; refundCount += 1; }
    else {
      // Not counted by the ledger. Say why in the notes instead of guessing a classification.
      if (r.possible_duplicate_of) duplicateCount += 1; else transferCount += 1;
      continue;
    }
    if (r.verification_status === 'detected' || r.verification_status === 'needs_review') unverifiedCount += 1;
    const note = (r.description ?? '').trim();
    const name = r.counterparty.trim();
    transactions.push({
      id: r.id,
      date: localYmd(new Date(r.transaction_date)),
      description: note && note !== name ? (name ? `${name} (${note})` : note) : name || note || '(no description)',
      category,
      typeLabel: typeLabel(kind, r.txn_kind),
      kind,
      incomePaise: kind === 'income' ? paise : 0,
      expensePaise: kind === 'expense' ? paise : 0,
      refundPaise: kind === 'refund' ? paise : 0,
      reference: (r.reference_id ?? '').trim(),
    });
  }

  const expenseCategories = groupCategories(expenseInputs, colors);
  const incomeCategories = groupCategories(incomeInputs, colors);
  const notes: string[] = [];
  if (transferCount) notes.push(`${transferCount} own transfer${transferCount === 1 ? '' : 's'} between your accounts ${transferCount === 1 ? 'is' : 'are'} not counted as income or spending and not listed.`);
  if (duplicateCount) notes.push(`${duplicateCount} possible duplicate${duplicateCount === 1 ? '' : 's'} ${duplicateCount === 1 ? 'is' : 'are'} left out until you resolve ${duplicateCount === 1 ? 'it' : 'them'} in Velnora.`);
  if (refundCount) notes.push('Refunds and reversals are money back, not income. They are shown separately and included in net cash flow.');
  if (unverifiedCount) notes.push(`${unverifiedCount} transaction${unverifiedCount === 1 ? ' was' : 's were'} detected automatically and not yet confirmed.`);

  return {
    meta: {
      title: 'Monthly Financial Statement', month, year, monthNumber, monthLabel: reportMonthLabel(month),
      generatedAtIso: now.toISOString(), currencyCode: activeCurrency().code, transactionCount: transactions.length,
    },
    summary: {
      incomePaise, expensePaise, refundPaise, netPaise: summarize(incomePaise, expensePaise, 0, refundPaise).netPaise,
      incomeCount, expenseCount, refundCount, transferCount, duplicateCount,
    },
    expenseCategories, highestExpenseCategory: expenseCategories[0] ?? null, incomeCategories, transactions, notes,
  };
}

/** Internal consistency check: the listed rows, the category tables and the headline figures must agree. Returns problems (empty = consistent). */
export function verifyReport(report: MonthlyReport): string[] {
  const problems: string[] = [];
  const sum = (f: (t: ReportTransaction) => number) => report.transactions.reduce((s, t) => s + f(t), 0);
  const s = report.summary;
  if (sum((t) => t.incomePaise) !== s.incomePaise) problems.push('income does not match the listed income transactions');
  if (sum((t) => t.expensePaise) !== s.expensePaise) problems.push('expenses do not match the listed expense transactions');
  if (sum((t) => t.refundPaise) !== s.refundPaise) problems.push('refunds do not match the listed refund transactions');
  if (report.expenseCategories.reduce((a, c) => a + c.totalPaise, 0) !== s.expensePaise) problems.push('expense categories do not add up to total expenses');
  if (report.incomeCategories.reduce((a, c) => a + c.totalPaise, 0) !== s.incomePaise) problems.push('income categories do not add up to total income');
  if (s.incomePaise + s.refundPaise - s.expensePaise !== s.netPaise) problems.push('net cash flow is not income + refunds - expenses');
  if (report.transactions.length !== s.incomeCount + s.expenseCount + s.refundCount || report.meta.transactionCount !== report.transactions.length) problems.push('transaction counts do not match');
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------- CSV

/** Plain decimal for spreadsheets: no symbol, no thousands separator, always two decimals. Exact (integer arithmetic). */
export function paiseToPlain(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${pad(abs % 100)}`;
}

/** RFC 4180 quoting, plus a leading apostrophe on text a spreadsheet would run as a formula (= + - @ tab CR). */
export function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function csvHeader(currencyCode: string): string[] {
  return ['Date', 'Description', 'Category', 'Type', `Income (${currencyCode})`, `Expense (${currencyCode})`, `Refund (${currencyCode})`, 'Reference'];
}

/**
 * One row per listed transaction. UTF-8 with a byte-order mark so Excel reads Unicode (₹, accents) correctly, CRLF line
 * endings, ISO dates, amounts as plain decimals in separate Income / Expense / Refund columns (empty when not applicable).
 */
export function buildCsv(report: MonthlyReport): string {
  const lines = [csvHeader(report.meta.currencyCode).map(csvCell).join(',')];
  for (const t of report.transactions) {
    lines.push([
      t.date, csvCell(t.description), csvCell(t.category), t.typeLabel,
      t.incomePaise ? paiseToPlain(t.incomePaise) : '', t.expensePaise ? paiseToPlain(t.expensePaise) : '', t.refundPaise ? paiseToPlain(t.refundPaise) : '',
      csvCell(t.reference),
    ].join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function reportFileName(kind: 'pdf' | 'csv', month: string): string {
  const { year, monthNumber } = parseReportMonth(month);
  return `Velnora_${kind === 'pdf' ? 'Financial_Report' : 'Transactions'}_${MONTH_NAMES[monthNumber - 1]}_${year}.${kind}`;
}
