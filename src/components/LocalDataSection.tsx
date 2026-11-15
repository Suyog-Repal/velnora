import { palette } from '../../theme';
import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { LocalDataDeletionController } from '../services/localDataController';
import { purgeStagedSmsForUser } from '../services/smsStagingService';

type Colors = { canvas: string; card: string; border: string; text: string; muted: string };

export function LocalDataSection({ userId, colors, onDeleted }: { userId: string; colors: Colors; onDeleted: () => void }) {
  const controller = useMemo(() => new LocalDataDeletionController(userId, { afterCommit: purgeStagedSmsForUser }), [userId]);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const open = controller.phase === 'confirming' || controller.phase === 'deleting';
  const unsynced = controller.summary?.unsyncedCount ?? 0;

  return <>
    <Pressable
      accessibilityRole="button"
      style={[styles.row, { borderBottomColor: colors.border }]}
      onPress={async () => { await controller.request(); rerender(); }}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: colors.text }]}>Delete local data</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>Remove this account's transactions from this device</Text>
      </View>
    </Pressable>
    {controller.phase === 'error' && <Text style={[styles.error, { color: palette.expenseText }]}>{controller.error}</Text>}
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => { controller.cancel(); rerender(); }}>
      <View style={styles.backdrop}><View style={[styles.dialog, { backgroundColor: colors.card }]}>
        <Text style={[styles.title, { color: colors.text }]}>Delete local data?</Text>
        <Text style={[styles.body, { color: colors.muted }]}>
          This permanently removes {controller.summary?.totalCount ?? 0} transaction(s) and their pending sync items for {' '}
          this account from this device. Other accounts and app settings are not affected. Signing out never does this.
        </Text>
        {unsynced > 0
          ? <Text style={[styles.warning, { color: palette.expenseText }]}>{unsynced} record(s) have NOT been backed up to the server. They may be unrecoverable after deletion.</Text>
          : <Text style={[styles.body, { color: colors.muted }]}>All records are backed up; they can be restored by syncing.</Text>}
        <View style={styles.actions}>
          <Pressable disabled={controller.phase === 'deleting'} onPress={() => { controller.cancel(); rerender(); }}>
            <Text style={[styles.btn, { color: colors.text }]}>Cancel</Text>
          </Pressable>
          <Pressable
            disabled={controller.phase === 'deleting'}
            onPress={async () => { const ok = await controller.confirm(); rerender(); if (ok) onDeleted(); }}
          >
            <Text style={[styles.btn, { color: palette.expenseText }]}>{controller.phase === 'deleting' ? 'Deleting…' : 'Delete'}</Text>
          </Pressable>
        </View>
      </View></View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingVertical: 14, borderBottomWidth: 1 },
  title: { fontSize: 15, fontWeight: '700' },
  caption: { fontSize: 12, marginTop: 2 },
  error: { marginTop: 6 }, // colour applied at render time (follows the theme)
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 },
  dialog: { borderRadius: 16, padding: 20, gap: 12 },
  body: { fontSize: 14, lineHeight: 20 },
  warning: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 24, marginTop: 8 },
  btn: { fontSize: 15, fontWeight: '700' },
});
