import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { Card, formatPaise, type Colors } from '../ui/common';
import { type } from '../../typography';
import type { CategorySlice } from '../services/analyticsService';

const R = 80; const CX = 100; const CY = 100;
const pt = (angle: number, r: number) => [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];

function arc(start: number, end: number): string {
  const [x1, y1] = pt(start, R); const [x2, y2] = pt(end, R);
  const [x3, y3] = pt(end, R * 0.55); const [x4, y4] = pt(start, R * 0.55);
  const large = end - start > Math.PI ? 1 : 0;
  return `M${x1},${y1} A${R},${R} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${R * 0.55},${R * 0.55} 0 ${large} 0 ${x4},${y4} Z`;
}

export const pct = (tenths: number) => `${(tenths / 10).toFixed(1)}%`;

export function CategoryPieChart({ slices, total, selected, onSelect, colors }: { slices: CategorySlice[]; total: number; selected: string | null; onSelect: (c: string | null) => void; colors: Colors }) {
  let angle = -Math.PI / 2;
  const sum = slices.reduce((s, x) => s + x.totalPaise, 0) || 1;
  return <Card colors={colors}>
    <View style={{ alignItems: 'center' }}>
      <Svg width={220} height={220} viewBox="0 0 200 200" accessibilityLabel="Spending by category">
        {slices.length === 1
          ? <G onPress={() => onSelect(slices[0].category)}><Circle cx={CX} cy={CY} r={R * 0.775} stroke={slices[0].color} strokeWidth={R * 0.45} fill="none" /></G>
          : slices.map((s) => {
            const sweep = (s.totalPaise / sum) * Math.PI * 2; const start = angle; angle += sweep;
            return <Path key={s.category} d={arc(start, angle - 0.004)} fill={s.color} opacity={selected && selected !== s.category ? 0.35 : 1} onPress={() => onSelect(selected === s.category ? null : s.category)} />;
          })}
      </Svg>
      <View style={{ position: 'absolute', top: 88, alignItems: 'center' }} pointerEvents="none"><Text style={{ ...type.caption, color: colors.muted }}>Total spent</Text><Text style={{ ...type.amountSm, color: colors.text }}>{formatPaise(total)}</Text></View>
    </View>
    <View style={{ marginTop: 12 }}>
      {slices.map((s) => <Pressable key={s.category} onPress={() => onSelect(selected === s.category ? null : s.category)} accessibilityRole="button"
        style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingVertical: 8, opacity: selected && selected !== s.category ? 0.5 : 1 }}>
        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: s.color, marginRight: 10 }} />
        <Text style={{ ...type.body, flex: 1, color: colors.text, fontWeight: '500' }} numberOfLines={1}>{s.category}</Text>
        <Text style={{ ...type.caption, color: colors.muted, marginRight: 12, fontVariant: ['tabular-nums'] }}>{pct(s.percentTenths)}</Text>
        <Text style={{ ...type.amountSm, color: colors.text }}>{formatPaise(s.totalPaise)}</Text>
      </Pressable>)}
    </View>
  </Card>;
}
