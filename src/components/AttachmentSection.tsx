/**
 * The attachment area of the Add Transaction and Edit Transaction forms (the same component in both), and the read-only
 * attachment strip of Transaction Details.
 *
 * Exactly two ways to attach:
 *  - "Add photo": camera, or one or several gallery images / screenshots. No text is read from them.
 *  - "Fill in from receipt": the ReceiptScan review (camera / gallery / file -> on-device OCR -> editable review). The
 *    reviewed values go back into the form through `receipt.onApply`, and the original image is attached.
 * Receipt images are stored with attachment_type 'scan' (an existing value; no schema change) and labelled "Receipt".
 *
 * It edits a DRAFT: nothing is stored until the transaction is saved (see commitAttachmentChanges), and an existing
 * attachment is only removed when the person removes it explicitly.
 */
import { useCallback, useMemo, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { palette } from '../../theme';
import { Camera, Plus, ScanText, X } from '../../icons';
import type { Colors } from '../ui/common';
import { MAX_ATTACHMENTS, uploadStatusLabel, type AttachmentChanges, type DraftAttachment } from '../services/attachmentService';
import type { CategoryView } from '../services/categoryService';
import type { Session } from '../db/types';
import { ReceiptScan, type ReceiptFormValues, type ReceiptReviewResult } from '../screens/ReceiptScan';
import { AttachmentViewer } from './AttachmentViewer';

export interface AttachmentDraft { items: DraftAttachment[]; removed: DraftAttachment[] }
export const EMPTY_DRAFT: AttachmentDraft = { items: [], removed: [] };

/** What the form has to apply after the transaction itself was saved. */
export function draftChanges(d: AttachmentDraft): AttachmentChanges {
  return {
    added: d.items.filter((i) => i.source === 'new'),
    removedIds: d.removed.filter((i) => i.source === 'saved' && i.attachmentId).map((i) => i.attachmentId!),
    removeLegacy: d.removed.some((i) => i.source === 'legacy'),
  };
}
export const draftIsDirty = (d: AttachmentDraft) => d.removed.length > 0 || d.items.some((i) => i.source === 'new');
/** Receipt images use the existing 'scan' attachment type. */
export const kindLabel = (type: DraftAttachment['type']) => (type === 'scan' ? 'Receipt' : 'Photo');

export interface ReceiptHookup {
  session: Session | null; categories: CategoryView[];
  /** The form's current values: the review starts from them where the receipt shows nothing. */
  current: ReceiptFormValues;
  excludeId?: string;
  /** The reviewed values, to be put into the form. */
  onApply: (result: ReceiptReviewResult) => void;
}

let seq = 0;
const newKey = () => `new-${Date.now()}-${seq++}`;

export function AttachmentSection({ draft, onChange, colors, signedIn, loading, receipt, readOnly }: {
  draft: AttachmentDraft; onChange: (next: AttachmentDraft) => void; colors: Colors; signedIn: boolean; loading?: boolean;
  receipt?: ReceiptHookup;
  /** Transaction Details: thumbnails and viewer only, no adding or removing. */
  readOnly?: boolean;
}) {
  const [note, setNote] = useState('');
  const [reading, setReading] = useState(false);
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const items = draft.items;
  const remaining = MAX_ATTACHMENTS - items.length;

  const add = useCallback((more: DraftAttachment[]) => {
    if (!more.length) return;
    const room = MAX_ATTACHMENTS - draft.items.length;
    if (more.length > room) setNote(`Only ${MAX_ATTACHMENTS} attachments fit on one transaction; ${more.length - room} not added.`);
    onChange({ ...draft, items: [...draft.items, ...more.slice(0, Math.max(0, room))] });
  }, [draft, onChange]);

  const remove = useCallback((key: string) => {
    const item = draft.items.find((i) => i.key === key);
    if (!item) return;
    onChange({ items: draft.items.filter((i) => i.key !== key), removed: item.source === 'new' ? draft.removed : [...draft.removed, item] });
  }, [draft, onChange]);

  const confirmRemove = (item: DraftAttachment) => {
    const what = item.type === 'scan' ? 'receipt' : 'photo';
    Alert.alert(`Remove this ${what}?`, item.source === 'new'
      ? `The ${what} has not been saved yet and will not be attached.`
      : 'It is removed from this transaction when you save the changes.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => remove(item.key) },
    ]);
  };

  const fromCamera = async () => {
    setNote('');
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) { setNote('Camera access was not granted. You can allow it in Settings, or choose a photo from the gallery.'); return; }
      const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.92, exif: false });
      if (res.canceled || !res.assets[0]) return;
      const a = res.assets[0];
      add([{ key: newKey(), source: 'new', type: 'photo', uri: a.uri, width: a.width, height: a.height }]);
    } catch { setNote('The camera could not be opened. Try again, or choose a photo from the gallery.'); }
  };
  const fromGallery = async () => {
    setNote('');
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { setNote('Photo access was not granted. You can allow it in Settings, or take a photo instead.'); return; }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: Math.max(1, remaining), orderedSelection: true, quality: 1, exif: false,
      });
      if (res.canceled || !res.assets.length) return;
      add(res.assets.map((a) => ({ key: newKey(), source: 'new' as const, type: 'photo' as const, uri: a.uri, width: a.width, height: a.height })));
    } catch { setNote('The gallery could not be opened. Try again.'); }
  };
  const full = () => { setNote(`This transaction already has ${MAX_ATTACHMENTS} attachments. Remove one to add another.`); };
  const addPhoto = () => {
    if (remaining <= 0) { full(); return; }
    Alert.alert('Add photo', 'Take a new photo, or choose photos and screenshots you already have.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Choose from gallery', onPress: () => void fromGallery() },
      { text: 'Take photo', onPress: () => void fromCamera() },
    ], { cancelable: true });
  };
  const fillFromReceipt = () => {
    if (remaining <= 0) { full(); return; }
    setNote(''); setReading(true);
  };
  const applyReceipt = (r: ReceiptReviewResult) => {
    setReading(false);
    add([{ key: newKey(), source: 'new', type: 'scan', uri: r.imageUri, width: r.imageWidth, height: r.imageHeight }]);
    receipt?.onApply(r);
  };

  const viewerItems = useMemo(() => items.map((i) => ({ key: i.key, uri: i.uri, type: i.type, width: i.width, height: i.height })), [items]);

  if (readOnly && !items.length && !loading) return null;

  return <View style={{ marginTop: 18 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
      <Text style={[styles.label, { color: colors.muted }]}>{readOnly ? 'ATTACHMENTS' : 'ATTACHMENTS (OPTIONAL)'}</Text>
      {items.length ? <Text style={{ color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{readOnly ? items.length : `${items.length} / ${MAX_ATTACHMENTS}`}</Text> : null}
    </View>

    {!readOnly ? <View style={{ flexDirection: 'row', gap: 10 }}>
      <Pressable onPress={addPhoto} accessibilityRole="button" accessibilityLabel="Add photo" accessibilityHint="Take a photo or choose photos from the gallery"
        style={({ pressed }) => [styles.option, { borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.75 : 1 }]}>
        <Camera color={palette.emerald} size={20} />
        <View style={{ flex: 1 }}><Text style={[styles.optionTitle, { color: colors.text }]}>Add photo</Text><Text style={[styles.optionHint, { color: colors.muted }]}>Camera or gallery</Text></View>
      </Pressable>
      {receipt ? <Pressable onPress={fillFromReceipt} accessibilityRole="button" accessibilityLabel="Fill in from receipt" accessibilityHint="Reads a receipt image, lets you review the details, fills the form and attaches the image"
        style={({ pressed }) => [styles.option, { borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.75 : 1 }]}>
        <ScanText color={palette.emerald} size={20} />
        <View style={{ flex: 1 }}><Text style={[styles.optionTitle, { color: colors.text }]}>Fill in from receipt</Text><Text style={[styles.optionHint, { color: colors.muted }]}>Reads and attaches it</Text></View>
      </Pressable> : null}
    </View> : null}

    {items.length || loading ? <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: readOnly ? 0 : 12, paddingRight: 8, gap: 10 }}>
      {items.map((item, i) => {
        const status = item.source === 'saved' ? uploadStatusLabel(item.uploadStatus, signedIn) : null;
        return <View key={item.key} style={{ width: 76 }}>
          <Pressable onPress={() => setViewerAt(i)} accessibilityRole="imagebutton"
            accessibilityLabel={`${kindLabel(item.type)} ${i + 1} of ${items.length}${status ? `, ${status}` : ''}. Opens full screen.`}
            style={[styles.thumb, { borderColor: colors.border, backgroundColor: colors.card }]}>
            {item.uri ? <Image source={{ uri: item.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" resizeMethod="resize" />
              : <Text style={{ color: colors.muted, fontSize: 10, textAlign: 'center', padding: 4 }}>Loading…</Text>}
            <View style={[styles.kind, { backgroundColor: item.type === 'scan' ? palette.emerald : 'rgba(0,0,0,0.6)' }]}>
              <Text style={styles.kindText}>{kindLabel(item.type).toUpperCase()}</Text>
            </View>
            {item.source === 'saved' && item.uploadStatus && signedIn ? <View style={[styles.dot, { backgroundColor: item.uploadStatus === 'synced' ? '#4ADE80' : item.uploadStatus === 'failed' ? '#F87171' : '#F5C451' }]} /> : null}
          </Pressable>
          {!readOnly ? <Pressable onPress={() => confirmRemove(item)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove attachment ${i + 1}`} style={styles.remove}>
            <X color="#FFFFFF" size={12} strokeWidth={3} />
          </Pressable> : null}
        </View>;
      })}
      {loading ? <View style={[styles.thumb, { borderColor: colors.border, backgroundColor: colors.card, width: 76 }]}><Text style={{ color: colors.muted, fontSize: 10 }}>Loading…</Text></View> : null}
      {!readOnly && items.length && remaining > 0 ? <Pressable onPress={addPhoto} accessibilityRole="button" accessibilityLabel="Add more photos"
        style={[styles.thumb, styles.more, { borderColor: colors.border, width: 76 }]}><Plus color={colors.muted} size={22} /><Text style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>Add more</Text></Pressable> : null}
    </ScrollView> : null}

    {note ? <Text style={{ color: palette.expenseText, fontSize: 12.5, marginTop: 8 }} accessibilityLiveRegion="polite">{note}</Text> : null}
    {!readOnly && items.length ? <Text style={{ color: colors.muted, fontSize: 11.5, marginTop: 8 }}>
      {signedIn ? 'Kept on this device and backed up to your account automatically.' : 'Guest mode: attachments stay on this device.'}
    </Text> : null}

    {receipt && !readOnly ? <ReceiptScan visible={reading} session={receipt.session} categories={receipt.categories} colors={colors}
      current={receipt.current} excludeId={receipt.excludeId} onClose={() => setReading(false)} onApply={applyReceipt} /> : null}
    <AttachmentViewer visible={viewerAt !== null} items={viewerItems} initialIndex={viewerAt ?? 0} onClose={() => setViewerAt(null)}
      onDelete={readOnly ? undefined : (key) => { remove(key); }} />
  </View>;
}

const styles = StyleSheet.create({
  label: { fontSize: 12, fontWeight: '700', letterSpacing: 1.1 },
  option: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 14, borderWidth: 1 },
  optionTitle: { fontWeight: '700', fontSize: 14 },
  optionHint: { fontSize: 11.5, marginTop: 1 },
  thumb: { width: 76, height: 76, borderRadius: 12, borderWidth: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  more: { borderStyle: 'dashed' },
  kind: { position: 'absolute', left: 4, bottom: 4, paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 5 },
  kindText: { color: '#FFFFFF', fontSize: 8.5, fontWeight: '800', letterSpacing: 0.6 },
  dot: { position: 'absolute', right: 5, bottom: 6, width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: 'rgba(0,0,0,0.25)' },
  remove: { position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(20,20,20,0.85)', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#FFFFFF' },
});
