/**
 * Bank SMS parsing across the formats Indian banks actually send. The message texts are representative of the
 * published alert styles of each bank (they are test fixtures, not captured customer messages; no real account data).
 */
import assert from 'node:assert/strict';
import { classifySmsStatus, cleanSenderLabel, parseSmsTransaction, DEFAULT_SMS_RULE } from '../../../transactionParser.ts';

const receivedAt = new Date(2026, 10, 12, 9, 30, 0).getTime(); // 12 Nov 2026, 09:30 local
const ymd = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

type Case = {
  name: string; sender: string; body: string;
  expect: { direction: 'income' | 'expense'; amount: number; merchant: string; ref?: string; date?: string; time?: string; acct?: string; balance?: number; method?: string };
};

const CASES: Case[] = [
  { name: 'HDFC UPI debit (no "debited" word, "Sent Rs")', sender: 'AX-HDFCBK-S',
    body: 'Sent Rs.250.00 From HDFC Bank A/C *1234 To ZOMATO On 12/11/26 Ref 412345678901 Not You? Call 18002586161 To Report',
    expect: { direction: 'expense', amount: 250, merchant: 'ZOMATO', ref: '412345678901', date: '2026-11-12', acct: '1234' } }, // text never says "UPI", so no method is claimed
  { name: 'HDFC credit with balance and UPI narration', sender: 'VM-HDFCBK-S',
    body: 'Update! INR 5,000.00 deposited in HDFC Bank A/c XX1234 on 12NOV26 for UPI-412345678901-RAHUL KUMAR-ICIC0001234. Avl bal INR 25,432.10. Cheque deposits in A/C are subject to clearing',
    expect: { direction: 'income', amount: 5000, merchant: 'RAHUL KUMAR', ref: '412345678901', date: '2026-11-12', acct: '1234', balance: 25432.1, method: 'UPI' } },
  { name: 'ICICI debit: "; MERCHANT credited" and UPI ref, no "at/to"', sender: 'JD-ICICIB-S',
    body: 'ICICI Bank Acct XX123 debited for Rs 500.00 on 12-Nov-26; ZOMATO credited. UPI:412345678901. Call 18002662 for dispute.',
    expect: { direction: 'expense', amount: 500, merchant: 'ZOMATO', ref: '412345678901', date: '2026-11-12', acct: '123', method: 'UPI' } },
  { name: 'ICICI credit "credited with ... from NAME"', sender: 'JD-ICICIB-S',
    body: 'Dear Customer, Acct XX123 is credited with Rs 1,500.00 on 12-Nov-26 from RAHUL SHARMA. UPI:412345678901-ICICI Bank.',
    expect: { direction: 'income', amount: 1500, merchant: 'RAHUL SHARMA', ref: '412345678901', date: '2026-11-12', acct: '123' } },
  { name: 'SBI debit without a currency symbol', sender: 'VK-SBIUPI-S',
    body: 'Dear UPI user A/C X1234 debited by 250.0 on date 12Nov26 trf to ZOMATO Refno 412345678901. If not u? call 1800111109. -SBI',
    expect: { direction: 'expense', amount: 250, merchant: 'ZOMATO', ref: '412345678901', date: '2026-11-12', acct: '1234' } },
  { name: 'SBI credit; balance must not be taken as the amount', sender: 'VK-SBIINB-S',
    body: 'Dear Customer, Your A/c XX1234 credited by Rs.5000.00 on 12Nov26 by transfer from RAHUL (UPI Ref no 412345678901). Avl Bal Rs.12345.67-SBI',
    expect: { direction: 'income', amount: 5000, merchant: 'RAHUL', ref: '412345678901', date: '2026-11-12', acct: '1234', balance: 12345.67 } },
  { name: 'Axis "Debit INR" pipe format with seconds and UPI path', sender: 'AD-AXISBK-S',
    body: 'Debit INR 1,234.00 | Axis Bank A/c XX1234 | 12-11-26 14:32:11 | UPI/P2M/412345678901/AMAZON Avl Bal INR 5,000.00',
    expect: { direction: 'expense', amount: 1234, merchant: 'AMAZON', ref: '412345678901', date: '2026-11-12', time: '14:32', acct: '1234', balance: 5000, method: 'UPI' } },
  { name: 'Kotak credit-card spend ("credit" must not flip direction)', sender: 'VM-KOTAKB-S',
    body: 'Rs.1,234.00 spent on your Kotak Credit Card XX1234 at AMAZON on 12-Nov-26. Avl limit Rs.50,000.00',
    expect: { direction: 'expense', amount: 1234, merchant: 'AMAZON', date: '2026-11-12', acct: '1234', method: 'Card' } },
  { name: 'ATM withdrawal (no merchant, no reference)', sender: 'AX-HDFCBK-S',
    body: 'Rs 5,000.00 withdrawn at ATM from A/c XX1234 on 12-Nov-26. Avl Bal Rs 20,000.00',
    expect: { direction: 'expense', amount: 5000, merchant: 'ATM withdrawal', date: '2026-11-12', acct: '1234', balance: 20000, method: 'Cash' } },
  { name: 'Salary via NEFT narration', sender: 'VM-SBIINB-S',
    body: 'INR 50,000.00 credited to your A/c XX1234 on 01-Nov-26 by NEFT-N123456789-ACME CORP LTD-SALARY. Avl Bal INR 60,000.00.',
    expect: { direction: 'income', amount: 50000, merchant: 'ACME CORP LTD', ref: 'N123456789', date: '2026-11-01', acct: '1234', balance: 60000, method: 'Net banking' } },
  { name: 'UPI to a phone-number VPA', sender: 'AX-HDFCBK-S',
    body: 'Rs.500 debited from A/c XX1234 on 12-11-26 to VPA 9876543210@ybl (UPI Ref No 412345678901)',
    expect: { direction: 'expense', amount: 500, merchant: '9876543210@ybl', ref: '412345678901', date: '2026-11-12', acct: '1234', method: 'UPI' } },
  { name: 'UPI to a named VPA', sender: 'AX-HDFCBK-S',
    body: 'Rs.150.00 debited from A/c XX1234 on 12-11-2026 to VPA swiggy@icici. UPI Ref 412345678901',
    expect: { direction: 'expense', amount: 150, merchant: 'swiggy', ref: '412345678901', date: '2026-11-12' } },
  { name: 'Debit alert with no reference at all', sender: 'BP-PNBSMS-S',
    body: 'A/c XX1234 debited INR 200.00 on 12-Nov-2026 at Local Shop. Avl Bal INR 1000.00',
    expect: { direction: 'expense', amount: 200, merchant: 'Local Shop', ref: '', date: '2026-11-12', acct: '1234', balance: 1000 } },
  { name: 'Refund credit', sender: 'AX-HDFCBK-S',
    body: 'Refund of Rs 300.00 credited to your A/c XX1234 on 12-Nov-26 from AMAZON.',
    expect: { direction: 'income', amount: 300, merchant: 'AMAZON', date: '2026-11-12', acct: '1234' } },
  { name: 'Credit that mentions "sent by" is still income (direction = earliest keyword)', sender: 'AX-HDFCBK-S',
    body: 'Rs 750.00 credited to A/c XX1234 on 12-Nov-26. Sent by NEHA via UPI. Ref 998877665544',
    expect: { direction: 'income', amount: 750, ref: '998877665544', merchant: 'NEHA', acct: '1234', method: 'UPI' } },
  { name: 'Account is not mistaken for the merchant', sender: 'AX-HDFCBK-S',
    body: 'Rs 800.00 debited from A/c XX1234 on 12-Nov-26 to ZEPTO. Ref 111222333444',
    expect: { direction: 'expense', amount: 800, merchant: 'ZEPTO', ref: '111222333444', acct: '1234' } },
  { name: 'Date with am/pm time', sender: 'AX-HDFCBK-S',
    body: 'Rs 99.00 debited at CHAI POINT on 12/11/2026 02:30 PM. Ref: AB1234567',
    expect: { direction: 'expense', amount: 99, merchant: 'CHAI POINT', ref: 'AB1234567', date: '2026-11-12', time: '14:30' } },
  { name: 'Date-only SMS dated earlier than it arrived keeps the SMS date', sender: 'AX-HDFCBK-S',
    body: 'Rs 60.00 debited at KIRANA on 09-Nov-26. Ref: ZX7788990',
    expect: { direction: 'expense', amount: 60, merchant: 'KIRANA', ref: 'ZX7788990', date: '2026-11-09' } },
  { name: 'Indian digit grouping', sender: 'AX-HDFCBK-S',
    body: 'Rs.1,23,456.78 credited to A/c XX1234 on 12-Nov-26 from ACME. Ref 5566778899',
    expect: { direction: 'income', amount: 123456.78, merchant: 'ACME', ref: '5566778899', date: '2026-11-12' } },
];

