import type { IDatabase, Session, TransactionEntity } from '../db/types.ts';
import { listCategories, type Scope } from './categoryService.ts';
import { NEVER_SUGGESTED } from './categorySuggestions.ts';
import { addTransaction } from './transactionService.ts';

/**
 * Choices for the quick-add (cash / missed expense) screen, learned from the person's own ledger so a common entry is
 * two or three taps: an amount chip, a category chip, Save.
 *
 * Categories: most used first, with what the person entered themselves (manual or cash) counting more than detected
 * rows, because missed spends are exactly the ones detection never sees. Amounts: the amounts they have entered by hand
 * most often, for the chosen category first. Everything comes from the local ledger; nothing is sent anywhere.
 */
export const MANUAL_WEIGHT = 3;
export const QUICK_CATEGORY_LIMIT = 8;
export const QUICK_AMOUNT_LIMIT = 4;
/** Shown only when there is no history yet, so the screen is useful on day one. */
export const STARTER_AMOUNTS = [20, 50, 100, 200];
/** Cash-style spends offered first when the ledger has no history to learn from. */
export const CASH_STYLE_CATEGORIES = ['Food & Dining', 'Transportation', 'Groceries', 'Shopping', 'Entertainment', 'Bills & Utilities'];

export interface QuickAddRow { category: string; amount_paise: number; manual: boolean }

export interface QuickAddOptions {
  categories: string[];
  /** Whole-currency amounts, most common first, per category (lower-cased key). */
  amountsByCategory: Record<string, number[]>;
  /** Used when the chosen category has no history of its own. */
  fallbackAmounts: number[];
}

const key = (name: string) => name.trim().toLowerCase();

function topAmounts(counts: Map<number, number>, limit: number): number[] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([amount]) => amount);
}

export function rankQuickAdd(rows: QuickAddRow[], allowed: string[]): QuickAddOptions {
  const canonical = new Map<string, string>();
  for (const name of allowed) {
    const k = key(name);
    if (k && !NEVER_SUGGESTED.includes(k) && !canonical.has(k)) canonical.set(k, name);
  }

  const score = new Map<string, number>();
  const perCategory = new Map<string, Map<number, number>>();
  const overall = new Map<number, number>();
  for (const row of rows) {
    const k = key(row.category);
    if (!canonical.has(k)) continue;
    score.set(k, (score.get(k) ?? 0) + (row.manual ? MANUAL_WEIGHT : 1));
    if (!row.manual || row.amount_paise <= 0) continue;
    // Only amounts the person typed: a bank's exact debit (₹437.52) is not a useful shortcut.
    const amount = row.amount_paise / 100;
    const counts = perCategory.get(k) ?? new Map<number, number>();
    counts.set(amount, (counts.get(amount) ?? 0) + 1);
    perCategory.set(k, counts);
    overall.set(amount, (overall.get(amount) ?? 0) + 1);
  }

  const used = [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || a.localeCompare(b));
  const categories: string[] = [];
  for (const k of used) if (categories.length < QUICK_CATEGORY_LIMIT) categories.push(canonical.get(k)!);
  // Pad with common cash-style categories, then the rest, so the row is never nearly empty.
  const padding = [...CASH_STYLE_CATEGORIES.map(key).filter((k) => canonical.has(k)), ...canonical.keys()];
  for (const k of padding) {
    if (categories.length >= QUICK_CATEGORY_LIMIT) break;
    const name = canonical.get(k)!;
    if (!categories.includes(name)) categories.push(name);
  }

  const amountsByCategory: Record<string, number[]> = {};
  for (const [k, counts] of perCategory) amountsByCategory[k] = topAmounts(counts, QUICK_AMOUNT_LIMIT);
  const fallback = topAmounts(overall, QUICK_AMOUNT_LIMIT);
  return { categories, amountsByCategory, fallbackAmounts: fallback.length ? fallback : STARTER_AMOUNTS };
}

/** Amount chips for the chosen category: its own habits first, then the person's general ones. */
export function amountChipsFor(options: QuickAddOptions, category: string): number[] {
  const own = options.amountsByCategory[key(category)] ?? [];
  const out = [...own];
  for (const amount of options.fallbackAmounts) if (out.length < QUICK_AMOUNT_LIMIT && !out.includes(amount)) out.push(amount);
  return out;
}

export async function getQuickAddOptions(db: IDatabase, scope: Scope): Promise<QuickAddOptions> {
  const allowed = (await listCategories(db, scope)).filter((c) => c.type === 'expense').map((c) => c.name);
  const rows = await db.getAllAsync<{ category: string; amount_paise: number; source: string; capture_source: string | null }>(
    `SELECT category, amount_paise, source, capture_source FROM transactions
     WHERE deleted_at IS NULL AND direction = 'expense' AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))
     ORDER BY transaction_date DESC LIMIT 2000`,
    scope, scope,
  );
  return rankQuickAdd(rows.map((r) => ({ category: r.category, amount_paise: r.amount_paise, manual: r.source === 'manual' && (r.capture_source ?? 'manual') === 'manual' })), allowed);
}

export type QuickEntryResult = { ok: true; transaction: TransactionEntity } | { ok: false; error: string };

/** Parses what was typed or tapped. Whole or two-decimal amounts only, greater than zero. */
export function parseQuickAmount(text: string): number | null {
  const typed = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(typed)) return null;
  const value = Number(typed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Saves a missed spend as a manual cash entry through the normal add path, so it is stored locally first, synced when
 * signed in, and counted by reports and charts like any other transaction. No merchant is asked for: it is "Cash".
 */
export async function saveQuickEntry(
  input: { amount: string; category: string; note?: string }, session: Session | null,
): Promise<QuickEntryResult> {
  const amount = parseQuickAmount(input.amount);
  if (amount === null) return { ok: false, error: 'Enter an amount greater than zero (up to two decimals).' };
  if (!input.category.trim()) return { ok: false, error: 'Choose a category.' };
  const note = input.note?.trim() ?? '';
  try {
    const transaction = await addTransaction({
      amount, direction: 'expense', counterparty: 'Cash', category: input.category,
      description: note || 'Cash expense', source: 'manual', capture_source: 'manual', payment_method: 'cash',
    }, session);
    return { ok: true, transaction };
  } catch {
    return { ok: false, error: 'Could not save the entry. Nothing was recorded; please try again.' };
  }
}
