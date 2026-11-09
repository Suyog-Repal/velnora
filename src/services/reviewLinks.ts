import type { IDatabase, TransactionEntity } from '../db/types.ts';
import type { Scope } from './categoryService.ts';

/**
 * Where a review notification leads. The link carries only a transaction id. Opening one reads the local ledger and
 * never creates anything.
 */
export type ReviewLink = { kind: 'queue' } | { kind: 'transaction'; id: string };

const PREFIX = 'velnora://review';

export function parseReviewLink(url: string | null | undefined): ReviewLink | null {
  if (!url || !url.startsWith(PREFIX)) return null;
  const rest = url.slice(PREFIX.length);
  if (rest === '' || rest === '/') return { kind: 'queue' };
  const id = /^\/([A-Za-z0-9-]{8,64})$/.exec(rest)?.[1];
  return id ? { kind: 'transaction', id } : null;
}

export type ReviewTarget = { status: 'needs_review' | 'resolved'; transaction: TransactionEntity } | { status: 'missing' };

/** Another account's transaction is reported as missing, so a link can never reveal it. */
export async function resolveReviewTarget(db: IDatabase, scope: Scope, id: string): Promise<ReviewTarget> {
  const tx = await db.getFirstAsync<TransactionEntity>('SELECT * FROM transactions WHERE id = ?', id);
  if (!tx || tx.deleted_at || (tx.user_id ?? null) !== scope) return { status: 'missing' };
  return { status: tx.verification_status === 'needs_review' ? 'needs_review' : 'resolved', transaction: tx };
}

/**
 * Holds a link until the app can act on it (a cold start delivers the link before the database and session are ready);
 * when the app is already running it is handled immediately. Only the newest waiting link matters.
 */
export function createReviewLinkRouter(handle: (link: ReviewLink) => void) {
  let ready = false;
  let waiting: ReviewLink | null = null;
  return {
    receive(url: string | null | undefined): void {
      const link = parseReviewLink(url);
      if (!link) return;
      if (ready) handle(link); else waiting = link;
    },
    setReady(next: boolean): void {
      ready = next;
      if (ready && waiting) { const link = waiting; waiting = null; handle(link); }
    },
  };
}