const failures: string[] = [];
for (const c of CASES) {
  const p = parseSmsTransaction({ sender: c.sender, receivedAt, partCount: 1, body: c.body });
  if (!p) { failures.push(`${c.name}: NOT PARSED`); continue; }
  const e = c.expect;
  const check = (label: string, got: unknown, want: unknown) => { if (want !== undefined && got !== want) failures.push(`${c.name}: ${label} got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
  check('direction', p.direction, e.direction);
  check('amount', p.amount, e.amount);
  check('merchant', p.merchant, e.merchant);
  check('reference', p.referenceId, e.ref);
  check('date', ymd(p.transactionDate), e.date);
  check('time', hm(p.transactionDate), e.time);
  check('account', p.accountLast4, e.acct);
  check('balance', p.balance, e.balance);
  check('payment method', p.paymentMethod, e.method);
}
assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
console.log(`✓ ${CASES.length} bank SMS formats parse correctly (amount, direction, merchant, reference, date, account, balance, method)`);

// ── things that must NOT become transactions ───────────────────────────────
const REJECT: [string, string, string][] = [
  ['OTP', 'AX-HDFCBK-S', 'Your OTP for NetBanking login is 849201. Do not share with anyone.'],
  ['card authorisation OTP', 'AX-HDFCBK-S', 'Use OTP 123456 to authorise your txn of Rs 500.00 at AMAZON. Do not share it.'],
  ['failed txn', 'AX-HDFCBK-S', 'Transaction of INR 500 failed. Ref: FAIL1234.'],
  ['declined card', 'AX-HDFCBK-S', 'Your card ending 1234 was declined for Rs 500.00 at STORE.'],
  ['pending txn', 'AX-HDFCBK-S', 'INR 500 pending at Fictional Shop. Ref: PEND1234.'],
  ['future auto-debit', 'AX-HDFCBK-S', 'Rs 999.00 will be debited from your A/c XX1234 on 05-Dec-26 for Netflix subscription.'],
  ['bill due reminder', 'AX-HDFCBK-S', 'Your credit card bill of Rs 5,000.00 is due on 20-Nov-26. Pay now to avoid charges.'],
  ['promotional offer', 'DM-PROMO', 'Flat 50% discount on shoes! Use coupon CODE50. Shop now.'],
  ['no amount', 'AX-HDFCBK-S', 'Your account was debited at Grocery Store. Ref: ABC12345.'],
  ['balance enquiry only', 'AX-HDFCBK-S', 'Your A/c XX1234 balance is Rs 12,000.00 as on 12-Nov-26.'],
  ['sender that is a phone number', '+919876543210', 'Rs 500 debited at SHOP'],
];
for (const [name, sender, body] of REJECT) {
  assert.equal(parseSmsTransaction({ sender, receivedAt, partCount: 1, body }), null, `must reject: ${name}`);
}
console.log(`✓ ${REJECT.length} non-transaction messages (OTP, failures, dues, promos, balance enquiries) are rejected`);

// ── dedupe fingerprints ─────────────────────────────────────────────────────
const fp = (sender: string, body: string, at = receivedAt) => parseSmsTransaction({ sender, receivedAt: at, partCount: 1, body })!.fingerprint;
const noRef = 'Rs 200.00 debited at LOCAL SHOP on 12-Nov-26 14:05. Avl Bal Rs 1,000.00';
assert.equal(fp('AX-HDFCBK-S', noRef), fp('VM-HDFCBK-S', noRef, receivedAt + 20_000), 'same alert via another sender route / seconds later = same fingerprint');
assert.notEqual(fp('AX-HDFCBK-S', noRef), fp('AX-HDFCBK-S', noRef.replace('1,000.00', '800.00')), 'a different balance is a different (second) purchase');
assert.notEqual(fp('AX-HDFCBK-S', noRef), fp('AX-HDFCBK-S', noRef.replace('Rs 200.00', 'Rs 250.00')), 'different amount');
const ambiguous = 'Rs 20.00 debited at TEA STALL on 12-Nov-26';   // no time, no reference, no balance: nothing tells two apart but arrival
assert.notEqual(fp('AX-HDFCBK-S', ambiguous), fp('AX-HDFCBK-S', ambiguous, receivedAt + 5 * 60_000), 'two identical bare alerts minutes apart are two purchases');
const dayLevel = 'Rs 20.00 debited at TEA STALL on 12-Nov-26. Avl Bal Rs 500.00';
assert.equal(fp('AX-HDFCBK-S', dayLevel), fp('VM-HDFCBK-S', dayLevel, receivedAt + 61_000), 'with a balance the SMS date is enough: a re-delivery across a minute boundary still collapses');
console.log('✓ fingerprints: same alert collapses, genuinely different purchases stay separate');

// ── helpers & rule compatibility ────────────────────────────────────────────
assert.equal(cleanSenderLabel('AX-HDFCBK-S'), 'HDFCBK');
assert.equal(cleanSenderLabel('HDFC-BANK'), 'HDFC-BANK');
assert.equal(classifySmsStatus('Unknown message about INR 500.'), 'ambiguous');
assert.equal(classifySmsStatus('Transaction of INR 500 failed. Ref: FAIL1234.'), 'failed');
const customRule = { ...DEFAULT_SMS_RULE, merchantPattern: 'shop:\\s*(\\w+)', successPatterns: ['done'], debitPatterns: ['done'] };
assert.equal(parseSmsTransaction({ sender: 'BANK-TEST', receivedAt, partCount: 1, body: 'Payment done INR 50 shop: ACME' }, [customRule])?.merchant, 'ACME', 'a rule with its own merchant pattern still wins');
console.log('✓ helpers and custom-rule compatibility');
