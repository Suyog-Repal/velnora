/**
 * Expo implementations for payment details: the private folder for the saved QR picture, sharing a QR image, copying text, opening links.
 * Nothing here talks to the network, and nothing here is logged.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Linking, Share } from 'react-native';
import type { Scope } from './categoryService.ts';
import type { QrFilePort } from './paymentDetails.ts';

const DIR = `${FileSystem.documentDirectory ?? ''}payment/`;
const extOf = (uri: string) => {
  const m = /\.(jpe?g|png|webp)(?:$|\?)/i.exec(uri)?.[1]?.toLowerCase();
  return m === 'jpeg' ? 'jpg' : m ?? 'jpg';
};

/** The saved QR picture lives in the app's private document folder (survives restarts, not readable by other apps). */
export const expoQrFiles: QrFilePort = {
  async importImage(sourceUri: string, scope: Scope) {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => undefined);
    const dest = `${DIR}qr-${scope ?? 'guest'}-${Date.now()}.${extOf(sourceUri)}`;
    await FileSystem.copyAsync({ from: sourceUri, to: dest });
    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists || !info.size) {
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined);
      throw new Error('That image could not be read. Try another one.');
    }
    return dest;
  },
  async remove(path: string) { await FileSystem.deleteAsync(path, { idempotent: true }); },
};

/** After "Delete local data": removes every saved QR picture of this account from the device. */
export async function purgePaymentFiles(scope: string): Promise<void> {
  try {
    const names = await FileSystem.readDirectoryAsync(DIR);
    await Promise.all(names.filter((n) => n.startsWith(`qr-${scope}-`)).map((n) => FileSystem.deleteAsync(`${DIR}${n}`, { idempotent: true })));
  } catch { /* the folder does not exist: nothing to remove */ }
}

/** Shares a generated QR (PNG as base64) through the system share sheet. The temporary file is removed on the next share. */
export async function shareQrPng(base64: string): Promise<void> {
  const dir = FileSystem.cacheDirectory ?? '';
  const old = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
  await Promise.all(old.filter((n) => n.startsWith('velnora-qr-')).map((n) => FileSystem.deleteAsync(`${dir}${n}`, { idempotent: true }).catch(() => undefined)));
  const uri = `${dir}velnora-qr-${Date.now()}.png`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  await shareImageFile(uri, 'image/png');
}

/** Shares an image file (the owner's own uploaded QR). */
export async function shareImageFile(uri: string, mimeType: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device.');
  await Sharing.shareAsync(uri, { mimeType, dialogTitle: 'Share QR' });
}

/** Copies text. expo-clipboard is a native module, so an older build lacks it: returns false and the caller offers the share sheet. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const Clipboard = require('expo-clipboard') as { setStringAsync(t: string): Promise<boolean> };
    await Clipboard.setStringAsync(text);
    return true;
  } catch { return false; }
}

export const shareText = (message: string) => Share.share({ message });
export const openLink = (url: string) => Linking.openURL(url);
