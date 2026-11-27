/**
 * Capture health: turns what Android reports into plain rows, counts and guidance. Pure (no React Native), unit-tested.
 */
import type { CaptureSourceState } from './captureSources.ts';

/** As returned by the native module. null = this Android version has no such setting, or it could not be read. */
export interface CaptureHealthRaw {
  smsPermission: boolean;
  notificationAccess: boolean;
  listenerConnected: boolean;
  listenerLastEventAt: number | null;
  ignoringBatteryOptimizations: boolean | null;
  backgroundRestricted: boolean | null;
  pauseIfUnusedExempt: boolean | null;
  installerPackage: string | null;
  sdkInt: number;
  manufacturer: string | null;
  brand: string | null;
}

export interface QueueSummaryRaw { pendingMine: number; pendingOwnerless: number; pendingOther: number; dead: number }

export type SettingsPageId = 'app_info' | 'notification_access' | 'battery';
/** off = not needed because the person switched the related sources off. */
export type HealthStatus = 'ok' | 'attention' | 'off' | 'unknown';
export type HealthRowId = 'sms_permission' | 'notification_access' | 'listener' | 'battery' | 'background' | 'unused';
export interface HealthRow { id: HealthRowId; title: string; status: HealthStatus; detail: string; page: SettingsPageId; /** Offer "Reconnect". */ reconnect?: boolean }

export const STATUS_LABELS: Record<HealthStatus, string> = { ok: 'OK', attention: 'Check', off: 'Off', unknown: 'Unknown' };

export function buildHealthRows(h: CaptureHealthRaw, sources: readonly CaptureSourceState[], formatTime: (at: number) => string): HealthRow[] {
  const smsOn = sources.some((s) => s.kind === 'sms' && s.enabled);
  const appsOn = sources.some((s) => s.kind === 'notification' && s.enabled);
  const lastEvent = h.listenerLastEventAt ? `Last notification from a listed app: ${formatTime(h.listenerLastEventAt)}.` : 'No notification from a listed app seen yet.';
  const known = (value: boolean | null, good: boolean): HealthStatus => (value === null ? 'unknown' : value === good ? 'ok' : 'attention');

  return [
    {
      id: 'sms_permission', title: 'SMS permission', page: 'app_info',
      status: !smsOn ? 'off' : h.smsPermission ? 'ok' : 'attention',
      detail: !smsOn ? 'SMS is switched off in Velnora.' : h.smsPermission ? 'Allowed.' : 'Not allowed, so bank SMS cannot be received.',
    },
    {
      id: 'notification_access', title: 'Notification access', page: 'notification_access',
      status: !appsOn ? 'off' : h.notificationAccess ? 'ok' : 'attention',
      detail: !appsOn ? 'All apps are switched off in Velnora.' : h.notificationAccess ? 'On.' : 'Off, so payment-app notifications cannot be seen.',
    },
    {
      id: 'listener', title: 'Notification listener', page: 'notification_access',
      status: !appsOn ? 'off' : h.notificationAccess && h.listenerConnected ? 'ok' : 'attention',
      detail: !appsOn ? 'Not needed while all apps are switched off.'
        : !h.notificationAccess ? `Waiting for notification access. ${lastEvent}`
          : h.listenerConnected ? `Connected. ${lastEvent}`
            : `Not connected. Tap Reconnect; if that does not help, turn access off and on again. ${lastEvent}`,
      reconnect: appsOn && h.notificationAccess && !h.listenerConnected,
    },
    {
      id: 'battery', title: 'Battery optimisation', page: 'battery', status: known(h.ignoringBatteryOptimizations, true),
      detail: h.ignoringBatteryOptimizations === null ? 'Could not be read.'
        : h.ignoringBatteryOptimizations ? 'Velnora is not battery-optimised.' : 'Velnora is optimised, so Android may delay capture. In the list, show all apps, pick Velnora and choose not to optimise.',
    },
    {
      id: 'background', title: 'Background restriction', page: 'app_info', status: known(h.backgroundRestricted, false),
      detail: h.backgroundRestricted === null ? 'Not reported by this phone.'
        : h.backgroundRestricted ? 'Android is restricting Velnora in the background. In App info, open Battery and allow background use.' : 'Not restricted.',
    },
    {
      id: 'unused', title: 'Pause app if unused', page: 'app_info', status: known(h.pauseIfUnusedExempt, true),
      detail: h.pauseIfUnusedExempt === null ? 'Not reported by this Android version.'
        : h.pauseIfUnusedExempt ? 'Off for Velnora.' : 'On: Android can remove permissions if you do not open Velnora for a few months. Turn it off in App info.',
    },
  ];
}

