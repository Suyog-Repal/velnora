import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemeMode = 'light' | 'dark';

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
  warning: '#C9892B',
  darkCanvas: '#081827',
  darkCard: '#10243E',
  darkBorder: '#29405A',
  darkText: '#F4F7FA',
  darkMuted: '#A8B5C4',
};

export const themeStorageKey = 'velnora.theme.v1';

export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>('light');
  useEffect(() => {
    void AsyncStorage.getItem(themeStorageKey).then((value) => {
      if (value === 'light' || value === 'dark') setMode(value);
    });
  }, []);
  const update = (next: ThemeMode) => {
    setMode(next);
    void AsyncStorage.setItem(themeStorageKey, next);
  };
  return [mode, update];
}
