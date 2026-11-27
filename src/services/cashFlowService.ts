import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';
import { currentMonth, monthRange } from './budgetService.ts';
import { SQL_COUNTS_AS_EXPENSE, SQL_COUNTS_AS_INCOME, SQL_COUNTS_AS_REFUND } from './ledgerRules.ts';

/** Home-screen money summary, all in exact integer paise. */
export interface CashFlowSummary {
  /** Income dated in the current calendar month. */
  monthIncomePaise: number;
  /** Expenses dated in the current calendar month. */
  monthExpensePaise: number;
  /** monthIncome - monthExpense; negative when spending exceeds income. */
  netPaise: number;
  /** All-time income - expenses for this scope (the "recorded balance"). */
  balancePaise: number;
  /** Expenses as a whole-number percentage of income; null when there is no income this month (a ratio would be meaningless). */
  expenseRatioPercent: number | null;
  /** Money returned this month (refunds, reversals). Not income; included in net. */
  monthRefundPaise: number;
}

export const EMPTY_CASH_FLOW: CashFlowSummary = { monthIncomePaise: 0, monthExpensePaise: 0, netPaise: 0, balancePaise: 0, expenseRatioPercent: null, monthRefundPaise: 0 };

/** Today's figures and how much of the ledger has been confirmed, so uncertain data is never shown as settled. */
export interface LedgerHealth {
  todayIncomePaise: number;
  todayExpensePaise: number;
  todayNetPaise: number;
  totalCount: number;
  verifiedCount: number;
  detectedCount: number;
  needsReviewCount: number;
  /** This month's counted spending that came from detection and nobody has confirmed yet. */
  monthUnverifiedExpensePaise: number;
}

export const EMPTY_LEDGER_HEALTH: LedgerHealth = { todayIncomePaise: 0, todayExpensePaise: 0, todayNetPaise: 0, totalCount: 0, verifiedCount: 0, detectedCount: 0, needsReviewCount: 0, monthUnverifiedExpensePaise: 0 };

const PAISE = 'COALESCE(amount_paise, CAST(ROUND(amount * 100) AS INTEGER))';

export async function getLedgerHealth(db: IDatabase, scope: Scope, now: Date = new Date()): Promise<LedgerHealth> {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const { start, end } = monthRange(currentMonth(now));
  const scopeSql = '(user_id = ? OR (user_id IS NULL AND ? IS NULL))';
  const row = await db.getFirstAsync<Record<string, number | null>>(
    `SELECT
       SUM(CASE WHEN ${SQL_COUNTS_AS_INCOME} AND transaction_date >= ? AND transaction_date < ? THEN ${PAISE} ELSE 0 END) AS income,
       SUM(CASE WHEN ${SQL_COUNTS_AS_REFUND} AND transaction_date >= ? AND transaction_date < ? THEN ${PAISE} ELSE 0 END) AS refund,
       COUNT(*) AS total,
       SUM(CASE WHEN verification_status IN ('verified', 'reconciled') THEN 1 ELSE 0 END) AS verified,
       SUM(CASE WHEN verification_status = 'detected' THEN 1 ELSE 0 END) AS detected,
       SUM(CASE WHEN verification_status = 'needs_review' THEN 1 ELSE 0 END) AS review
     FROM transactions WHERE deleted_at IS NULL AND ${scopeSql}`,
    dayStart, dayEnd, dayStart, dayEnd, scope, scope,
  );
  // Home is the cash view: money that actually left the account (the full bill, even when part of it is owed back by friends).
  const spend = await db.getFirstAsync<Record<string, number | null>>(
    `SELECT
       SUM(CASE WHEN transaction_date >= ? AND transaction_date < ? THEN ${PAISE} ELSE 0 END) AS expense,
       SUM(CASE WHEN verification_status IN ('detected', 'needs_review') AND transaction_date >= ? AND transaction_date < ? THEN ${PAISE} ELSE 0 END) AS unverified
     FROM transactions WHERE ${SQL_COUNTS_AS_EXPENSE} AND deleted_at IS NULL AND ${scopeSql}`,
    dayStart, dayEnd, start, end, scope, scope,
  );
  const income = Number(row?.income ?? 0); const expense = Number(spend?.expense ?? 0); const refund = Number(row?.refund ?? 0);
  return {
    todayIncomePaise: income, todayExpensePaise: expense, todayNetPaise: income + refund - expense,
    totalCount: Number(row?.total ?? 0), verifiedCount: Number(row?.verified ?? 0), detectedCount: Number(row?.detected ?? 0),
    needsReviewCount: Number(row?.review ?? 0), monthUnverifiedExpensePaise: Number(spend?.unverified ?? 0),
  };
}

/**
 * Derives the summary from the local SQLite records of one scope (signed-in user, or guest when null).
 * Uses the transaction date (not the created date) for the month, and ignores deleted rows.
 */
export async function getCashFlowSummary(db: IDatabase, scope: Scope, now: Date = new Date()): Promise<CashFlowSummary> {
  const { start, end } = monthRange(currentMonth(now));
  const scopeSql = '(user_id = ? OR (user_id IS NULL AND ? IS NULL))';
  // Income, refunds and the running balance are money that actually moved: they read the transactions as the bank saw them.
  const row = await db.getFirstAsync<{ income: number | null; refund: number | null; balance: number | null }>(
    `SELECT
       SUM(CASE WHEN ${SQL_COUNTS_AS_INCOME} AND transaction_date >= ? AND transaction_date < ? THEN ${PAISE} ELSE 0 END) AS income,
       SUM(CASE WHEN ${SQL_COUNTS_AS_REFUND} AND transaction_date >= ? AND transaction_date < ? THEN ${PAISE} ELSE 0 END) AS refund,
       SUM(CASE WHEN ${SQL_COUNTS_AS_INCOME} OR ${SQL_COUNTS_AS_REFUND} THEN ${PAISE} WHEN ${SQL_COUNTS_AS_EXPENSE} THEN -${PAISE} ELSE 0 END) AS balance
     FROM transactions
     WHERE deleted_at IS NULL AND ${scopeSql}`,
    start, end, start, end, scope, scope,
  );
  // This month's spending is cash too: the full transaction amounts, the same as Profile and the recorded balance.
  const spend = await db.getFirstAsync<{ expense: number | null }>(
    `SELECT SUM(${PAISE}) AS expense FROM transactions
     WHERE ${SQL_COUNTS_AS_EXPENSE} AND deleted_at IS NULL AND ${scopeSql} AND transaction_date >= ? AND transaction_date < ?`,
    scope, scope, start, end,
  );
  return summarize(Number(row?.income ?? 0), Number(spend?.expense ?? 0), Number(row?.balance ?? 0), Number(row?.refund ?? 0));
}

/**
 * Profile's "Spent this month" and "Transactions". They are Home's own SQL results, not a second calculation, so the two screens
 * cannot disagree and neither depends on how many rows the app has loaded.
 */
export function profileCashFigures(cashFlow: CashFlowSummary, health: LedgerHealth): { spentPaise: number; transactionCount: number } {
  return { spentPaise: cashFlow.monthExpensePaise, transactionCount: health.totalCount };
}

export function summarize(monthIncomePaise: number, monthExpensePaise: number, balancePaise: number, monthRefundPaise = 0): CashFlowSummary {
  return {
    monthIncomePaise,
    monthExpensePaise,
    netPaise: monthIncomePaise + monthRefundPaise - monthExpensePaise,
    balancePaise,
    expenseRatioPercent: monthIncomePaise > 0 ? Math.round((monthExpensePaise * 100) / monthIncomePaise) : null,
    monthRefundPaise,
  };
}
