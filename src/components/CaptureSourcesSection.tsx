import { useState } from 'react';
import { palette } from '../../theme';
import { MessageSquare, WalletCards } from '../../icons';
import { canControlCaptureSources, getDisabledCaptureSources, setCaptureSourceEnabled } from '../../sms';
import { CAPTURE_EXPLANATION, resolveCaptureSources, type CaptureSourceId } from '../services/captureSources';
import type { Colors } from '../ui/common';
import { ActionRow, Group, InfoRow, SwitchRow } from '../ui/rows';
import { showToast } from '../ui/Toast';
import { useCapturePermissions } from '../ui/useCapturePermissions';
import { useSmsPermission } from '../ui/useSmsPermission';

/**
 * Settings > Automatic capture: what Velnora may read, one switch per source. The choice is saved and enforced natively, so
 * it holds while the app is closed. Android's own permission and notification access are separate and shown alongside.
 */
export function CaptureSourcesSection({ colors }: { colors: Colors }) {
  const sms = useSmsPermission();
  const capture = useCapturePermissions();
  const supported = canControlCaptureSources();
  const [sources, setSources] = useState(() => resolveCaptureSources(getDisabledCaptureSources()));

  const choose = (id: CaptureSourceId, enabled: boolean): boolean => {
    if (!setCaptureSourceEnabled(id, enabled)) { showToast('Could not save that choice. Try again.', 'warning', 'capture-source'); return false; }
    setSources(resolveCaptureSources(getDisabledCaptureSources()));
    return true;
  };
  const smsEnabled = sources.find((s) => s.id === 'sms')?.enabled ?? true;

  // An installed build without the switches: only Android's own two grants, as before.
  if (!supported) return <Group title="Automatic capture" colors={colors}>
    <SwitchRow icon={<MessageSquare size={18} color={palette.emerald} />} title="Bank SMS detection" subtitle={sms.available ? 'Read bank alerts on this phone' : 'Not available on this device'}
      value={sms.granted} disabled={!sms.available} colors={colors} onValueChange={(next) => { if (next) void sms.requestWithGuidance(true); else sms.openSettings(); }} />
    <SwitchRow icon={<WalletCards size={18} color={palette.emerald} />} title="Payment-app alerts" subtitle={capture.accessAvailable ? 'Pick up UPI app notifications' : 'Not available on this device'}
      value={capture.access} disabled={!capture.accessAvailable} colors={colors} onValueChange={() => { capture.openAccessSettings(); }} last />
  </Group>;

  const apps = sources.filter((s) => s.kind === 'notification');
  return <>
    <Group title="Automatic capture" colors={colors}>
      <SwitchRow icon={<MessageSquare size={18} color={palette.emerald} />} title="SMS from banks" subtitle="Read new bank SMS on this phone"
        value={smsEnabled && sms.granted} disabled={!sms.available} colors={colors}
        // Off stops Velnora reading SMS. Turning it on also asks Android for the permission when it is missing.
        onValueChange={(next) => { if (choose('sms', next) && next && !sms.granted) void sms.requestWithGuidance(true); }} />
      <InfoRow text={CAPTURE_EXPLANATION.sms} last colors={colors} />
    </Group>
    <Group title="Payment-app notifications" colors={colors}>
      <ActionRow icon={<WalletCards size={18} color={palette.emerald} />} title="Notification access" tone={capture.access ? undefined : 'warning'}
        subtitle={capture.access ? 'On for Velnora' : 'Off: the apps below cannot be read yet'} action="Open settings" onPress={() => { capture.openAccessSettings(); }} colors={colors} />
      {apps.map((s) => <SwitchRow key={s.id} title={s.label} value={s.enabled} onValueChange={(next) => { choose(s.id, next); }} colors={colors} />)}
      <InfoRow text={CAPTURE_EXPLANATION.notifications} colors={colors} />
      <InfoRow text={CAPTURE_EXPLANATION.off} colors={colors} />
      <InfoRow text={CAPTURE_EXPLANATION.truecaller} last colors={colors} />
    </Group>
  </>;
}
