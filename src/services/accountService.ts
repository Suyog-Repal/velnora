import { generateUUID } from '../db/repositories/syncQueueRepository.ts';
import { TransactionRepository } from '../db/repositories/transactionRepository.ts';
import { withWriteLock } from '../db/writeLock.ts';
import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';

/**
 * Accounts discovered from what messages actually state; no bank connection, and only a suffix is ever stored.
 * A profile exists only when a suffix is known. A bank without a suffix stays on the transaction alone (exact account
 * unknown), and a payment app is recorded as a payment app, never as a bank account.
 */
export interface AccountProfile {
  id: string; user_id: string | null; bank_name: string | null; last4: string | null; label: string | null;
  status: 'suggested' | 'confirmed'; merged_into: string | null; created_at: string; updated_at: string;
}
export interface AccountView extends AccountProfile { transactionCount: number; monthSpentPaise: number }

const scopeWhere = '(user_id = ? OR (user_id IS NULL AND ? IS NULL))';

async function findProfile(db: IDatabase, scope: Scope, bank: string | null, last4: string | null): Promise<AccountProfile | null> {
  return db.getFirstAsync<AccountProfile>(
    `SELECT * FROM account_profiles WHERE ${scopeWhere} AND COALESCE(bank_name, '') = ? AND COALESCE(last4, '') = ? ORDER BY merged_into IS NULL DESC LIMIT 1`,
    scope, scope, bank ?? '', last4 ?? '',
  );
}

/** Returns the identity to stamp on the transaction, following any merge the person already made. */
export async function recordAccountEvidence(db: IDatabase, scope: Scope, bankName: string | null, last4: string | null): Promise<{ bankName: string | null; last4: string | null }> {
  if (!last4) return { bankName, last4: null };
  return withWriteLock(async () => {
    let profile = await findProfile(db, scope, bankName, last4);
    for (let hops = 0; profile?.merged_into && hops < 5; hops += 1) {
      profile = await db.getFirstAsync<AccountProfile>('SELECT * FROM account_profiles WHERE id = ?', profile.merged_into);
    }
    if (profile) return { bankName: profile.bank_name, last4: profile.last4 };
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT OR IGNORE INTO account_profiles (id, user_id, bank_name, last4, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'suggested', ?, ?)`,
      generateUUID(), scope, bankName, last4, now, now,
    );
    return { bankName, last4 };
  });
}

export async function listAccounts(db: IDatabase, scope: Scope, now = new Date()): Promise<AccountView[]> {
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  const rows = await db.getAllAsync<AccountProfile>(`SELECT * FROM account_profiles WHERE merged_into IS NULL AND ${scopeWhere} ORDER BY status = 'confirmed' DESC, bank_name, last4`, scope, scope);
  const out: AccountView[] = [];
  for (const row of rows) {
    const stats = await db.getFirstAsync<{ n: number; spent: number | null }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN direction = 'expense' AND COALESCE(txn_kind, 'payment') != 'transfer' AND possible_duplicate_of IS NULL AND transaction_date >= ? AND transaction_date < ? THEN amount_paise ELSE 0 END) AS spent
       FROM transactions WHERE deleted_at IS NULL AND ${scopeWhere} AND COALESCE(bank_name, '') = ? AND COALESCE(account_last4, '') = ?`,
      start, end, scope, scope, row.bank_name ?? '', row.last4 ?? '',
    );
    out.push({ ...row, transactionCount: stats?.n ?? 0, monthSpentPaise: stats?.spent ?? 0 });
  }
  return out;
}

export async function createAccount(db: IDatabase, scope: Scope, input: { bankName: string; last4: string | null; label?: string }): Promise<void> {
  const bank = input.bankName.trim();
  const last4 = input.last4?.trim() || null;
  if (!bank || bank.length > 60) throw new Error('Enter the bank name.');
  if (last4 && !/^\d{3,4}$/.test(last4)) throw new Error('Enter only the last 3 or 4 digits.');
  await withWriteLock(async () => {
    const now = new Date().toISOString();
    const res = await db.runAsync(
      `INSERT OR IGNORE INTO account_profiles (id, user_id, bank_name, last4, label, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
      generateUUID(), scope, bank, last4, input.label?.trim() || null, now, now,
    );
    if (res.changes === 0) throw new Error('That account already exists.');
  });
}

export async function confirmAccount(db: IDatabase, scope: Scope, id: string, label?: string | null): Promise<void> {
  await withWriteLock(() => db.runAsync(
    `UPDATE account_profiles SET status = 'confirmed', label = COALESCE(?, label), updated_at = ? WHERE id = ? AND ${scopeWhere}`,
    label?.trim() || null, new Date().toISOString(), id, scope, scope,
  ));
}

/** Moves the source profile's transactions onto the target; future messages for it follow the merge. */
export async function mergeAccounts(db: IDatabase, scope: Scope, fromId: string, intoId: string): Promise<number> {
  if (fromId === intoId) throw new Error('Choose two different accounts.');
  const load = (id: string) => db.getFirstAsync<AccountProfile>(`SELECT * FROM account_profiles WHERE id = ? AND merged_into IS NULL AND ${scopeWhere}`, id, scope, scope);
  const [from, into] = [await load(fromId), await load(intoId)];
  if (!from || !into) throw new Error('Account not found.');
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM transactions WHERE deleted_at IS NULL AND ${scopeWhere} AND COALESCE(bank_name, '') = ? AND COALESCE(account_last4, '') = ?`,
    scope, scope, from.bank_name ?? '', from.last4 ?? '',
  );
  const repo = new TransactionRepository(db); // each update is queued for sync individually
  for (const row of rows) await repo.update(row.id, { bank_name: into.bank_name, account_last4: into.last4 });
  await withWriteLock(() => db.runAsync('UPDATE account_profiles SET merged_into = ?, updated_at = ? WHERE id = ?', intoId, new Date().toISOString(), fromId));
  return rows.length;
}
