import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';
import { currentMonth, monthRange } from './budgetService.ts';

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
}

export const EMPTY_CASH_FLOW: CashFlowSummary = { monthIncomePaise: 0, monthExpensePaise: 0, netPaise: 0, balancePaise: 0, expenseRatioPercent: null };

const PAISE = 'COALESCE(amount_paise, CAST(ROUND(amount * 100) AS INTEGER))';

/**
 * Derives the summary from the local SQLite records of one scope (signed-in user, or guest when null).
 * Uses the transaction date (not the created date) for the month, and ignores deleted rows.
 */
export async function getCashFlowSummary(db: IDatabase, scope: Scope, now: Date = new Date()): Promise<CashFlowSummary> {
  const { start, end } = monthRange(currentMonth(now));
  const row = await db.getFirstAsync<{ income: number | null; expense: number | null; balance: number | null }>(
    `SELECT
       SUM(CASE WHEN direction = 'income' AND transaction_date >= ? AND transaction_date < ? THEN ${PAISE} ELSE 0 END) AS income,
       SUM(CASE WHEN direction = 'expense' AND transaction_date >= ? AND transaction_date < ? THEN ${PAISE} ELSE 0 END) AS expense,
       SUM(CASE WHEN direction = 'income' THEN ${PAISE} WHEN direction = 'expense' THEN -${PAISE} ELSE 0 END) AS balance
     FROM transactions
     WHERE deleted_at IS NULL AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`,
    start, end, start, end, scope, scope,
  );
  return summarize(Number(row?.income ?? 0), Number(row?.expense ?? 0), Number(row?.balance ?? 0));
}

export function summarize(monthIncomePaise: number, monthExpensePaise: number, balancePaise: number): CashFlowSummary {
  return {
    monthIncomePaise,
    monthExpensePaise,
    netPaise: monthIncomePaise - monthExpensePaise,
    balancePaise,
    expenseRatioPercent: monthIncomePaise > 0 ? Math.round((monthExpensePaise * 100) / monthIncomePaise) : null,
  };
}
