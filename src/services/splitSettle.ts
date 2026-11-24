/**
 * Recording payments between the owner and a friend. A payment is never income or expense (it lives in `settlements`, outside v_spend).
 */
import type { IDatabase } from '../db/types.ts';
import type { Scope } from './categoryService.ts';
import { generateUUID } from '../db/repositories/syncQueueRepository.ts';
import { SELF, SplitError } from './splitMath.ts';
import { getContact, inTransaction, listGroups, loadLedger, type Settlement } from './splitService.ts';
import { allocateFriendPayment, buildFriendDetail } from './splitOverview.ts';

/**
 * The owner and a friend settle `amountPaise`. The amount is spread over the groups (and outside-group debts) it belongs to, one
 * settlement each, so the friend's balance and every group's balance shrink together and never disagree. All or nothing.
 * Paying more than is owed is allowed: the surplus is recorded outside groups and the balance flips.
 */
export async function settleWithFriend(
  db: IDatabase, scope: Scope, friendId: string, direction: 'they_pay' | 'i_pay', amountPaise: number, opts: { date?: string; note?: string | null } = {},
): Promise<Settlement[]> {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new SplitError('Enter an amount greater than zero.');
  if (!(await getContact(db, scope, friendId))) throw new SplitError('That person was not found.');
  const date = opts.date ?? new Date().toISOString();
  if (Number.isNaN(new Date(date).getTime())) throw new SplitError('Enter a valid date.');
  const [groups, ledger] = await Promise.all([listGroups(db, scope, { includeArchived: true }), loadLedger(db, scope)]);
  const parts = allocateFriendPayment(buildFriendDetail(friendId, groups, ledger).scopes, direction, amountPaise);
  const from = direction === 'they_pay' ? friendId : SELF; const to = direction === 'they_pay' ? SELF : friendId;
  const t = new Date().toISOString();
  const made: Settlement[] = parts.map((p) => ({ id: generateUUID(), user_id: scope, group_id: p.groupId, from_party: from, to_party: to, amount_paise: p.paise, settled_on: date, note: opts.note?.trim() || null, created_at: t }));
  await inTransaction(db, async () => {
    for (const s of made) {
      await db.runAsync(`INSERT INTO settlements (id, user_id, group_id, from_party, to_party, amount_paise, settled_on, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.id, scope, s.group_id, s.from_party, s.to_party, s.amount_paise, s.settled_on, s.note, s.created_at, s.created_at);
    }
  });
  return made;
}
