import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { CategoryIcon, Card, formatPaise, type Colors } from '../ui/common';
import { type } from '../../typography';
import { palette, radius, tint } from '../../theme';
import type { CategorySlice } from '../services/analyticsService';

const R = 80; const CX = 100; const CY = 100;
const pt = (angle: number, r: number) => [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];

function arc(start: number, end: number): string {
  const [x1, y1] = pt(start, R); const [x2, y2] = pt(end, R);
  const [x3, y3] = pt(end, R * 0.62); const [x4, y4] = pt(start, R * 0.62);
  const large = end - start > Math.PI ? 1 : 0;
  return `M${x1},${y1} A${R},${R} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${R * 0.62},${R * 0.62} 0 ${large} 0 ${x4},${y4} Z`;
}

export const pct = (tenths: number) => `${(tenths / 10).toFixed(1)}%`;

/**
 * Donut of expense per category plus a legend. Every legend row shows the category, its share, its amount and a bar
 * scaled to that share, so the chart is not the only carrier of the information. `icons` maps lower-case category name to icon.
 */
export function CategoryPieChart({ slices, total, selected, onSelect, colors, icons }: { slices: CategorySlice[]; total: number; selected: string | null; onSelect: (c: string | null) => void; colors: Colors; icons?: Map<string, string | null> }) {
  let angle = -Math.PI / 2;
  const sum = slices.reduce((s, x) => s + x.totalPaise, 0) || 1;
  return <Card colors={colors}>
    <View style={{ alignItems: 'center' }}>
      <Svg width={200} height={200} viewBox="0 0 200 200" accessibilityLabel={`Spending by category, total ${formatPaise(total)}`}>
        {slices.length === 1
          ? <G onPress={() => onSelect(selected === slices[0].category ? null : slices[0].category)}><Circle cx={CX} cy={CY} r={R * 0.81} stroke={slices[0].color} strokeWidth={R * 0.38} fill="none" /></G>
          : slices.map((s) => {
            const sweep = (s.totalPaise / sum) * Math.PI * 2; const start = angle; angle += sweep;
            return <Path key={s.category} d={arc(start, angle - 0.004)} fill={s.color} opacity={selected && selected !== s.category ? 0.3 : 1} onPress={() => onSelect(selected === s.category ? null : s.category)} />;
          })}
      </Svg>
      <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
        <Text style={{ ...type.caption, color: colors.muted }}>Total spent</Text>
        <Text style={{ ...type.amountMd, color: colors.text, maxWidth: 110 }} numberOfLines={1} adjustsFontSizeToFit>{formatPaise(total)}</Text>
      </View>
    </View>
    <View style={{ marginTop: 8 }}>
      {slices.map((s, i) => {
        const on = selected === s.category;
        return <Pressable key={s.category} onPress={() => onSelect(on ? null : s.category)} accessibilityRole="button" accessibilityState={{ selected: on }}
          accessibilityLabel={`${s.category}, ${pct(s.percentTenths)} of spending, ${formatPaise(s.totalPaise)}`}
          style={{ minHeight: 56, paddingVertical: 8, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: radius.md, backgroundColor: on ? tint(palette.emerald, 0.1) : 'transparent', borderTopWidth: i === 0 ? 0 : 1, borderTopColor: on ? 'transparent' : colors.border, opacity: selected && !on ? 0.55 : 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <CategoryIcon icon={icons?.get(s.category.toLowerCase())} label={s.category} color={s.color} size={32} />
            <Text style={{ ...type.bodyStrong, flex: 1, marginHorizontal: 10, color: colors.text }} numberOfLines={1}>{s.category}</Text>
            <View style={{ alignItems: 'flex-end', flexShrink: 0 }}>
              <Text style={{ ...type.amountSm, color: colors.text }} numberOfLines={1}>{formatPaise(s.totalPaise)}</Text>
              <Text style={{ ...type.caption, color: colors.muted, fontVariant: ['tabular-nums'] }}>{pct(s.percentTenths)}</Text>
            </View>
          </View>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: tint(s.color, 0.16), marginTop: 8, marginLeft: 42 }}>
            <View style={{ height: 4, borderRadius: 2, width: `${Math.max(2, Math.min(100, s.percentTenths / 10))}%`, backgroundColor: s.color }} />
          </View>
        </Pressable>;
      })}
    </View>
  </Card>;
}
