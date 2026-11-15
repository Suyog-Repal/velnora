import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACCENTS, DEFAULT_THEME_MODE, palette, parseThemeMode, type AccentId, type ThemeMode } from './tokens';

// Pure design tokens (palette, spacing, semantic roles, contrast helpers) live in tokens.ts so they are testable in Node.
export * from './tokens';

export const themeStorageKey = 'velnora.theme.v1';
export const accentStorageKey = 'velnora.accent.v1';

/**
 * [mode, setMode, ready]. `ready` turns true once the stored preference has been read, so the app can wait for it
 * instead of drawing the first frame in the default theme and then switching (no wrong-theme flash at startup).
 */
export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void, boolean] {
  const [mode, setMode] = useState<ThemeMode>(DEFAULT_THEME_MODE);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void AsyncStorage.getItem(themeStorageKey).then((value) => {
      const stored = parseThemeMode(value);
      if (stored) setMode(stored);
    }).catch(() => undefined).finally(() => setReady(true));
  }, []);
  const update = (next: ThemeMode) => {
    setMode(next);
    void AsyncStorage.setItem(themeStorageKey, next).catch(() => undefined);
  };
  return [mode, update, ready];
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

