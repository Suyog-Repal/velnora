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
export interface SplitDues { rows: FriendRow[]; totals: { owed: number; owe: number } }
const NO_DUES: SplitDues = { rows: [], totals: { owed: 0, owe: 0 } };

/** Open split balances for Home (read once, shared by the dues card and the "owed back" caption under Expenses). */
export function useSplitDues(scope: string | null, refreshKey: unknown): SplitDues {
  const [dues, setDues] = useState<SplitDues>(NO_DUES);
  useEffect(() => {
    let live = true;
    void loadOverview(getServiceDb(), scope).then(({ overview }) => {
      if (!live) return;
      setDues({ rows: overview.friends.filter((f) => f.balancePaise !== 0), totals: { owed: overview.owedToMePaise, owe: overview.iOwePaise } });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [scope, refreshKey]);
  return dues;
}

export function SplitDuesCard({ dues, colors, onOpen }: { dues: SplitDues; colors: Colors; onOpen: () => void }) {
  const { rows, totals } = dues;
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
