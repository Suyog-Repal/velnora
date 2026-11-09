import assert from 'node:assert/strict';
import { ACCENTS, applyAccent, applyScheme, contrastRatio, palette } from '../../../tokens.ts';
import { type } from '../../../typography.ts';

// Text-safe accent / expense colours reach 4.5:1 on their surface for every accent, light and dark.
for (const accent of ACCENTS) {
  for (const dark of [false, true]) {
    applyAccent(accent.id); applyScheme(dark);
    const surface = dark ? palette.darkCard : palette.card;
    const canvas = dark ? palette.darkCanvas : palette.canvas;
    for (const [name, color] of [['accentText', palette.accentText], ['expenseText', palette.expenseText]] as const) {
      assert.ok(contrastRatio(color, surface) >= 4.5, `${accent.id} ${dark ? 'dark' : 'light'} ${name} on surface: ${contrastRatio(color, surface).toFixed(2)}`);
    }
    assert.ok(contrastRatio(dark ? palette.darkMuted : palette.muted, canvas) >= 4.5, `muted text on ${dark ? 'dark' : 'light'} canvas`);
  }
}
applyAccent('emerald'); applyScheme(false);

// Type scale rules: nothing below 12, only display/amounts at 700, amounts use tabular numerals, nav label 12-13.
for (const [name, style] of Object.entries(type)) {
  assert.ok(style.fontSize >= 12, `${name} fontSize ${style.fontSize} < 12`);
  assert.ok(style.lineHeight >= style.fontSize, `${name} lineHeight`);
  if (name.startsWith('amount')) assert.deepEqual(style.fontVariant, ['tabular-nums'], `${name} must use tabular numerals`);
}
assert.ok(type.nav.fontSize >= 12 && type.nav.fontSize <= 13);
assert.ok(type.display.fontSize >= 28 && type.display.fontSize <= 30);
assert.ok(type.section.fontSize >= 18 && type.section.fontSize <= 22);
assert.ok(type.cardTitle.fontSize >= 16 && type.cardTitle.fontSize <= 18);
console.log('design token tests passed');
