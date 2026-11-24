/**
 * The owner's own payment details (UPI ID, name on the link, a saved QR picture). Treated like the rest of the financial data:
 * stored ONLY in this device's app_metadata, keyed by account (or guest), never queued, never synced, never logged.
 * The QR picture is copied into the app's private folder; only its local path is stored, and removing it deletes the file.
 */
import type { IDatabase } from '../db/types.ts';
import { MetadataRepository } from '../db/repositories/metadataRepository.ts';
import type { Scope } from './categoryService.ts';
import { SplitError } from './splitMath.ts';
import { cleanUpi } from './splitService.ts';

export interface PaymentDetails { upiId: string | null; displayName: string | null; qrPath: string | null }

const who = (scope: Scope) => scope ?? 'guest';
export const paymentKeys = (scope: Scope) => ({ upi: `payment_upi_${who(scope)}`, name: `payment_name_${who(scope)}`, qr: `payment_qr_${who(scope)}` });

/** The file side of a saved QR picture. Expo implements it in paymentExpo.ts; tests use a fake. */
export interface QrFilePort {
  /** Copies the picked image into private storage and returns the stored path. */
  importImage(sourceUri: string, scope: Scope): Promise<string>;
  remove(path: string): Promise<void>;
}

export async function getPaymentDetails(db: IDatabase, scope: Scope): Promise<PaymentDetails> {
  const m = new MetadataRepository(db); const k = paymentKeys(scope);
  return { upiId: (await m.get(k.upi)) || null, displayName: (await m.get(k.name)) || null, qrPath: (await m.get(k.qr)) || null };
}

/** Saves the UPI ID (validated, name@bank) and the optional name shown on the payment link. Empty values clear them. */
export async function savePaymentDetails(db: IDatabase, scope: Scope, input: { upiId: string; displayName: string }): Promise<PaymentDetails> {
  const upi = cleanUpi(input.upiId);
  const name = input.displayName.trim().replace(/\s+/g, ' ');
  if (name.length > 60) throw new SplitError('The name is too long (60 characters at most).');
  const m = new MetadataRepository(db); const k = paymentKeys(scope);
  if (upi) await m.set(k.upi, upi); else await m.delete(k.upi);
  if (name) await m.set(k.name, name); else await m.delete(k.name);
  return getPaymentDetails(db, scope);
}

/** Replaces the saved QR picture: the new file is stored first, then the old one deleted. */
export async function replacePaymentQr(db: IDatabase, scope: Scope, files: QrFilePort, sourceUri: string): Promise<string> {
  const m = new MetadataRepository(db); const k = paymentKeys(scope);
  const old = await m.get(k.qr);
  const path = await files.importImage(sourceUri, scope);
  await m.set(k.qr, path);
  if (old && old !== path) await files.remove(old).catch(() => undefined);
  return path;
}

/** Removing the QR deletes the file as well as the stored path. */
export async function removePaymentQr(db: IDatabase, scope: Scope, files: QrFilePort): Promise<void> {
  const m = new MetadataRepository(db); const k = paymentKeys(scope);
  const old = await m.get(k.qr);
  await m.delete(k.qr);
  if (old) await files.remove(old).catch(() => undefined);
}

/**
 * Signing in: the guest's UPI ID and name move to the account (unless the account already has its own). The saved QR picture stays with
 * the guest: it is a file with a single owner, so it is never shared between two scopes. Local only, nothing is queued.
 */
export async function claimGuestPaymentDetails(db: IDatabase, userId: string): Promise<void> {
  const m = new MetadataRepository(db); const g = paymentKeys(null); const u = paymentKeys(userId);
  for (const [from, to] of [[g.upi, u.upi], [g.name, u.name]] as const) {
    const v = await m.get(from);
    if (v && !(await m.get(to))) { await m.set(to, v); await m.delete(from); }
  }
}

/** Forgets every payment detail of this scope in the database (the picture file is removed by the caller, see removePaymentQr). */
export async function deletePaymentDetails(db: IDatabase, scope: Scope): Promise<void> {
  const k = paymentKeys(scope);
  await db.runAsync('DELETE FROM app_metadata WHERE key IN (?, ?, ?)', k.upi, k.name, k.qr);
}
