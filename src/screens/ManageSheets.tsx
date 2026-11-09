import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { palette } from '../../theme';
import { Button, CategoryIcon, Chip, EmptyBlock, Input, Labeled, Sheet, type Colors } from '../ui/common';
import { CATEGORY_COLORS, CATEGORY_ICONS, countCategoryUsage, createCategory, deleteCategory, listCategories, updateCategory, type CategoryView } from '../services/categoryService';
import { listAliases, removeAlias, type MerchantAlias } from '../services/merchantAliasService';
import { getServiceDb } from '../services/transactionService';

export function CategoryManager({ visible, scope, colors, onClose, onChanged }: { visible: boolean; scope: string | null; colors: Colors; onClose: () => void; onChanged: () => void }) {
  const [cats, setCats] = useState<CategoryView[]>([]);
  const [form, setForm] = useState<{ id?: string; name: string; type: 'income' | 'expense'; icon: string; color: string } | null>(null);
  const [error, setError] = useState('');
  const [moveFrom, setMoveFrom] = useState<{ cat: CategoryView; count: number } | null>(null);

  const load = useCallback(async () => setCats(await listCategories(getServiceDb(), scope)), [scope]);
  useEffect(() => { if (visible) void load(); }, [visible, load]);

  const save = async () => {
    if (!form) return;
    setError('');
    try {
      const db = getServiceDb();
      if (form.id) await updateCategory(db, scope, form.id, { name: form.name, icon: form.icon, color: form.color });
      else await createCategory(db, scope, { name: form.name, type: form.type, icon: form.icon, color: form.color });
      setForm(null); await load(); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the category.'); }
  };
  const askDelete = async (cat: CategoryView) => {
    const count = await countCategoryUsage(getServiceDb(), scope, cat.name);
    if (count > 0) { setMoveFrom({ cat, count }); return; }
    Alert.alert(`Delete "${cat.name}"?`, 'No transactions use it.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { void deleteCategory(getServiceDb(), scope, cat.id).then(async () => { await load(); onChanged(); }); } }]);
  };

  return <>
    <Sheet visible={visible} onClose={onClose} title="Categories" colors={colors}>
      {(['expense', 'income'] as const).map((type) => <View key={type}>
        <Text style={{ color: colors.muted, fontWeight: '600', fontSize: 12, marginVertical: 8 }}>{type === 'expense' ? 'EXPENSE' : 'INCOME'}</Text>
        {cats.filter((c) => c.type === type).map((c) => <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}>
          <CategoryIcon icon={c.icon} color={c.color} label={c.name} size={36} />
          <Text style={{ flex: 1, color: colors.text, marginLeft: 12, fontWeight: '600' }}>{c.name}</Text>
          {c.isCustom ? <><Text onPress={() => { setError(''); setForm({ id: c.id, name: c.name, type: c.type, icon: c.icon, color: c.color }); }} style={{ color: palette.accentText, fontWeight: '700', marginRight: 16 }}>Edit</Text>
            <Text onPress={() => void askDelete(c)} style={{ color: palette.expenseText, fontWeight: '700' }}>Delete</Text></> : <Text style={{ color: colors.muted, fontSize: 12 }}>Default</Text>}
        </View>)}
      </View>)}
      <Button title="New category" onPress={() => { setError(''); setForm({ name: '', type: 'expense', icon: 'Tag', color: CATEGORY_COLORS[0] }); }} />
    </Sheet>

    <Sheet visible={form !== null} onClose={() => setForm(null)} title={form?.id ? 'Edit category' : 'New category'} colors={colors}>
      <Labeled label="NAME" colors={colors}><Input colors={colors} value={form?.name ?? ''} onChangeText={(t) => form && setForm({ ...form, name: t })} placeholder="e.g. Pets" maxLength={40} /></Labeled>
      {!form?.id ? <Labeled label="TYPE" colors={colors}><View style={{ flexDirection: 'row' }}>
        <Chip label="Expense" active={form?.type === 'expense'} onPress={() => form && setForm({ ...form, type: 'expense' })} colors={colors} />
        <Chip label="Income" active={form?.type === 'income'} onPress={() => form && setForm({ ...form, type: 'income' })} colors={colors} /></View></Labeled> : null}
      <Labeled label="ICON" colors={colors}><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{CATEGORY_ICONS.map((ic) =>
        <Pressable key={ic} onPress={() => form && setForm({ ...form, icon: ic })} accessibilityRole="button" accessibilityLabel={ic} style={{ borderWidth: 2, borderColor: form?.icon === ic ? palette.emerald : 'transparent', borderRadius: 24 }}>
          <CategoryIcon icon={ic} color={form?.color ?? palette.navy} label={ic} size={40} /></Pressable>)}</View></Labeled>
      <Labeled label="COLOR" colors={colors}><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{CATEGORY_COLORS.map((c) =>
        <Pressable key={c} onPress={() => form && setForm({ ...form, color: c })} accessibilityRole="button" accessibilityLabel={`Color ${c}`} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c, borderWidth: 3, borderColor: form?.color === c ? colors.text : 'transparent' }} />)}</View></Labeled>
      {error ? <Text style={{ color: palette.expenseText, marginBottom: 8 }}>{error}</Text> : null}
      <Button title="Save category" onPress={() => void save()} />
    </Sheet>

    <Sheet visible={moveFrom !== null} onClose={() => setMoveFrom(null)} title="Move transactions first" colors={colors}>
      <Text style={{ color: colors.muted, marginBottom: 12 }}>{moveFrom?.count} transaction{moveFrom?.count === 1 ? ' uses' : 's use'} "{moveFrom?.cat.name}". Choose a category to move them to; your history is kept. Budgets for this category are removed.</Text>
      {cats.filter((c) => c.type === moveFrom?.cat.type && c.id !== moveFrom?.cat.id).map((c) => <Pressable key={c.id} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }} accessibilityRole="button"
        onPress={() => { const from = moveFrom!.cat; void deleteCategory(getServiceDb(), scope, from.id, c.id).then(async () => { setMoveFrom(null); await load(); onChanged(); }).catch((e) => Alert.alert('Could not delete', e instanceof Error ? e.message : '')); }}>
        <CategoryIcon icon={c.icon} color={c.color} label={c.name} size={36} /><Text style={{ color: colors.text, marginLeft: 12, fontWeight: '600' }}>Move to {c.name}</Text></Pressable>)}
    </Sheet>
  </>;
}

