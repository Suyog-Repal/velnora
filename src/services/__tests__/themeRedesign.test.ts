/**
 * Application-wide theme redesign + Home Quick Access:
 *  - the dark and light roles are the specified charcoal / neutral tokens (no navy left),
 *  - text roles stay readable (WCAG >= 4.5:1 for body text, >= 3:1 for large/secondary UI),
 *  - the brand emerald changes per scheme for the default accent, and text on every filled accent stays readable,
 *  - theme preference parsing: only system / light / dark are honoured, dark is the default for new installs only,
 *  - Quick Access configuration is normalised, reorderable, hideable and round-trips through storage,
 *  - Today card copy is pluralised correctly.
 */
import assert from 'node:assert/strict';
import { ACCENTS, BRAND_EMERALD, DEFAULT_THEME_MODE, applyAccent, applyScheme, contrastRatio, palette, parseThemeMode, semantic, themeColors } from '../../../tokens.ts';
import {
  DEFAULT_QUICK_ACCESS, QUICK_ACCESS_LABELS, move, normalizeQuickAccess, reviewCta, serializeQuickAccess, setVisible, todaySummaryLine, visibleShortcuts,
} from '../quickAccess.ts';

const NAVY = ['#10243E', '#081827', '#29405A', '#162F4B', '#0B1726'];

// 1. Exact spec tokens.
{
  applyAccent('emerald'); applyScheme(true);
  assert.deepEqual(themeColors(true), {
    canvas: '#101211', card: '#191E1C', border: '#303936', text: '#F5F7F6', muted: '#A3AEA8',
    canvas2: '#151918', elevated: '#202624', input: '#1C2220', nav: '#151918', faint: '#77827C',
  });
  assert.equal(palette.emerald, '#43D6A0');
  assert.equal(palette.emeraldSoft, '#12382B');
  assert.equal(palette.emeraldDeep, '#087653');
  assert.equal(palette.expenseText, '#E97883');
  applyScheme(false);
  assert.deepEqual(themeColors(false), {
    canvas: '#F4F7F5', card: '#FFFFFF', border: '#E3EAE6', text: '#182521', muted: '#5F6D68', // spec #64736D, AA-adjusted
    canvas2: '#EEF2F0', elevated: '#FFFFFF', input: '#F7F9F8', nav: '#FFFFFF', faint: '#89958F',
  });
  assert.equal(palette.emerald, '#07865F');
  // Spec #C64F5C reads at only ~4.4:1 on white, below AA for body text: the same hue is nudged just enough to pass.
  assert.ok(contrastRatio('#C64F5C', '#FFFFFF') < 4.5);
  // Light text shades are the spec hues deepened just enough for >= 4.5:1 on EVERY light surface (incl. #EEF2F0);
  // fills / icons keep the spec emerald #07865F (asserted above), dark keeps the exact spec values.
  for (const bg of ['#FFFFFF', '#F4F7F5', '#EEF2F0', '#F7F9F8']) {
    assert.ok(contrastRatio(palette.expenseText, bg) >= 4.5, `expense text on ${bg}`);
    assert.ok(contrastRatio(palette.accentText, bg) >= 4.5, `emerald text on ${bg}`);
  }
  assert.equal(palette.accentText.toUpperCase(), '#067956');
  assert.equal(palette.expenseText.toUpperCase(), '#B24753');
  console.log('ok: dark and light roles match the specified tokens');
}

// 2. No navy anywhere in the scheme roles or the semantic roles.
for (const dark of [true, false]) {
  applyScheme(dark);
  const values = [...Object.values(themeColors(dark)), ...Object.values(semantic(dark)).filter((v): v is string => typeof v === 'string')];
  for (const v of values) assert.ok(!NAVY.includes(v.toUpperCase()), `${dark ? 'dark' : 'light'} theme still uses navy ${v}`);
  for (const v of [palette.navy, palette.navyDeep, palette.darkCanvas, palette.darkCard]) assert.ok(!NAVY.includes(v.toUpperCase()), `palette navy ${v}`);
}
console.log('ok: no navy colours remain');

// 3. Readability.
for (const dark of [true, false]) {
  applyAccent('emerald'); applyScheme(dark);
  const c = themeColors(dark);
  for (const bg of [c.canvas, c.card, c.canvas2, c.elevated, c.input]) {
    assert.ok(contrastRatio(c.text, bg) >= 7, `${dark} text on ${bg}`);
    assert.ok(contrastRatio(c.muted, bg) >= 4.5, `${dark} secondary text ${c.muted} on ${bg}: ${contrastRatio(c.muted, bg).toFixed(2)}`);
    assert.ok(contrastRatio(palette.accentText, bg) >= 4.5, `${dark} emerald text on ${bg}`);
    assert.ok(contrastRatio(palette.expenseText, bg) >= 4.5, `${dark} expense text on ${bg}: ${contrastRatio(palette.expenseText, bg).toFixed(2)}`);
  }
  assert.ok(contrastRatio(c.faint, c.card) >= 3, `${dark} faint (large/secondary) text`);
  for (const accent of [palette.info, palette.report, palette.amber]) assert.ok(contrastRatio(accent, c.card) >= 3, `${dark} supporting accent ${accent}`);
}
console.log('ok: text roles readable in both themes');

