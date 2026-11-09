import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACCENTS, palette, type AccentId, type ThemeMode } from './tokens';

// Pure design tokens (palette, spacing, semantic roles, contrast helpers) live in tokens.ts so they are testable in Node.
export * from './tokens';

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

