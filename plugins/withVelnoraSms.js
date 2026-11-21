const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

const pkg = require('../package.json');
const RECEIVER_NAME = 'com.velnora.sms.VelnoraSmsReceiver';
const PATTERNS_METADATA_NAME = 'com.velnora.sms.SUPPORTED_SENDER_PATTERNS';
const RECEIVE_SMS = 'android.permission.RECEIVE_SMS';
const POST_NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS';
// Keeps the CPU awake for the few seconds the background capture task runs. A normal permission: no prompt.
const WAKE_LOCK = 'android.permission.WAKE_LOCK';
const CAPTURE_SERVICE_NAME = 'com.velnora.sms.VelnoraCaptureService';
const REVIEW_ACTION_RECEIVER_NAME = 'com.velnora.sms.VelnoraReviewActionReceiver';
const REVIEW_ACTION_SERVICE_NAME = 'com.velnora.sms.VelnoraReviewActionService';
const LISTENER_NAME = 'com.velnora.sms.VelnoraNotificationListener';
// Re-arms the daily check-in alarm after a reboot. A normal permission: no prompt.
const RECEIVE_BOOT_COMPLETED = 'android.permission.RECEIVE_BOOT_COMPLETED';
const CHECKIN_RECEIVER_NAME = 'com.velnora.sms.VelnoraCheckInReceiver';
const CHECKIN_SERVICE_NAME = 'com.velnora.sms.VelnoraCheckInService';

function normalizePatterns(patterns) {
  if (!Array.isArray(patterns)) {
    throw new Error('withVelnoraSms: supportedSenderPatterns must be an array of strings');
  }
  return patterns.map((pattern) => {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('withVelnoraSms: supportedSenderPatterns must contain non-empty strings');
    }
    return pattern;
  });
}

function withVelnoraSms(config, { supportedSenderPatterns = [] } = {}) {
  const patterns = normalizePatterns(supportedSenderPatterns);

  return withAndroidManifest(config, (manifestConfig) => {
    const manifest = manifestConfig.modResults;
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

    manifest.manifest['uses-permission'] ??= [];
    for (const name of [RECEIVE_SMS, POST_NOTIFICATIONS, WAKE_LOCK, RECEIVE_BOOT_COMPLETED]) {
      if (!manifest.manifest['uses-permission'].some((permission) => permission.$['android:name'] === name)) {
        manifest.manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    }

    mainApplication.receiver ??= [];
    const existingReceiver = mainApplication.receiver.find(
      (receiver) => receiver.$['android:name'] === RECEIVER_NAME,
    );
    const receiver = existingReceiver ?? {
      $: {
        'android:name': RECEIVER_NAME,
        'android:exported': 'true',
        'android:permission': 'android.permission.BROADCAST_SMS',
      },
      'intent-filter': [],
    };
    receiver['intent-filter'] ??= [];
    const intentFilters = receiver['intent-filter'];
    if (!intentFilters.some((filter) =>
      filter.action?.some((action) => action.$['android:name'] === 'android.provider.Telephony.SMS_RECEIVED'),
    )) {
      intentFilters.push({
        action: [{ $: { 'android:name': 'android.provider.Telephony.SMS_RECEIVED' } }],
      });
    }
    if (!existingReceiver) {
      mainApplication.receiver.push(receiver);
    }

    // Truecaller / payment-app notification source: bound by the system once the user grants Notification access (no activity needed).
    mainApplication.service ??= [];
    if (!mainApplication.service.some((service) => service.$['android:name'] === LISTENER_NAME)) {
      mainApplication.service.push({
        $: {
          'android:name': LISTENER_NAME,
          'android:exported': 'true',
          'android:label': 'Velnora bank alerts',
          'android:permission': 'android.permission.BIND_NOTIFICATION_LISTENER_SERVICE',
        },
        'intent-filter': [{ action: [{ $: { 'android:name': 'android.service.notification.NotificationListenerService' } }] }],
      });
    }

    if (!mainApplication.service.some((service) => service.$['android:name'] === CAPTURE_SERVICE_NAME)) {
      mainApplication.service.push({ $: { 'android:name': CAPTURE_SERVICE_NAME, 'android:exported': 'false' } });
    }

    // Notification category buttons: only Velnora's own PendingIntents reach these, hence not exported.
    if (!mainApplication.receiver.some((item) => item.$['android:name'] === REVIEW_ACTION_RECEIVER_NAME)) {
      mainApplication.receiver.push({ $: { 'android:name': REVIEW_ACTION_RECEIVER_NAME, 'android:exported': 'false' } });
    }
    if (!mainApplication.service.some((service) => service.$['android:name'] === REVIEW_ACTION_SERVICE_NAME)) {
      mainApplication.service.push({ $: { 'android:name': REVIEW_ACTION_SERVICE_NAME, 'android:exported': 'false' } });
    }

    // Daily check-in. The alarm and the notification button are Velnora's own PendingIntents; the system broadcasts that
    // re-arm the schedule (boot, app update, clock and timezone changes) are the only outside actions it listens for.
    if (!mainApplication.receiver.some((item) => item.$['android:name'] === CHECKIN_RECEIVER_NAME)) {
      mainApplication.receiver.push({
        $: { 'android:name': CHECKIN_RECEIVER_NAME, 'android:exported': 'false' },
        'intent-filter': [{
          action: [
            { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
            { $: { 'android:name': 'android.intent.action.MY_PACKAGE_REPLACED' } },
            { $: { 'android:name': 'android.intent.action.TIMEZONE_CHANGED' } },
            { $: { 'android:name': 'android.intent.action.TIME_SET' } },
          ],
        }],
      });
    }
    if (!mainApplication.service.some((service) => service.$['android:name'] === CHECKIN_SERVICE_NAME)) {
      mainApplication.service.push({ $: { 'android:name': CHECKIN_SERVICE_NAME, 'android:exported': 'false' } });
    }

    mainApplication['meta-data'] ??= [];
    const metadata = mainApplication['meta-data'];
    const existingPatterns = metadata.find((item) => item.$['android:name'] === PATTERNS_METADATA_NAME);
    const patternsValue = JSON.stringify(patterns);
    if (existingPatterns) {
      existingPatterns.$['android:value'] = patternsValue;
    } else {
      metadata.push({
        $: {
          'android:name': PATTERNS_METADATA_NAME,
          'android:value': patternsValue,
        },
      });
    }

    return manifestConfig;
  });
}

module.exports = createRunOncePlugin(withVelnoraSms, pkg.name, pkg.version);
