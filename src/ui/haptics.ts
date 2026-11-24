/**
 * Light haptics. expo-haptics is a native module: an app build made before it was added does not contain it, so it is loaded lazily
 * and any failure falls back to a short system vibration (or nothing). Never throws, never blocks.
 */
import { Platform, Vibration } from 'react-native';

interface HapticsModule {
  impactAsync(style: unknown): Promise<void>;
  notificationAsync(type: unknown): Promise<void>;
  ImpactFeedbackStyle: { Light: unknown };
  NotificationFeedbackType: { Success: unknown };
}

let cached: HapticsModule | null | undefined;
function haptics(): HapticsModule | null {
  if (cached !== undefined) return cached;
  try { cached = require('expo-haptics') as HapticsModule; } catch { cached = null; }
  return cached;
}

function fallback(ms: number): void {
  try { if (Platform.OS === 'android') Vibration.vibrate(ms); } catch { /* no vibrator: nothing to do */ }
}

/** A tiny tick for selections. */
export function hapticLight(): void {
  const h = haptics();
  if (!h) { fallback(8); return; }
  void h.impactAsync(h.ImpactFeedbackStyle.Light).catch(() => fallback(8));
}

/** Confirms a completed action (a saved split, a settled payment). */
export function hapticSuccess(): void {
  const h = haptics();
  if (!h) { fallback(15); return; }
  void h.notificationAsync(h.NotificationFeedbackType.Success).catch(() => fallback(15));
}
