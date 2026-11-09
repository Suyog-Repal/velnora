import type { IDatabase } from '../db/types.ts';
import { findAlias } from './merchantAliasService.ts';
import { displayName, type StatementRow } from './statementImport.ts';
import { suggestCategory } from './transactionClassifier.ts';

/**
 * Category for a statement row, with how sure we are. Order of trust:
 *  1. a category the person saved for this merchant (merchant alias, per account) -> 'user'
 *  2. what the row itself is (refund, own transfer, cash withdrawal) and the app's merchant rules -> 'high'
 *  3. recognisable bank-charge or interest wording -> 'medium'
 *  4. nothing recognised -> the app's default bucket, 'low'
 * Only the default bucket for an expense is flagged for review: "Other Income" is a real answer for money received.
 * Categories are the app's existing names; none are invented here.
 */
const FALLBACK = new Set(['Other Expenses', 'Other Income']);
const BANK_CHARGES = /\b(?:charges?|chgs?|fees?|gst|sms alert|annual fee|penalty|min(?:imum)? bal(?:ance)? chg)\b/i;
const INTEREST = /\b(?:interest|int\.?\s*(?:cr|credit|paid|pd))\b/i;

export function categorizeRow(row: StatementRow): Pick<StatementRow, 'category' | 'categoryConfidence' | 'needsReview'> {
  const category = suggestCategory({ merchant: row.narration, body: row.narration, direction: row.direction, kind: row.kind });
  if (!FALLBACK.has(category)) return { category, categoryConfidence: 'high', needsReview: false };
  if (row.direction === 'income') {
    return { category, categoryConfidence: INTEREST.test(row.narration) ? 'medium' : 'low', needsReview: false };
  }
  if (BANK_CHARGES.test(row.narration)) return { category, categoryConfidence: 'medium', needsReview: false };
  return { category, categoryConfidence: 'low', needsReview: true };
}

export async function categorizeRows(db: IDatabase, scope: string | null, rows: StatementRow[]): Promise<StatementRow[]> {
  const out: StatementRow[] = [];
  for (const row of rows) {
    const saved = (await findAlias(db, scope, displayName(row.narration))) ?? (await findAlias(db, scope, row.narration));
    out.push(saved?.category
      ? { ...row, category: saved.category, categoryConfidence: 'user', needsReview: false }
      : { ...row, ...categorizeRow(row) });
  }
  return out;
}
