import assert from 'node:assert/strict';
import { rankCategorySuggestions, RECENCY_HALF_LIFE_DAYS } from '../categorySuggestions.ts';
import { GROUP_WINDOW_MS, isWithinGroupWindow, shouldGroup } from '../notificationGrouping.ts';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 21);
const allowed = ['Food & Dining', 'Groceries', 'Transportation', 'Other Expenses', 'Transfer', 'Refund', 'Cash Withdrawal', 'Gym'];
let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`✓ ${name}`); };

test('same-merchant history comes first, then most-used fallback', () => {
  const out = rankCategorySuggestions({ history: [{ category: 'Gym', at: now - DAY }], usage: [{ category: 'Groceries', count: 9 }, { category: 'Gym', count: 1 }], allowed, now });
  assert.deepEqual(out, ['Gym', 'Groceries']);
});
test('catch-all and kind-based buckets are never suggested, even if most used', () => {
  const out = rankCategorySuggestions({ history: [{ category: 'Other Expenses', at: now }], usage: [{ category: 'Other Expenses', count: 99 }, { category: 'Transfer', count: 50 }, { category: 'Refund', count: 40 }, { category: 'Cash Withdrawal', count: 30 }, { category: 'Groceries', count: 1 }], allowed, now, limit: 4 });
  assert.deepEqual(out, ['Groceries']);
});
test('recent categorisations outweigh older ones', () => {
  const old = Array.from({ length: 3 }, (_, i) => ({ category: 'Food & Dining', at: now - (200 + i) * DAY }));
  const out = rankCategorySuggestions({ history: [...old, { category: 'Groceries', at: now - 2 * DAY }], usage: [], allowed, now });
  assert.equal(out[0], 'Groceries');
});
test('many equally-aged votes beat a single one', () => {
  const out = rankCategorySuggestions({ history: [{ category: 'Groceries', at: now - DAY }, { category: 'Food & Dining', at: now - DAY }, { category: 'Food & Dining', at: now - 2 * DAY }], usage: [], allowed, now });
  assert.deepEqual(out, ['Food & Dining', 'Groceries']);
});
test('half-life: a vote one half-life old is worth half', () => {
  const out = rankCategorySuggestions({ history: [{ category: 'Groceries', at: now - RECENCY_HALF_LIFE_DAYS * DAY }, { category: 'Gym', at: now - RECENCY_HALF_LIFE_DAYS * DAY, weight: 0.4 }], usage: [], allowed, now });
  assert.deepEqual(out, ['Groceries', 'Gym']);
});
test('only categories valid for this scope and direction, using their own spelling', () => {
  const out = rankCategorySuggestions({ history: [{ category: 'salary', at: now }, { category: 'groceries', at: now }], usage: [], allowed, now });
  assert.deepEqual(out, ['Groceries']);
});
test('respects limit, no duplicates, empty when nothing qualifies', () => {
  assert.equal(rankCategorySuggestions({ history: [], usage: [{ category: 'Groceries', count: 1 }, { category: 'Gym', count: 1 }, { category: 'Food & Dining', count: 1 }], allowed, now, limit: 2 }).length, 2);
  assert.deepEqual(rankCategorySuggestions({ history: [], usage: [], allowed, now }), []);
});

test('grouping: one transaction alone is individual', () => assert.equal(shouldGroup({ due: 1, summarized: 0, recentlyAnnounced: 0, maxIndividual: 3 }), false));
test('grouping: a second one inside the window groups', () => assert.equal(shouldGroup({ due: 1, summarized: 0, recentlyAnnounced: 1, maxIndividual: 3 }), true));
test('grouping: two arriving together group', () => assert.equal(shouldGroup({ due: 2, summarized: 0, recentlyAnnounced: 0, maxIndividual: 3 }), true));
test('grouping: backlog above the limit groups; nothing due never does', () => {
  assert.equal(shouldGroup({ due: 3, summarized: 1, recentlyAnnounced: 0, maxIndividual: 3 }), true);
  assert.equal(shouldGroup({ due: 0, summarized: 5, recentlyAnnounced: 5, maxIndividual: 3 }), false);
});
test('grouping window edges', () => {
  const at = new Date(now).toISOString();
  assert.equal(isWithinGroupWindow(at, now + GROUP_WINDOW_MS - 1), true);
  assert.equal(isWithinGroupWindow(at, now + GROUP_WINDOW_MS), false);
  assert.equal(isWithinGroupWindow('garbage', now), false);
});
console.log(`${passed} passed`);
