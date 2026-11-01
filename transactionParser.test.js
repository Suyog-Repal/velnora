import assert from 'node:assert/strict';
import { classifySmsStatus, DEFAULT_SMS_RULE, parseSmsTransaction } from './transactionParser.ts';

const receivedAt = Date.parse('2026-11-01T10:00:00.000Z');

const success = parseSmsTransaction({
  sender: 'BANK-TEST',
  receivedAt,
  partCount: 1,
  body: 'Your account was debited INR 1,250.50 at Fictional Cafe on 01/11/2026 15:20. Ref: ABC123456.',
});
assert.equal(success?.status, 'success');
assert.equal(success?.direction, 'expense');
assert.equal(success?.amount, 1250.5);
assert.equal(success?.merchant, 'Fictional Cafe');
assert.equal(success?.referenceId, 'ABC123456');

assert.equal(classifySmsStatus('Transaction of INR 500 failed. Ref: FAIL1234.'), 'failed');
assert.equal(classifySmsStatus('INR 500 pending at Fictional Shop. Ref: PEND1234.'), 'pending');
assert.equal(classifySmsStatus('Unknown message about INR 500.'), 'ambiguous');
assert.equal(parseSmsTransaction({ sender: 'BANK-TEST', receivedAt, partCount: 1, body: 'Transaction of INR 500 failed. Ref: FAIL1234.' }), null);
assert.equal(parseSmsTransaction({ sender: 'BANK-TEST', receivedAt, partCount: 1, body: 'INR 500 pending at Fictional Shop. Ref: PEND1234.' }), null);
assert.equal(parseSmsTransaction({ sender: 'BANK-TEST', receivedAt, partCount: 1, body: 'Your account was debited INR 100 at Fictional Shop.' }), null);

const creditRule = { ...DEFAULT_SMS_RULE, successPatterns: ['received'], creditPatterns: ['received'] };
const credit = parseSmsTransaction({
  sender: 'BANK-TEST',
  receivedAt,
  partCount: 1,
  body: 'You received INR 900 from Fictional Person. Ref: CREDIT123.',
}, [creditRule]);
assert.equal(credit?.direction, 'income');
assert.equal(credit?.fingerprint, parseSmsTransaction({
  sender: 'BANK-TEST',
  receivedAt,
  partCount: 1,
  body: 'You received INR 900 from Fictional Person. Ref: CREDIT123.',
}, [creditRule])?.fingerprint);
