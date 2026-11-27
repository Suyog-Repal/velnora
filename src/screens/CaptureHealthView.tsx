import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Share, Text, View } from 'react-native';
import { palette } from '../../theme';
import { FileText } from '../../icons';
import { getDisabledCaptureSources, openCaptureSettings, readCaptureHealth, requestListenerRebind } from '../../sms';
import {
  RESTRICTED_STEPS, STATUS_LABELS, buildHealthRows, buildQueueRows, manufacturerGuide, showRestrictedGuide,
  type CaptureHealthRaw, type QueueSummaryRaw, type SettingsPageId,
} from '../services/captureHealth';
import { REASON_LABELS, formatCaptureLog, originLabel, sanitizeLogRows, type CaptureLogRow } from '../services/captureLog';
import { resolveCaptureSources } from '../services/captureSources';
import { getStagingStore } from '../services/smsStagingService';
import { Button, Sheet, type Colors } from '../ui/common';
import { ActionRow, Group, InfoRow, NavRow } from '../ui/rows';
import { showToast } from '../ui/Toast';

const SHOWN_LOG_ROWS = 100;
const when = (at: number) => new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Profile > Capture health: why a payment might not be captured, with the Android page that fixes each reason. */
export function CaptureHealthSheet({ visible, onClose, scope, colors }: { visible: boolean; onClose: () => void; scope: string | null; colors: Colors }) {
  const [view, setView] = useState<'health' | 'log'>('health');
  const [health, setHealth] = useState<CaptureHealthRaw | null>(null);
  const [sources, setSources] = useState(() => resolveCaptureSources([]));
  const [queue, setQueue] = useState<QueueSummaryRaw | null>(null);
  const [log, setLog] = useState<CaptureLogRow[]>([]);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const refresh = useCallback(async () => {
    setHealth(readCaptureHealth());
    setSources(resolveCaptureSources(getDisabledCaptureSources()));
    try {
      const store = await getStagingStore();
      setQueue((await store?.queueSummary?.(scope)) ?? null);
      setLog(sanitizeLogRows((await store?.readCaptureLog?.()) ?? []));
      setError('');
    } catch { setError('Could not read the capture counts and log.'); }
  }, [scope]);

  // Every value is changed in Android's settings, so re-read whenever the person comes back.
  useEffect(() => {
    if (!visible) { setView('health'); return; }
    void refresh();
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') void refresh(); });
    return () => sub.remove();
  }, [visible, refresh]);

  const open = (page: SettingsPageId) => { if (!openCaptureSettings(page)) showToast('Open Android Settings, then Apps, then Velnora.', 'info', 'capture-settings'); };
  const reconnect = () => {
    if (!requestListenerRebind()) { showToast('Could not ask Android to reconnect.', 'warning', 'capture-rebind'); return; }
    showToast('Asked Android to reconnect', 'info', 'capture-rebind');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void refresh(); }, 1500);
  };
  const share = () => { void Share.share({ message: formatCaptureLog(log) }).catch(() => undefined); };
  const clear = () => Alert.alert('Clear the capture log?', 'Only the log is cleared. Messages waiting to be processed and your transactions stay.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Clear', style: 'destructive', onPress: () => { void getStagingStore().then((s) => s?.clearCaptureLog?.()).then(refresh).catch(() => setError('Could not clear the log.')); } },
  ]);

  const errorText = error ? <Text style={{ color: palette.expenseText, marginTop: 10 }} accessibilityLiveRegion="polite">{error}</Text> : null;
  const steps = (list: readonly string[]) => list.map((step, i) => <InfoRow key={step} text={`${i + 1}. ${step}`} colors={colors} />);

  if (view === 'log') return <Sheet visible={visible} onClose={onClose} title="Capture log" colors={colors}>
    <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>What happened to messages Velnora saw: times, sources and reasons only. No message text, amounts or names. Kept on this phone for 14 days, up to 500 entries.</Text>
    <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
      <View style={{ flex: 1 }}><Button title="Back" kind="ghost" onPress={() => setView('health')} /></View>
      <View style={{ flex: 1 }}><Button title="Share" onPress={share} disabled={!log.length} /></View>
      <View style={{ flex: 1 }}><Button title="Clear" kind="danger" onPress={clear} disabled={!log.length} /></View>
    </View>
    {errorText}
    {log.length === 0 ? <Text style={{ color: colors.muted, marginTop: 16 }}>Nothing logged yet.</Text> : <Group colors={colors}>
      {log.slice(0, SHOWN_LOG_ROWS).map((row, i) => <View key={`${row.at}-${i}`} style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: i === Math.min(log.length, SHOWN_LOG_ROWS) - 1 ? 0 : 1, borderBottomColor: colors.border }}>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 14 }}>{REASON_LABELS[row.reason]}{row.count > 1 ? ` (${row.count} times)` : ''}</Text>
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{when(row.at)} · {originLabel(row)} · {row.stage}, {row.result}</Text>
      </View>)}
    </Group>}
    {log.length > SHOWN_LOG_ROWS ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>Showing the newest {SHOWN_LOG_ROWS} of {log.length}. Share includes all of them.</Text> : null}
  </Sheet>;

  const guide = health ? manufacturerGuide(health.manufacturer, health.brand) : null;
  return <Sheet visible={visible} onClose={onClose} title="Capture health" colors={colors}>
    {!health ? <Text style={{ color: colors.muted }}>Capture health needs the latest version of the app on this phone.</Text> : <Group title="Status" colors={colors}>
      {buildHealthRows(health, sources, when).map((row, i, all) => <View key={row.id}>
        <ActionRow title={`${row.title}: ${STATUS_LABELS[row.status]}`} subtitle={row.detail} tone={row.status === 'attention' ? 'warning' : undefined}
          action="Settings" onPress={() => open(row.page)} last={i === all.length - 1 && !row.reconnect} colors={colors} />
        {row.reconnect ? <ActionRow title="Reconnect the listener" action="Reconnect" onPress={reconnect} last={i === all.length - 1} colors={colors} /> : null}
      </View>)}
    </Group>}

    {health && showRestrictedGuide(health) ? <Group title="If Android says Restricted setting" colors={colors}>
      {steps(RESTRICTED_STEPS)}
      <ActionRow title="Open App info" action="Open" onPress={() => open('app_info')} last colors={colors} />
    </Group> : null}

    {guide ? <Group title={`Keep it running: ${guide.title}`} colors={colors}>
      {steps(guide.steps)}
      <InfoRow text="Menu names differ between phone software versions." colors={colors} />
      <ActionRow title="Open App info" action="Open" onPress={() => open('app_info')} last colors={colors} />
    </Group> : null}

    {queue ? <Group title="Messages on this phone" colors={colors}>
      {buildQueueRows(queue, !!scope).map((row, i, all) => <ActionRow key={row.id} title={`${row.title}: ${row.count}`} subtitle={row.detail}
        tone={row.id !== 'waiting' && row.count > 0 ? 'warning' : undefined} action="Log" onPress={() => setView('log')} last={i === all.length - 1} colors={colors} />)}
    </Group> : null}

    <Group colors={colors}>
      <NavRow icon={<FileText size={18} color={palette.emerald} />} title="Capture log (advanced)" subtitle="What happened to each message, without its contents" onPress={() => setView('log')} last colors={colors} />
    </Group>
    {errorText}
  </Sheet>;
}
