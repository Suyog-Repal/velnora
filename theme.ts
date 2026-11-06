import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** 'system' follows the device's light/dark setting. */
export type ThemeMode = 'light' | 'dark' | 'system';

export const palette = {
  navy: '#10243E',
  navyDeep: '#081827',
  emerald: '#12B886',
  emeraldSoft: '#DDF7EE',
  ink: '#132238',
  muted: '#718096',
  canvas: '#F6F8F9',
  card: '#FFFFFF',
  border: '#E4EAF0',
  danger: '#D95C67',
  dangerDeep: '#B83A47', // filled expense surfaces (white text 5.6:1)
  warning: '#C9892B',
  darkCanvas: '#081827',
  darkCard: '#10243E',
  darkBorder: '#29405A',
  darkText: '#F4F7FA',
  darkMuted: '#A8B5C4',
};

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
}

export const themeStorageKey = 'velnora.theme.v1';
export const accentStorageKey = 'velnora.accent.v1';

export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>('light');
  useEffect(() => {
    void AsyncStorage.getItem(themeStorageKey).then((value) => {
      if (value === 'light' || value === 'dark' || value === 'system') setMode(value);
    }).catch(() => undefined);
  }, []);
  const update = (next: ThemeMode) => {
    setMode(next);
    void AsyncStorage.setItem(themeStorageKey, next).catch(() => undefined);
  };
  return [mode, update];
}

export function useAccent(): [AccentId, (id: AccentId) => void] {
  const [accent, setAccent] = useState<AccentId>('emerald');
  useEffect(() => {
    void AsyncStorage.getItem(accentStorageKey).then((value) => {
      if (ACCENTS.some((a) => a.id === value)) setAccent(value as AccentId);
    }).catch(() => undefined);
  }, []);
  const update = (next: AccentId) => {
    setAccent(next);
    void AsyncStorage.setItem(accentStorageKey, next).catch(() => undefined);
  };
  return [accent, update];
}

/** Resolves 'system' to the device scheme. */
export function useResolvedScheme(mode: ThemeMode): 'light' | 'dark' {
  const device = useColorScheme();
  return mode === 'system' ? (device === 'dark' ? 'dark' : 'light') : mode;
}

export const currencyStorageKey = 'velnora.currency.v1';

/** Persisted display currency (symbol/format only; no conversion). Updates the formatter before children render. */
export function useCurrency(setActive: (code: string) => void): [string, (code: string) => void] {
  const [code, setCode] = useState('INR');
  useEffect(() => {
    void AsyncStorage.getItem(currencyStorageKey).then((v) => { if (v) setCode(v); }).catch(() => undefined);
  }, []);
  setActive(code);
  const update = (next: string) => {
    setCode(next);
    void AsyncStorage.setItem(currencyStorageKey, next).catch(() => undefined);
  };
  return [code, update];
}
