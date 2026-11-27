/**
 * The sources a person can switch on or off. Pure (no React Native). The ids and the allow-list mirror
 * VelnoraCaptureRules.kt, and a test keeps them identical. The choice itself is stored and enforced natively.
 */
export const CAPTURE_SOURCES = [
  { id: 'sms', label: 'SMS from banks', kind: 'sms' },
  { id: 'com.google.android.apps.nbu.paisa.user', label: 'Google Pay', kind: 'notification' },
  { id: 'com.phonepe.app', label: 'PhonePe', kind: 'notification' },
  { id: 'net.one97.paytm', label: 'Paytm', kind: 'notification' },
  { id: 'in.org.npci.upiapp', label: 'BHIM', kind: 'notification' },
  { id: 'com.dreamplug.androidapp', label: 'CRED', kind: 'notification' },
  { id: 'com.truecaller', label: 'Truecaller', kind: 'notification' },
] as const;

export type CaptureSourceId = typeof CAPTURE_SOURCES[number]['id'];
export interface CaptureSourceState { id: CaptureSourceId; label: string; kind: 'sms' | 'notification'; enabled: boolean }

/**
 * Turns the stored list of switched-off ids into the state of every switch. Only an explicit, known id turns a source off, so
 * an install from before the switches existed (nothing stored) keeps everything on, as does anything unreadable.
 */
export function resolveCaptureSources(disabled: unknown): CaptureSourceState[] {
  const off = new Set(Array.isArray(disabled) ? disabled.filter((x): x is string => typeof x === 'string') : []);
  return CAPTURE_SOURCES.map((s) => ({ id: s.id, label: s.label, kind: s.kind, enabled: !off.has(s.id) }));
}

export const CAPTURE_EXPLANATION = {
  sms: 'SMS: Velnora receives each new message, skips senders written as a +phone number, discards one-time passwords, and checks the rest for a payment. It does not read your inbox.',
  notifications: 'Notifications: Android grants notification access for all apps at once. Velnora applies this list itself. It reads only the apps switched on here, and ignores every other app without reading or storing its notification.',
  off: 'A source that is switched off is dropped as soon as it arrives. Nothing about it is saved. Transactions you already have stay.',
  truecaller: 'Truecaller can show the same bank SMS, so switch it off too if you want no bank messages read. A payment seen by both is recorded once.',
} as const;
