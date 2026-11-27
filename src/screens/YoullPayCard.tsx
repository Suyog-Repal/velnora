import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { palette, radius } from '../../theme';
import { Initial, formatPaise, type Colors } from '../ui/common';
import { getServiceDb } from '../services/transactionService';
import { listExpected, type ExpectedPayment } from '../services/expectedPaymentService';
import { payableCard, type PayableCard } from '../services/expectedPayables';

/**
 * Home: what you are expected to pay, styled like the Split dues card. Not shown when there is nothing to pay. It only opens
 * the Expected tab: there is no reminder or WhatsApp action for money you owe.
 */

/** Read once for Home, for one scope (signed-in user, or guest when null). Another scope's rows are never shown meanwhile. */
export function usePayables(scope: string | null, refreshKey: unknown): PayableCard | null {
  const [loaded, setLoaded] = useState<{ scope: string | null; items: ExpectedPayment[] } | null>(null);
  useEffect(() => {
    let live = true;
    void listExpected(getServiceDb(), scope).then((items) => { if (live) setLoaded({ scope, items }); }).catch(() => undefined);
    return () => { live = false; };
  }, [scope, refreshKey]);
  // Worked out on each render, so a date that passes turns "Due" into "Overdue" the next time Home draws.
  return loaded && loaded.scope === scope ? payableCard(loaded.items) : null;
}

export function YoullPayCard({ card, colors, onSeeAll, onOpen }: { card: PayableCard | null; colors: Colors; onSeeAll: () => void; onOpen: (id: string) => void }) {
  if (!card) return null;
  return <View style={{ marginTop: 16, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, padding: 14 }}>
    <Pressable onPress={onSeeAll} accessibilityRole="button" accessibilityLabel={`You'll pay. ${card.action} in Expected payments`} hitSlop={12}
      style={({ pressed }) => ({ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>You'll pay</Text>
      <Text style={{ color: palette.accentText, fontWeight: '700' }}>{card.action}</Text>
    </Pressable>
    {card.rows.map((r) => <Pressable key={r.id} onPress={() => onOpen(r.id)} accessibilityRole="button" accessibilityLabel={`You'll pay ${r.person} ${formatPaise(r.amountPaise)}. ${r.status}`}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingVertical: 4, opacity: pressed ? 0.7 : 1 })}>
      <Initial label={r.person} color={palette.emerald} size={30} />
      <View style={{ flex: 1, minWidth: 0, marginLeft: 10 }}>
        {/* The name gives way when it is long; the amount is always shown whole. */}
        <View style={{ flexDirection: 'row' }}>
          <Text numberOfLines={1} style={{ color: colors.text, flexShrink: 1 }}>You'll pay {r.person}</Text>
          <Text style={{ color: palette.expenseText, fontWeight: '700', marginLeft: 4, fontVariant: ['tabular-nums'] }}>{formatPaise(r.amountPaise)}</Text>
        </View>
        <Text style={{ color: r.overdue ? palette.expenseText : colors.muted, fontSize: 12, marginTop: 1 }}>{r.status}</Text>
      </View>
    </Pressable>)}
  </View>;
}
