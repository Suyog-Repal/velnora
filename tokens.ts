/** 'system' follows the device's light/dark setting. */
export type ThemeMode = 'light' | 'dark' | 'system';

export const palette = {
  navy: '#13241F',
  navyDeep: '#0C1512',
  emerald: '#12B886',
  emeraldSoft: '#DDF7EE',
  ink: '#182521',
  muted: '#5F6D68', // spec #64736D deepened a touch: >= 4.5:1 on every light surface, incl. the secondary background #EEF2F0 // >= 4.5:1 on canvas and white (soft green-grey)
  canvas: '#F4F7F5',
  card: '#FFFFFF',
  border: '#E3EAE6',
  danger: '#D95C67',
  dangerDeep: '#B83A47', // filled expense surfaces (white text 5.6:1)
  warning: '#C9892B',
  darkCanvas: '#101211',
  darkCard: '#191E1C',
  darkBorder: '#303936',
  darkText: '#F5F7F6',
  darkMuted: '#A3AEA8',
  // Charcoal surfaces of the dark theme (Uber-inspired, no navy): secondary background, elevated surface, input, navigation.
  darkCanvas2: '#151918',
  darkElevated: '#202624',
  darkInput: '#1C2220',
  darkNav: '#151918',
  darkFaint: '#77827C',
  // Light theme: secondary background, input surface, faint text.
  canvas2: '#EEF2F0',
  input: '#F7F9F8',
  faint: '#89958F',
  emeraldDeep: '#087653',
  // Supporting accents (Quick Access tiles, expected payments, reports). Re-derived per scheme by applyScheme.
  info: '#2F6FB5',
  report: '#7650C9',
  amber: '#A86B12',
  // Text/icons drawn on the navy hero surfaces (balance card, profile header, splash).
  onNavy: '#FFFFFF',
  onNavyMuted: '#B9C9D7',
  onNavySoft: '#C8D5DF',
  expenseOnNavy: '#FF9AA3', // coral that keeps 7:1 on navy
  navyBorder: '#2A3B35',
  errorStrong: '#DC2626',
  // Home summary card gradient: darkened shades of the accent, re-derived by applyAccent.
  heroStart: '#0A5A46',
  heroEnd: '#07382C',
  incomeOnHero: '#8EF0CF',
  // Text-safe variants (>= 4.5:1 on the current surface). Re-derived by applyScheme / applyAccent.
  accentText: '#0A7F5E',
  expenseText: '#B83A47',
};

