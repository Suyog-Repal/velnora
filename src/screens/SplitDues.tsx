import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { palette, radius } from '../../theme';
import { Initial, formatPaise, type Colors } from '../ui/common';
import { getServiceDb } from '../services/transactionService';
import { loadOverview, type FriendRow } from '../services/splitOverview';

/**
 * Home: who owes you (and whom you owe) from split expenses, as plain sentences ("Rohan owes you Rs 450"). It is not shown at all when
 * nothing is open, so Home stays quiet for people who do not split. Tapping it opens the People tab.
 */
export function SplitDuesCard({ scope, colors, refreshKey, onOpen }: { scope: string | null; colors: Colors; refreshKey: unknown; onOpen: () => void }) {
  const [rows, setRows] = useState<FriendRow[]>([]);
  const [totals, setTotals] = useState({ owed: 0, owe: 0 });
  useEffect(() => {
    let live = true;
    void loadOverview(getServiceDb(), scope).then(({ overview }) => {
      if (!live) return;
      setRows(overview.friends.filter((f) => f.balancePaise !== 0));
      setTotals({ owed: overview.owedToMePaise, owe: overview.iOwePaise });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [scope, refreshKey]);
  if (rows.length === 0) return null;
  const shown = rows.slice(0, 3);
  return <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel="Split dues. Open People" style={({ pressed }) => ({ marginTop: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 14, opacity: pressed ? 0.85 : 1 })}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>Split dues</Text>
      <Text style={{ color: palette.accentText, fontWeight: '700' }}>{rows.length > 3 ? `See all ${rows.length}` : 'Open'}</Text>
    </View>
    {shown.map((r) => <View key={r.contact.id} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}>
      <Initial label={r.label} color={palette.emerald} size={30} />
      <Text numberOfLines={1} style={{ color: colors.text, flex: 1, marginLeft: 10 }}>
        {r.balancePaise > 0 ? `${r.label} owes you ` : `You owe ${r.label} `}
        <Text style={{ fontWeight: '700', color: r.balancePaise > 0 ? palette.accentText : palette.expenseText }}>{formatPaise(Math.abs(r.balancePaise))}</Text>
      </Text>
    </View>)}
    {totals.owed > 0 && totals.owe > 0 ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>{formatPaise(totals.owed)} owed to you · {formatPaise(totals.owe)} you owe</Text> : null}
  </Pressable>;
}
