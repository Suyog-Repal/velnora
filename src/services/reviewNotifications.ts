import { MetadataRepository } from '../db/repositories/metadataRepository.ts';
import { withWriteLock } from '../db/writeLock.ts';
import type { IDatabase, TransactionEntity } from '../db/types.ts';
import type { Scope } from './categoryService.ts';
import { isGenericMerchant } from './duplicateMatcher.ts';
import { findAlias } from './merchantAliasService.ts';
import { evaluateCompleteness, type CompletenessContext, type ReviewField } from './transactionCompleteness.ts';

/**
 * Local "complete your transaction" notifications. `runReviewPass` is the single, idempotent place that decides what
 * should be showing; every trigger (new detection, edit, sync, app resume, background task) just calls it again.
 *
 * Identity is the transaction id: a row in review_notifications means that transaction has been announced, and the row
 * is claimed BEFORE posting, so another source, a replay or a retry can never announce it twice. Swiping a notification
 * away does not bring it back. Once a transaction is resolved its row is removed, so it could be announced again only
 * if it later needs review again.
 *
 * Notifications never affect the ledger. With permission off nothing is claimed, so the transaction waits in the in-app
 * queue and is still announced if permission is granted later.
 */
export interface ReviewNotification { transactionId: string; title: string; body: string }

export interface ReviewNotifierPort {
  canNotify(): boolean;
  post(notification: ReviewNotification): boolean;
  postSummary(count: number): boolean;
  cancel(transactionId: string): void;
  cancelSummary(): void;
}

export type ReviewNotificationPref = 'all' | 'duplicates' | 'off';
export const REVIEW_PREF_KEY = 'review_notifications_pref';

/** SMS and app notifications for one payment arrive seconds apart; wait so the second can complete or merge the first. */
export const REVIEW_SETTLE_MS = 15_000;
/** More than this at once (a backlog after permission returns, a busy day) becomes one summary, never a burst. */
export const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

let port: ReviewNotifierPort | null = null;
export function setReviewNotifierPort(next: ReviewNotifierPort | null): void { port = next; }

export async function getReviewPref(db: IDatabase): Promise<ReviewNotificationPref> {
  const value = await new MetadataRepository(db).get(REVIEW_PREF_KEY);
  return value === 'duplicates' || value === 'off' ? value : 'all';
}

export async function setReviewPref(db: IDatabase, pref: ReviewNotificationPref): Promise<void> {
  await new MetadataRepository(db).set(REVIEW_PREF_KEY, pref);
}

