/**
 * Home "Quick Access" shortcuts: which ones are shown and in what order. Pure (no React / storage), so it is unit-tested.
 * The preference is stored as JSON under QUICK_ACCESS_STORAGE_KEY; anything unreadable falls back to the default.
 */
export type QuickAccessId = 'add' | 'expected' | 'report' | 'incomeExpense';

export interface QuickAccessItem { id: QuickAccessId; visible: boolean }

export const QUICK_ACCESS_STORAGE_KEY = 'velnora.home.quickAccess.v1';

export const QUICK_ACCESS_LABELS: Record<QuickAccessId, string> = {
  add: 'Add Transaction',
  expected: 'Expected Payment',
  report: 'Monthly Report',
  incomeExpense: 'Income / Expense',
};

export const DEFAULT_QUICK_ACCESS: readonly QuickAccessItem[] = [
  { id: 'add', visible: true },
  { id: 'expected', visible: true },
  { id: 'report', visible: true },
  { id: 'incomeExpense', visible: true },
];

const KNOWN = new Set<QuickAccessId>(DEFAULT_QUICK_ACCESS.map((i) => i.id));

/**
 * Turns a stored value into a complete, valid configuration: unknown or duplicate ids are dropped, shortcuts missing from
 * the stored list (for example added in a later version) are appended visible, and invalid input yields the default.
 */
export function normalizeQuickAccess(stored: unknown): QuickAccessItem[] {
  let raw: unknown = stored;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (!Array.isArray(raw)) return DEFAULT_QUICK_ACCESS.map((i) => ({ ...i }));
  const out: QuickAccessItem[] = [];
  const seen = new Set<QuickAccessId>();
  for (const entry of raw) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id !== 'string' || !KNOWN.has(id as QuickAccessId) || seen.has(id as QuickAccessId)) continue;
    seen.add(id as QuickAccessId);
    out.push({ id: id as QuickAccessId, visible: (entry as { visible?: unknown }).visible !== false });
  }
  for (const d of DEFAULT_QUICK_ACCESS) if (!seen.has(d.id)) out.push({ ...d });
  return out;
}

export function setVisible(items: readonly QuickAccessItem[], id: QuickAccessId, visible: boolean): QuickAccessItem[] {
  return items.map((i) => (i.id === id ? { ...i, visible } : { ...i }));
}

/** Moves a shortcut one place up (-1) or down (+1); out-of-range moves leave the order unchanged. */
export function move(items: readonly QuickAccessItem[], id: QuickAccessId, delta: -1 | 1): QuickAccessItem[] {
  const list = items.map((i) => ({ ...i }));
  const from = list.findIndex((i) => i.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return list;
  [list[from], list[to]] = [list[to], list[from]];
  return list;
}

export const visibleShortcuts = (items: readonly QuickAccessItem[]): QuickAccessId[] => items.filter((i) => i.visible).map((i) => i.id);
export const serializeQuickAccess = (items: readonly QuickAccessItem[]): string => JSON.stringify(items.map(({ id, visible }) => ({ id, visible })));

/** Home "Today" card copy, kept pure so the wording and pluralisation are tested. */
export function todaySummaryLine(h: { totalCount: number; verifiedCount: number; detectedCount: number; needsReviewCount: number }): string {
  return `${h.totalCount} transaction${h.totalCount === 1 ? '' : 's'}: ${h.verifiedCount} verified, ${h.detectedCount} detected, ${h.needsReviewCount} to review`;
}
export const reviewCta = (n: number): string => `Review ${n} transaction${n === 1 ? '' : 's'}`;

