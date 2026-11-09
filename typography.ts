import type { TextStyle } from 'react-native';

/**
 * Velnora type scale. One source of truth for font size / weight / line height.
 *
 * Font: the platform UI font (Roboto on Android). It is clean, supports tabular numerals and costs nothing at
 * startup. Bundling Inter would add font assets + expo-font and a native rebuild for a marginal visual gain.
 *
 * Weights: 700 is reserved for the screen title, hero figure and amounts; headings use 600; body 400/500.
 */
const tabular: TextStyle['fontVariant'] = ['tabular-nums'];

export const type = {
  /** Screen title (greeting). */
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.4 },
  /** Auth / large headings. */
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.3 },
  /** Sheet / modal / profile headings. */
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '600', letterSpacing: -0.2 },
  /** Section headers. */
  section: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  /** Card titles, list primary text. */
  cardTitle: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  /** Body copy and form values. */
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  /** Supporting text. */
  caption: { fontSize: 12, lineHeight: 18, fontWeight: '400' },
  captionStrong: { fontSize: 12, lineHeight: 18, fontWeight: '600' },
  /** Small uppercase field / metric labels. */
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.6 },
  /** Links, chips, small buttons. */
  link: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  chip: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  /** Primary / secondary button text. */
  button: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  /** Bottom navigation label. */
  nav: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  /** Brand overline. */
  overline: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 1.6 },
  /** Currency figures: tabular numerals so digits line up. */
  amountHero: { fontSize: 36, lineHeight: 44, fontWeight: '700', letterSpacing: -0.5, fontVariant: tabular },
  amountLg: { fontSize: 28, lineHeight: 36, fontWeight: '700', letterSpacing: -0.3, fontVariant: tabular },
  amountMd: { fontSize: 18, lineHeight: 24, fontWeight: '700', fontVariant: tabular },
  amountSm: { fontSize: 15, lineHeight: 20, fontWeight: '600', fontVariant: tabular },
  amountInput: { fontSize: 28, lineHeight: 34, fontWeight: '700', fontVariant: tabular },
} as const satisfies Record<string, TextStyle>;

export const numeric = { fontVariant: tabular } as const;

/** Alias for files where a local variable is already called `type`. */
export const typo = type;
