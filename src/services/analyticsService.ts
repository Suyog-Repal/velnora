import type { IDatabase } from '../db/types.ts';
import { listCategories, fallbackColor, type Scope } from './categoryService.ts';
import { monthRange } from './budgetService.ts';
import { SPEND_VIEW, SQL_COUNTS_AS_EXPENSE } from './ledgerRules.ts';

export interface CategorySlice { category: string; totalPaise: number; percentTenths: number; color: string }
export interface CategoryBreakdown { totalPaise: number; slices: CategorySlice[]; isEmpty: boolean }

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Expense totals per category in integer paise; percentages in tenths of a percent (123 = 12.3%) via integer rounding. */
export async function categoryBreakdown(db: IDatabase, scope: Scope, range: { start: string; end: string }): Promise<CategoryBreakdown> {
  const rows = await db.getAllAsync<{ category: string; total: number }>(
    `SELECT category, SUM(COALESCE(amount_paise, CAST(ROUND(amount * 100) AS INTEGER))) AS total FROM ${SPEND_VIEW}
     WHERE ${SQL_COUNTS_AS_EXPENSE} AND deleted_at IS NULL AND amount > 0 AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))
       AND transaction_date >= ? AND transaction_date < ?
     GROUP BY category COLLATE NOCASE ORDER BY total DESC`,
    scope, scope, range.start, range.end);
  const colors = new Map((await listCategories(db, scope)).map((c) => [c.name.toLowerCase(), c.color]));
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  return {
    totalPaise: total,
    isEmpty: total === 0,
    slices: total === 0 ? [] : rows.map((r) => ({
      category: r.category, totalPaise: r.total,
      percentTenths: Math.round((r.total * 1000) / total),
      color: colors.get(r.category.toLowerCase()) ?? fallbackColor(r.category),
    })),
  };
}

export const breakdownForMonth = (db: IDatabase, scope: Scope, month: string) => categoryBreakdown(db, scope, monthRange(month));
