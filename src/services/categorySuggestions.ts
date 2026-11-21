import type { IDatabase } from '../db/types.ts';
import { listCategories, type Scope } from './categoryService.ts';
import { normalizeMerchantKey } from './merchantAliasService.ts';

/**
 * Which categories to offer as one-tap choices on a "complete your transaction" notification.
 *
 * Order: categories the person already gave THIS merchant, recent ones counting more; then their most-used categories.
 * Never the catch-all buckets (offering "Other Expenses" would not complete anything) nor the kind-based ones
 * (Transfer, Refund, Cash Withdrawal), and only categories that exist for this scope and direction, so every
 * suggestion is valid in the normal pickers. Works for guests too: it reads the ledger, not merchant aliases.
 */
export const NEVER_SUGGESTED = ['other expenses', 'other expense', 'other income', 'transfer', 'refund', 'cash withdrawal'];
export const RECENCY_HALF_LIFE_DAYS = 30;
/** Detected-and-never-confirmed rows are weaker evidence than something the person entered or verified. */
export const UNCONFIRMED_WEIGHT = 0.5;
const DAY_MS = 86_400_000;

export interface MerchantHistoryRow { category: string; at: number; weight?: number }
export interface UsageRow { category: string; count: number }

export interface RankInput {
  /** Past categorisations of the same merchant. */
  history: MerchantHistoryRow[];
  /** How often each category is used overall, for the fallback. */
  usage: UsageRow[];
  /** Categories valid for this scope and direction. Result uses exactly these spellings. */
  allowed: string[];
  now: number;
  limit?: number;
}

export function rankCategorySuggestions({ history, usage, allowed, now, limit = 2 }: RankInput): string[] {
  const canonical = new Map<string, string>();
  for (const name of allowed) {
    const key = name.trim().toLowerCase();
    if (key && !NEVER_SUGGESTED.includes(key) && !canonical.has(key)) canonical.set(key, name);
  }

  const merchantScore = new Map<string, number>();
  const newest = new Map<string, number>();
  for (const row of history) {
    const key = row.category.trim().toLowerCase();
    if (!canonical.has(key) || !Number.isFinite(row.at)) continue;
    const ageDays = Math.max(0, now - row.at) / DAY_MS;
    const score = (row.weight ?? 1) * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
    merchantScore.set(key, (merchantScore.get(key) ?? 0) + score);
    newest.set(key, Math.max(newest.get(key) ?? 0, row.at));
  }
  const byMerchant = [...merchantScore.keys()].sort((a, b) =>
    merchantScore.get(b)! - merchantScore.get(a)! || newest.get(b)! - newest.get(a)! || a.localeCompare(b));

  const totals = new Map<string, number>();
  for (const row of usage) {
    const key = row.category.trim().toLowerCase();
    if (canonical.has(key)) totals.set(key, (totals.get(key) ?? 0) + row.count);
  }
  const byUsage = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)! || a.localeCompare(b));

  const out: string[] = [];
  for (const key of [...byMerchant, ...byUsage]) {
    if (out.length >= limit) break;
    const name = canonical.get(key)!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

interface HistoryDbRow { counterparty: string; category: string; updated_at: string; verification_status: string; capture_source: string | null }

export async function getCategorySuggestions(
  db: IDatabase, scope: Scope, tx: { id: string; counterparty: string; direction: 'income' | 'expense' }, options: { limit?: number; now?: number } = {},
): Promise<string[]> {
  const allowed = (await listCategories(db, scope)).filter((c) => c.type === tx.direction).map((c) => c.name);
  if (allowed.length === 0) return [];
  const rows = await db.getAllAsync<HistoryDbRow>(
    `SELECT counterparty, category, updated_at, verification_status, capture_source FROM transactions
     WHERE deleted_at IS NULL AND direction = ? AND id != ? AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))
     ORDER BY updated_at DESC LIMIT 3000`,
    tx.direction, tx.id, scope, scope,
  );
  const key = normalizeMerchantKey(tx.counterparty);
  const history: MerchantHistoryRow[] = [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    if (!key || normalizeMerchantKey(row.counterparty) !== key) continue;
    const confirmed = row.verification_status === 'verified' || row.verification_status === 'reconciled' || row.capture_source === 'manual';
    history.push({ category: row.category, at: Date.parse(row.updated_at), weight: confirmed ? 1 : UNCONFIRMED_WEIGHT });
  }
  const usage = [...counts].map(([category, count]) => ({ category, count }));
  return rankCategorySuggestions({ history, usage, allowed, now: options.now ?? Date.now(), limit: options.limit });
}