export interface QueueRow { id: 'waiting' | 'held' | 'ownerless' | 'dead'; title: string; count: number; detail: string }

export function buildQueueRows(raw: QueueSummaryRaw, signedIn: boolean): QueueRow[] {
  return [
    // As a guest, messages with no account are the guest's own: they are waiting, not stranded.
    { id: 'waiting', title: 'Waiting', count: signedIn ? raw.pendingMine : raw.pendingOwnerless, detail: 'Received and not processed yet. They are processed when Velnora is open.' },
    { id: 'held', title: 'Held for another account', count: raw.pendingOther, detail: 'Processed only when that account signs in.' },
    { id: 'ownerless', title: 'Without an account', count: signedIn ? raw.pendingOwnerless : 0, detail: 'Arrived while no account was set. Processed only without signing in.' },
    { id: 'dead', title: 'Could not be processed', count: raw.dead, detail: 'Gave up after repeated attempts.' },
  ];
}

const STORE_INSTALLERS: ReadonlySet<string> = new Set([
  'com.android.vending', 'com.amazon.venezia', 'com.sec.android.app.samsungapps', 'com.xiaomi.mipicks', 'com.xiaomi.market',
  'com.heytap.market', 'com.oppo.market', 'com.vivo.appstore', 'com.bbk.appstore', 'com.huawei.appmarket',
]);

export const isSideloaded = (installerPackage: string | null): boolean => !installerPackage || !STORE_INSTALLERS.has(installerPackage);

/** Restricted settings exist from Android 13 and affect apps installed from a downloaded APK. */
export function showRestrictedGuide(h: CaptureHealthRaw): boolean {
  return h.sdkInt >= 33 && isSideloaded(h.installerPackage) && (!h.smsPermission || !h.notificationAccess);
}

export const RESTRICTED_STEPS: readonly string[] = [
  'Try to turn the access on once. If Android says "Restricted setting", go back.',
  'Open Velnora\'s App info page.',
  'Tap the ⋮ menu at the top right and choose "Allow restricted settings".',
  'Turn the SMS permission or notification access on again.',
];

export interface MakerGuide { title: string; steps: string[] }

const GUIDES: { names: string[]; guide: MakerGuide }[] = [
  { names: ['xiaomi', 'redmi', 'poco'], guide: { title: 'Xiaomi, Redmi and POCO', steps: ['Settings, Apps, Manage apps, Velnora: turn on Autostart.', 'On the same page, open Battery saver and choose No restrictions.'] } },
  { names: ['oppo', 'realme'], guide: { title: 'Oppo and Realme', steps: ['Settings, Apps, App management, Velnora: allow Auto launch.', 'Under Battery usage, allow background activity.'] } },
  { names: ['vivo', 'iqoo'], guide: { title: 'Vivo and iQOO', steps: ['Settings, Apps, Permission management, Autostart: turn on Velnora.', 'Settings, Battery, Background power consumption: allow Velnora.'] } },
  { names: ['samsung'], guide: { title: 'Samsung', steps: ['Settings, Apps, Velnora, Battery: choose Unrestricted.', 'Settings, Battery, Background usage limits: remove Velnora from sleeping and deep sleeping apps.'] } },
];

export function manufacturerGuide(manufacturer: string | null, brand: string | null): MakerGuide | null {
  const names = [manufacturer, brand].map((v) => (v ?? '').trim().toLowerCase());
  return GUIDES.find((g) => g.names.some((n) => names.includes(n)))?.guide ?? null;
}