function channel(v: number): number { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
/** WCAG relative luminance of #RRGGBB. */
export function luminanceOf(hex: string): number {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
/** Nudges `color` toward black (light surface) or white (dark surface) until it reads at >= `min`:1 on `bg`. Keeps the hue. */
export function ensureContrast(color: string, bg: string, min = 4.5): string {
  const m = /^#?([0-9a-f]{6})/i.exec(color.trim());
  if (!m) return color;
  const target = luminanceOf(bg) > 0.5 ? 0 : 255;
  const n = parseInt(m[1], 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  let out = color;
  for (let step = 0; step <= 20 && contrastRatio(out, bg) < min; step += 1) {
    const t = step * 0.05;
    out = `#${rgb.map((v) => toHex(v + (target - v) * t)).join('')}`;
  }
  return out;
}

/** Multiplies each RGB channel by `factor` (< 1 darkens), keeping the hue. */
export function shade(color: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toHex(v * factor)).join('')}`;
}

let currentDark = false;
let currentAccent: AccentId = 'emerald';
/** The brand emerald per scheme: bright mint on charcoal, deeper emerald on white (both >= 4.5:1 for text on cards). */
export const BRAND_EMERALD = { dark: '#43D6A0', light: '#07865F', darkSoft: '#12382B', lightSoft: '#DDF3EA' } as const;
/** Call whenever the scheme or accent changes (before styles are rebuilt). */
export function applyScheme(dark: boolean): void {
  currentDark = dark;
  if (currentAccent === 'emerald') {
    palette.emerald = dark ? BRAND_EMERALD.dark : BRAND_EMERALD.light;
    palette.emeraldSoft = dark ? BRAND_EMERALD.darkSoft : BRAND_EMERALD.lightSoft;
    palette.heroStart = dark ? '#0F3A2C' : BRAND_EMERALD.light;
    palette.heroEnd = dark ? '#0B241C' : palette.emeraldDeep;
  }
  palette.info = dark ? '#63B7F5' : '#2F6FB5';
  palette.report = dark ? '#B58AFF' : '#7650C9';
  palette.amber = dark ? '#E8B95F' : '#A86B12';
  // Text colours must read on every surface of the scheme, so they are checked against the least contrasting one
  // (light: the secondary background; dark: the elevated surface), which covers cards, page and inputs too.
  const surface = dark ? palette.darkElevated : palette.canvas2;
  palette.accentText = ensureContrast(palette.emerald, surface);
  palette.expenseText = ensureContrast(dark ? '#E97883' : '#C64F5C', surface);
}
export const isDarkScheme = (): boolean => currentDark;

/** `color` at ~12% alpha: icon plates / soft fills that work on both light and dark surfaces. */
export const tint = (color: string, alpha = 0.12): string => `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;

export type AccentId = 'emerald' | 'ocean' | 'violet' | 'sunset' | 'rose';
export const ACCENTS: { id: AccentId; label: string; main: string; soft: string }[] = [
  { id: 'emerald', label: 'Emerald', main: '#12B886', soft: '#DDF7EE' },
  { id: 'ocean', label: 'Ocean', main: '#2F80ED', soft: '#DCEBFD' },
  { id: 'violet', label: 'Violet', main: '#7A5AF7', soft: '#E9E3FF' }, // 2% deeper than #7C5CFC: text on violet buttons reaches 4.5:1
  { id: 'sunset', label: 'Sunset', main: '#F2994A', soft: '#FDEBD9' },
  { id: 'rose', label: 'Rose', main: '#E5527A', soft: '#FBE0E8' },
];

/** `palette.emerald` is the app's accent colour; applying an accent re-points it (callers then rebuild their styles). */
export function applyAccent(id: AccentId): void {
  const accent = ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
  currentAccent = accent.id;
  palette.emerald = accent.main;
  palette.emeraldSoft = accent.soft;
  palette.heroStart = shade(accent.main, 0.5);
  palette.heroEnd = shade(accent.main, 0.3);
}

/** Shared layout tokens so spacing / radius / elevation stop being re-invented per component. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 } as const;
export const radius = { sm: 10, md: 14, lg: 18, xl: 24, pill: 999 } as const;
export const control = { height: 48, buttonHeight: 52, minTouch: 44, chipHeight: 36 } as const;
/** Screen gutters and bottom-navigation metrics. */
export const layout = { gutter: 20, sectionGap: 24, navHeight: 64, navPill: { width: 56, height: 30 } } as const;
/** Standard icon grid: one stroke width everywhere, three sizes. */
export const iconSize = { sm: 16, md: 20, lg: 24, stroke: 2 } as const;
/** One restrained elevation for floating surfaces (FAB); cards rely on a border instead of a shadow. */
export const elevation = {
  card: { shadowColor: '#0B2A24', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  fab: { shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
} as const;

/**
 * Semantic colour roles resolved per scheme. Components should read these instead of picking raw hex values.
 * `primary` follows the user's chosen accent.
 */
export function semantic(dark: boolean) {
  return {
    primary: palette.emerald,
    primarySoft: dark ? `${palette.emerald}38` : palette.emeraldSoft,
    secondary: palette.navy,
    background: dark ? palette.darkCanvas : palette.canvas,
    surface: dark ? palette.darkCard : palette.card,
    surfaceMuted: dark ? palette.darkElevated : palette.canvas2,
    backgroundSecondary: dark ? palette.darkCanvas2 : palette.canvas2,
    elevated: dark ? palette.darkElevated : palette.card,
    input: dark ? palette.darkInput : palette.input,
    navigation: dark ? palette.darkNav : palette.card,
    textFaint: dark ? palette.darkFaint : palette.faint,
    info: palette.info,
    report: palette.report,
    amber: palette.amber,
    border: dark ? palette.darkBorder : palette.border,
    text: dark ? palette.darkText : palette.ink,
    textSecondary: dark ? palette.darkMuted : palette.muted,
    income: palette.emerald,
    incomeSoft: dark ? `${palette.emerald}2E` : palette.emeraldSoft,
    expense: palette.expenseText,
    expenseSoft: dark ? `${palette.danger}2E` : '#FCE7EA',
    success: palette.emerald,
    warning: palette.warning,
    error: palette.dangerDeep,
  } as const;
}

/** Default for new installs only. An existing stored preference is never overwritten. */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

/** Reads a stored preference; anything other than the three semantic values means "none stored". */
export function parseThemeMode(value: string | null | undefined): ThemeMode | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null;
}

/** Colour roles handed to every screen (src/ui/common's Colors). */
export interface ThemeColors {
  canvas: string; card: string; border: string; text: string; muted: string;
  canvas2: string; elevated: string; input: string; nav: string; faint: string;
}
/** Builds the Colors roles for a scheme from the central tokens (single source for App and tests). */
export function themeColors(dark: boolean): ThemeColors {
  return dark
    ? { canvas: palette.darkCanvas, card: palette.darkCard, border: palette.darkBorder, text: palette.darkText, muted: palette.darkMuted,
        canvas2: palette.darkCanvas2, elevated: palette.darkElevated, input: palette.darkInput, nav: palette.darkNav, faint: palette.darkFaint }
    : { canvas: palette.canvas, card: palette.card, border: palette.border, text: palette.ink, muted: palette.muted,
        canvas2: palette.canvas2, elevated: palette.card, input: palette.input, nav: palette.card, faint: palette.faint };
}
