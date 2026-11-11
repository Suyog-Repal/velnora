/** 'system' follows the device's light/dark setting. */
export type ThemeMode = 'light' | 'dark' | 'system';

export const palette = {
  navy: '#10243E',
  navyDeep: '#081827',
  emerald: '#12B886',
  emeraldSoft: '#DDF7EE',
  ink: '#172B27',
  muted: '#587069', // >= 4.5:1 on canvas and white (soft green-grey)
  canvas: '#F5F8F7',
  card: '#FFFFFF',
  border: '#E5ECE8',
  danger: '#D95C67',
  dangerDeep: '#B83A47', // filled expense surfaces (white text 5.6:1)
  warning: '#C9892B',
  darkCanvas: '#081827',
  darkCard: '#10243E',
  darkBorder: '#29405A',
  darkText: '#F4F7FA',
  darkMuted: '#A8B5C4',
  // Text/icons drawn on the navy hero surfaces (balance card, profile header, splash).
  onNavy: '#FFFFFF',
  onNavyMuted: '#B9C9D7',
  onNavySoft: '#C8D5DF',
  expenseOnNavy: '#FF9AA3', // coral that keeps 7:1 on navy
  navyBorder: '#29405A',
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
/** Call whenever the scheme or accent changes (before styles are rebuilt). */
export function applyScheme(dark: boolean): void {
  currentDark = dark;
  const surface = dark ? palette.darkCard : palette.card;
  palette.accentText = ensureContrast(palette.emerald, surface);
  palette.expenseText = ensureContrast(dark ? '#FF8A94' : palette.dangerDeep, surface);
}
export const isDarkScheme = (): boolean => currentDark;

/** `color` at ~12% alpha: icon plates / soft fills that work on both light and dark surfaces. */
export const tint = (color: string, alpha = 0.12): string => `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;

export type AccentId = 'emerald' | 'ocean' | 'violet' | 'sunset' | 'rose';
export const ACCENTS: { id: AccentId; label: string; main: string; soft: string }[] = [
  { id: 'emerald', label: 'Emerald', main: '#12B886', soft: '#DDF7EE' },
  { id: 'ocean', label: 'Ocean', main: '#2F80ED', soft: '#DCEBFD' },
  { id: 'violet', label: 'Violet', main: '#7C5CFC', soft: '#E9E3FF' },
  { id: 'sunset', label: 'Sunset', main: '#F2994A', soft: '#FDEBD9' },
  { id: 'rose', label: 'Rose', main: '#E5527A', soft: '#FBE0E8' },
];

/** `palette.emerald` is the app's accent colour; applying an accent re-points it (callers then rebuild their styles). */
export function applyAccent(id: AccentId): void {
  const accent = ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
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
    surfaceMuted: dark ? '#162F4B' : '#EEF2F5',
    border: dark ? palette.darkBorder : palette.border,
    text: dark ? palette.darkText : palette.ink,
    textSecondary: dark ? palette.darkMuted : palette.muted,
    income: palette.emerald,
    incomeSoft: dark ? `${palette.emerald}2E` : palette.emeraldSoft,
    expense: palette.danger,
    expenseSoft: dark ? `${palette.danger}2E` : '#FCE7EA',
    success: palette.emerald,
    warning: palette.warning,
    error: palette.dangerDeep,
  } as const;
}
