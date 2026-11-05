import { normalizeMerchantKey } from './merchantAliasService.ts';
import type { TransactionEntity } from '../db/types.ts';

export interface PersonAggregate {
  key: string; name: string;
  incomingPaise: number; outgoingPaise: number; incomingCount: number; outgoingCount: number;
  count: number; netPaise: number; lastAt: string;
}

export interface Totals { incomingPaise: number; outgoingPaise: number; incomingCount: number; outgoingCount: number; count: number; netPaise: number }

const live = (t: TransactionEntity) => !t.deleted_at && t.amount_paise > 0;

/** Sum/count of incoming and outgoing money for any set of transactions (integer paise). */
export function totalsOf(transactions: TransactionEntity[]): Totals {
  const t: Totals = { incomingPaise: 0, outgoingPaise: 0, incomingCount: 0, outgoingCount: 0, count: 0, netPaise: 0 };
  for (const x of transactions) {
    if (!live(x)) continue;
    t.count += 1;
    if (x.direction === 'income') { t.incomingPaise += x.amount_paise; t.incomingCount += 1; } else { t.outgoingPaise += x.amount_paise; t.outgoingCount += 1; }
  }
  t.netPaise = t.incomingPaise - t.outgoingPaise;
  return t;
}

/** Groups by exact normalized name (same conservative identity as merchant aliases). Display name = most frequent spelling. */
export function aggregatePeople(transactions: TransactionEntity[]): PersonAggregate[] {
  const map = new Map<string, { names: Map<string, number>; txs: TransactionEntity[] }>();
  for (const x of transactions) {
    if (!live(x)) continue;
    const key = normalizeMerchantKey(x.counterparty);
    if (!key) continue;
    const g = map.get(key) ?? { names: new Map<string, number>(), txs: [] as TransactionEntity[] };
    g.names.set(x.counterparty.trim(), (g.names.get(x.counterparty.trim()) ?? 0) + 1);
    g.txs.push(x);
    map.set(key, g);
  }
  const out: PersonAggregate[] = [];
  for (const [key, g] of map) {
    const t = totalsOf(g.txs);
    const name = [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.push({ key, name, ...t, lastAt: g.txs.reduce((m, x) => (x.transaction_date > m ? x.transaction_date : m), '') });
  }
  return out.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
}

export function personTransactions(transactions: TransactionEntity[], key: string): TransactionEntity[] {
  return transactions.filter((x) => live(x) && normalizeMerchantKey(x.counterparty) === key).sort((a, b) => b.transaction_date.localeCompare(a.transaction_date));
}
