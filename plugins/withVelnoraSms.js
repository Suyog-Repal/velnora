const { AndroidConfig, createRunOncePlugin, withAndroidManifest } = require('expo/config-plugins');

const pkg = require('../package.json');
const RECEIVER_NAME = 'com.velnora.sms.VelnoraSmsReceiver';
const PATTERNS_METADATA_NAME = 'com.velnora.sms.SUPPORTED_SENDER_PATTERNS';
const RECEIVE_SMS = 'android.permission.RECEIVE_SMS';

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
    if (!manifest.manifest['uses-permission'].some((permission) => permission.$['android:name'] === RECEIVE_SMS)) {
      manifest.manifest['uses-permission'].push({ $: { 'android:name': RECEIVE_SMS } });
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
