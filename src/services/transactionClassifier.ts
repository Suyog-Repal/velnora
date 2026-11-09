/**
 * Suggests a category from what the message says. A saved merchant correction always wins over this (see
 * ingestDetectedTransaction), and every suggestion can be changed on the transaction.
 * Names are the app's default categories, so the suggestion appears in the normal pickers.
 */
export type KindForCategory = 'payment' | 'refund' | 'reversal' | 'transfer' | 'cash_withdrawal';

const EXPENSE_RULES: [RegExp, string][] = [
  [/\b(?:swiggy|zomato|domino|pizza|kfc|mcdonald|burger|restaurant|cafe|starbucks|chai|bakery|eatclub|dine)\b/i, 'Food & Dining'],
  [/\b(?:blinkit|zepto|bigbasket|big basket|dmart|grofers|jiomart|instamart|grocery|groceries|kirana|supermarket)\b/i, 'Groceries'],
  [/\b(?:uber|ola|rapido|metro|irctc rail|petrol|fuel|hpcl|bpcl|iocl|indian oil|fastag|parking)\b/i, 'Transportation'],
  [/\b(?:electricity|bescom|msedcl|tata power|broadband|jio|airtel|vodafone|vi recharge|recharge|gas bill|water bill|postpaid|dth|bill ?desk|billdesk)\b/i, 'Bills & Utilities'],
  [/\b(?:amazon|flipkart|myntra|ajio|meesho|nykaa|croma|reliance digital|decathlon)\b/i, 'Shopping'],
  [/\b(?:pharmacy|apollo|medplus|netmeds|1mg|pharmeasy|hospital|clinic|diagnostic|dental)\b/i, 'Health'],
  [/\b(?:school|college|university|tuition|coursera|udemy|byju|unacademy|exam fee)\b/i, 'Education'],
  [/\b(?:netflix|hotstar|spotify|prime video|bookmyshow|pvr|inox|youtube premium|sonyliv)\b/i, 'Entertainment'],
  [/\b(?:makemytrip|goibibo|cleartrip|indigo|air india|vistara|spicejet|oyo|airbnb|redbus|irctc)\b/i, 'Travel'],
  [/\brent\b/i, 'Rent'],
];

export function suggestCategory(input: { merchant: string; body: string; direction: 'income' | 'expense'; kind: KindForCategory }): string {
  if (input.kind === 'refund' || input.kind === 'reversal') return 'Refund';
  if (input.kind === 'transfer') return 'Transfer';
  if (input.kind === 'cash_withdrawal') return 'Cash Withdrawal';
  if (input.direction === 'income') return /\b(?:salary|sal for|payroll|stipend)\b/i.test(input.body) ? 'Salary' : 'Other Income';
  // The merchant name is the strong signal; the body can mention unrelated words, so it is only consulted for it.
  for (const [pattern, category] of EXPENSE_RULES) if (pattern.test(input.merchant)) return category;
  return 'Other Expenses';
}