export function reviewPrefLabel(pref: ReviewNotificationPref): string {
  return pref === 'all' ? 'On · when a payment needs you' : pref === 'duplicates' ? 'Only possible duplicates' : 'Off · review inside the app';
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** A name for a preview: short, and never anything that looks like an account or reference number. */
function safeName(tx: Pick<TransactionEntity, 'counterparty'>): string | null {
  const name = tx.counterparty.trim();
  if (!name || isGenericMerchant(name) || /\d{5,}/.test(name)) return null;
  return name.length > 28 ? `${name.slice(0, 27).trim()}…` : name;
}

export function describeReview(tx: TransactionEntity, missing: ReviewField[]): { title: string; body: string } {
  const amount = rupees(tx.amount_paise);
  const name = safeName(tx);
  const detected = tx.direction === 'income' ? `${amount} received${name ? ` from ${name}` : ''}.` : `${amount} payment detected${name ? ` at ${name}` : ''}.`;
  if (missing.includes('duplicate')) return { title: 'Check possible duplicate transaction', body: `${amount} may have been recorded twice. Confirm whether it is one payment or two.` };
  if (missing.includes('merchant') && missing.includes('category')) return { title: 'Complete your transaction', body: `${detected} Add who it was for and a category.` };
  if (missing.includes('category')) return { title: 'Complete your transaction', body: `${detected} Add a category to complete your transaction.` };
  if (missing.includes('merchant')) return { title: 'Complete your transaction', body: `${detected} Add who it was for.` };
  if (missing.includes('account')) return { title: 'Confirm the payment account', body: `${detected} Choose the account it came from.` };
  if (missing.length) return { title: 'Complete missing transaction details', body: `${detected} Some details need checking.` };
  return { title: 'Transaction needs review', body: `${detected} Please check the details.` };
}

const scopeWhere = '(t.user_id = ? OR (t.user_id IS NULL AND ? IS NULL))';

export async function reviewContext(db: IDatabase, scope: Scope, merchant: string): Promise<CompletenessContext> {
  const accounts = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM account_profiles WHERE status = 'confirmed' AND merged_into IS NULL AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))`, scope, scope,
  );
  const alias = await findAlias(db, scope, merchant);
  return { confirmedAccounts: accounts?.n ?? 0, categoryConfirmed: !!alias?.category };
}

type ClaimRow = { transaction_id: string; state: 'posted' | 'summarized'; reason: string; status: string | null; deleted_at: string | null; present: number | null; user_id: string | null };

/** Removes what should no longer be showing, then announces what has become due. Safe to call at any time, any number of times. */
export async function runReviewPass(db: IDatabase, scope: Scope, options: { now?: number } = {}): Promise<void> {
  const notifier = port;
  if (!notifier) return;
  const now = options.now ?? Date.now();
  const pref = await getReviewPref(db);

  await withWriteLock(async () => {
    const claims = await db.getAllAsync<ClaimRow>(
      `SELECT r.transaction_id, r.state, r.reason, t.verification_status AS status, t.deleted_at, t.user_id, CASE WHEN t.id IS NULL THEN NULL ELSE 1 END AS present
       FROM review_notifications r LEFT JOIN transactions t ON t.id = r.transaction_id`,
    );
    let summarized = 0;
    for (const claim of claims) {
      const gone = claim.present === null || claim.deleted_at !== null || claim.status !== 'needs_review';
      const unwanted = pref === 'off' || (pref === 'duplicates' && !claim.reason.split(',').includes('duplicate'));
      if (!gone && !unwanted) { if (claim.state === 'summarized' && (claim.user_id ?? null) === scope) summarized += 1; continue; }
      if (claim.state === 'posted') notifier.cancel(claim.transaction_id);
      await db.runAsync('DELETE FROM review_notifications WHERE transaction_id = ?', claim.transaction_id);
    }
    if (summarized === 0) notifier.cancelSummary();

    if (pref === 'off' || !notifier.canNotify()) return;

    const settledBefore = new Date(now - REVIEW_SETTLE_MS).toISOString();
    const rows = await db.getAllAsync<TransactionEntity>(
      `SELECT t.* FROM transactions t
       WHERE t.deleted_at IS NULL AND t.verification_status = 'needs_review' AND t.capture_source IN ('sms', 'notification')
         AND ${scopeWhere} AND t.created_at <= ?
         AND NOT EXISTS (SELECT 1 FROM review_notifications r WHERE r.transaction_id = t.id)
       ORDER BY t.created_at DESC`,
      scope, scope, settledBefore,
    );
    const due: { tx: TransactionEntity; missing: ReviewField[] }[] = [];
    for (const tx of rows) {
      const { missing } = evaluateCompleteness(tx, await reviewContext(db, scope, tx.counterparty));
      if (pref === 'duplicates' && !missing.includes('duplicate')) continue;
      due.push({ tx, missing });
    }
    if (due.length === 0) return;

    const claim = (id: string, state: 'posted' | 'summarized', missing: ReviewField[]) => db.runAsync(
      'INSERT OR IGNORE INTO review_notifications (transaction_id, state, reason, notified_at) VALUES (?, ?, ?, ?)', id, state, missing.join(','), new Date(now).toISOString(),
    );
    if (due.length + summarized > MAX_INDIVIDUAL_NOTIFICATIONS) {
      for (const { tx, missing } of due) await claim(tx.id, 'summarized', missing);
      if (!notifier.postSummary(due.length + summarized)) {
        for (const { tx } of due) await db.runAsync('DELETE FROM review_notifications WHERE transaction_id = ?', tx.id);
      }
      return;
    }
    for (const { tx, missing } of due) {
      const claimed = await claim(tx.id, 'posted', missing);
      if (claimed.changes === 0) continue;
      const shown = notifier.post({ transactionId: tx.id, ...describeReview(tx, missing) });
      if (!shown) await db.runAsync('DELETE FROM review_notifications WHERE transaction_id = ?', tx.id);
    }
  });
}

/** Sign-out: this account's notifications must not stay on the device. */
export async function clearReviewNotifications(db: IDatabase, scope: Scope): Promise<void> {
  const notifier = port;
  if (!notifier) return;
  await withWriteLock(async () => {
    const claims = await db.getAllAsync<{ transaction_id: string; state: string }>(
      `SELECT r.transaction_id, r.state FROM review_notifications r JOIN transactions t ON t.id = r.transaction_id WHERE ${scopeWhere}`, scope, scope,
    );
    for (const claim of claims) {
      if (claim.state === 'posted') notifier.cancel(claim.transaction_id);
      await db.runAsync('DELETE FROM review_notifications WHERE transaction_id = ?', claim.transaction_id);
    }
    if (claims.length) notifier.cancelSummary();
  });
}

export function cancelReviewNotification(transactionId: string): void {
  port?.cancel(transactionId);
}