export function MerchantNamesManager({ visible, userId, colors, onClose }: { visible: boolean; userId: string | null; colors: Colors; onClose: () => void }) {
  const [rows, setRows] = useState<MerchantAlias[]>([]);
  const load = useCallback(async () => setRows(userId ? await listAliases(getServiceDb(), userId) : []), [userId]);
  useEffect(() => { if (visible) void load(); }, [visible, load]);
  return <Sheet visible={visible} onClose={onClose} title="Saved merchant names" colors={colors}>
    {!userId ? <EmptyBlock title="Sign in to use this" text="Merchant names are remembered per account. Create an account to teach Velnora your corrections." colors={colors} />
      : rows.length === 0 ? <EmptyBlock title="Nothing remembered yet" text="When you rename a merchant or change its category, you can choose to remember it for future transactions." colors={colors} />
      : rows.map((r) => <View key={r.id} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={{ color: colors.text, fontWeight: '700' }}>{r.original_text} → {r.display_name}</Text>
        <Text style={{ color: colors.muted, fontSize: 12 }}>{r.category ? `Category: ${r.category}` : 'No category saved'}</Text>
        <Text onPress={() => { void removeAlias(getServiceDb(), userId, r.id).then(load); }} style={{ color: palette.expenseText, fontWeight: '700', marginTop: 4 }}>Remove</Text>
      </View>)}
  </Sheet>;
}
