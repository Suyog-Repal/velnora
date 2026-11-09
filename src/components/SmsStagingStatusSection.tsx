import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { isNotificationAccessGranted, isSmsDetectionAvailable, openNotificationAccessSettings } from '../../sms';
import { getStagingStore } from '../services/smsStagingService';
import { loadSmsStagingStatus, type SmsStagingStatus } from '../services/smsStagingStatus';

type Colors = { canvas: string; card: string; border: string; text: string; muted: string };

/** Counts-only SMS pipeline status. Re-reads whenever `refreshKey` or the user changes. */
export function SmsStagingStatusSection({ userId, colors, refreshKey }: { userId: string; colors: Colors; refreshKey: number }) {
  const [status, setStatus] = useState<SmsStagingStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [tcAccess, setTcAccess] = useState(false);

  // Notification access is granted in system Settings, so re-check whenever the app returns to the foreground.
  useEffect(() => {
    const check = () => setTcAccess(isNotificationAccessGranted());
    check();
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') check(); });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    let active = true;
    setStatus(null);
    setFailed(false);
    getStagingStore()
      .then((store) => loadSmsStagingStatus(store, userId))
      .then((next) => { if (active) setStatus(next); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [userId, refreshKey]);

  if (failed) return <Text style={[styles.caption, { color: colors.muted }]}>SMS status unavailable.</Text>;
  if (!status || !status.available) return null;

  return <View style={[styles.box, { borderBottomColor: colors.border }]}>
    <Text style={[styles.title, { color: colors.text }]}>Bank SMS processing</Text>
    {isSmsDetectionAvailable() && (tcAccess
      ? <Text style={[styles.caption, { color: colors.muted }]}>Truecaller alerts: on. A payment seen by both SMS and Truecaller is recorded once.</Text>
      : <Pressable onPress={() => openNotificationAccessSettings()}><Text style={[styles.caption, { color: colors.muted }]}>Truecaller alerts: off. Tap to allow Notification access for Velnora.</Text></Pressable>)}
    {status.isEmpty
      ? <Text style={[styles.caption, { color: colors.muted }]}>No SMS need attention.</Text>
      : <>
        {status.dead > 0 && <Text style={styles.warn}>{status.dead} SMS could not be processed after repeated attempts.</Text>}
        {status.heldForOtherAccounts > 0 && <Text style={[styles.caption, { color: colors.muted }]}>{status.heldForOtherAccounts} SMS held for another account on this device.</Text>}
        {status.ownerless > 0 && <Text style={[styles.caption, { color: colors.muted }]}>{status.ownerless} SMS held because they arrived before any sign-in.</Text>}
      </>}
  </View>;
}

const styles = StyleSheet.create({
  box: { paddingVertical: 14, borderBottomWidth: 1, gap: 4 },
  title: { fontSize: 15, fontWeight: '700' },
  caption: { fontSize: 12 },
  warn: { fontSize: 13, color: '#DC2626', fontWeight: '600' },
});