// 4. Brand emerald per scheme; other accents keep their own colour; filled accents keep readable text.
{
  const readable = (bg: string) => Math.max(contrastRatio('#FFFFFF', bg), contrastRatio('#101211', bg));
  for (const dark of [true, false]) {
    for (const a of ACCENTS) {
      applyAccent(a.id); applyScheme(dark);
      if (a.id === 'emerald') assert.equal(palette.emerald, dark ? BRAND_EMERALD.dark : BRAND_EMERALD.light);
      else assert.equal(palette.emerald, a.main, `${a.id} accent keeps its colour`);
      assert.ok(readable(palette.emerald) >= 4.5, `${a.id} fill readable (${dark ? 'dark' : 'light'})`);
    }
  }
  applyAccent('emerald');
  console.log('ok: brand emerald per scheme, accents preserved, fills readable');
}

// 5. Theme preference: semantic values only; dark only as the default for new installs.
{
  assert.equal(DEFAULT_THEME_MODE, 'dark');
  assert.equal(parseThemeMode('system'), 'system');
  assert.equal(parseThemeMode('light'), 'light');
  assert.equal(parseThemeMode('dark'), 'dark');
  for (const bad of [null, undefined, '', 'Dark', 'auto', 'night', '{"mode":"dark"}']) assert.equal(parseThemeMode(bad as string | null), null);
  // An existing preference wins over the default (what useThemeMode does with the stored value).
  const resolve = (stored: string | null) => parseThemeMode(stored) ?? DEFAULT_THEME_MODE;
  assert.equal(resolve('light'), 'light', 'existing light users are not switched to dark');
  assert.equal(resolve('system'), 'system');
  assert.equal(resolve(null), 'dark', 'new install');
  console.log('ok: theme preference parsing and defaults');
}

// 6. Quick Access configuration.
{
  assert.deepEqual(visibleShortcuts(DEFAULT_QUICK_ACCESS), ['add', 'expected', 'report', 'incomeExpense']);
  assert.deepEqual(Object.values(QUICK_ACCESS_LABELS), ['Add Transaction', 'Expected Payment', 'Monthly Report', 'Income / Expense']);
  for (const bad of [null, undefined, 42, 'not json', '{}', '[1,2]', JSON.stringify({ id: 'add' })]) {
    assert.deepEqual(normalizeQuickAccess(bad), DEFAULT_QUICK_ACCESS.map((i) => ({ ...i })), `invalid ${String(bad)} -> default`);
  }
  // stored order kept, duplicates and unknown ids dropped, missing ids appended visible
  const stored = JSON.stringify([{ id: 'report', visible: false }, { id: 'bogus' }, { id: 'add' }, { id: 'report', visible: true }]);
  const n = normalizeQuickAccess(stored);
  assert.deepEqual(n, [{ id: 'report', visible: false }, { id: 'add', visible: true }, { id: 'expected', visible: true }, { id: 'incomeExpense', visible: true }]);
  // move and hide; out-of-range moves are no-ops; inputs are never mutated
  const moved = move(DEFAULT_QUICK_ACCESS, 'report', -1);
  assert.deepEqual(moved.map((i) => i.id), ['add', 'report', 'expected', 'incomeExpense']);
  assert.deepEqual(move(DEFAULT_QUICK_ACCESS, 'add', -1).map((i) => i.id), ['add', 'expected', 'report', 'incomeExpense']);
  assert.deepEqual(move(DEFAULT_QUICK_ACCESS, 'incomeExpense', 1).map((i) => i.id), ['add', 'expected', 'report', 'incomeExpense']);
  const hidden = setVisible(moved, 'expected', false);
  assert.deepEqual(visibleShortcuts(hidden), ['add', 'report', 'incomeExpense']);
  assert.deepEqual(visibleShortcuts(DEFAULT_QUICK_ACCESS), ['add', 'expected', 'report', 'incomeExpense'], 'default untouched');
  // storage round-trip
  assert.deepEqual(normalizeQuickAccess(serializeQuickAccess(hidden)), hidden);
  console.log('ok: Quick Access normalise / reorder / hide / persist');
}

// 7. Today card copy.
{
  assert.equal(todaySummaryLine({ totalCount: 195, verifiedCount: 157, detectedCount: 11, needsReviewCount: 27 }), '195 transactions: 157 verified, 11 detected, 27 to review');
  assert.equal(todaySummaryLine({ totalCount: 1, verifiedCount: 1, detectedCount: 0, needsReviewCount: 0 }), '1 transaction: 1 verified, 0 detected, 0 to review');
  assert.equal(reviewCta(27), 'Review 27 transactions');
  assert.equal(reviewCta(1), 'Review 1 transaction');
  console.log('ok: Today card copy');
}

console.log('themeRedesign: all passed');
