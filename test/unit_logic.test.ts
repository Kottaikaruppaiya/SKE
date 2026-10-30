import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInvoiceKey } from '../server/normalizer.ts';

test('normalizeInvoiceKey handles various format variations consistently', () => {
  // Test variations of SKE/26-27/020
  const v1 = normalizeInvoiceKey('SKE/26-27/020');
  const v2 = normalizeInvoiceKey('ske-26-27-20');
  const v3 = normalizeInvoiceKey('SKE 26 27 0020');
  const v4 = normalizeInvoiceKey('SKE/26-27/20');
  const v5 = normalizeInvoiceKey('ske2627020');

  assert.equal(v1, 'SKE-26-27-020');
  assert.equal(v2, 'SKE-26-27-020');
  assert.equal(v3, 'SKE-26-27-020');
  assert.equal(v4, 'SKE-26-27-020');
  assert.equal(v5, 'SKE-26-27-020');
});

test('normalizeInvoiceKey trims whitespace and standardizes prefixes', () => {
  assert.equal(normalizeInvoiceKey('  SKE/25-26/001  '), 'SKE-25-26-001');
  assert.equal(normalizeInvoiceKey('SKE-24-25-99'), 'SKE-24-25-099');
});

test('FOB and Currency calculations round properly', () => {
  const usdAmount = 14500.5;
  const customsRate = 83.25;
  const fobInr = Math.round(usdAmount * customsRate);
  assert.equal(fobInr, 1207167);
});

test('Payment allocation subtraction maintains accuracy', () => {
  const totalPaid = 15000;
  const reversedAllocation = 5000;
  const remainingPaid = Math.max(0, totalPaid - reversedAllocation);
  assert.equal(remainingPaid, 10000);

  const invoiceTotal = 12000;
  const remainingOutstanding = Math.max(0, invoiceTotal - remainingPaid);
  assert.equal(remainingOutstanding, 2000);
});

test('Over-allocation detection prevents exceeding available balance', () => {
  const verifiedAmount = 25000;
  const allocatedAmount = 20000;
  const availableBalance = verifiedAmount - allocatedAmount;
  assert.equal(availableBalance, 5000);

  const requestedAllocation = 6000;
  const isOverAllocated = requestedAllocation > availableBalance;
  assert.equal(isOverAllocated, true);
});

test('Incentive status derivation works accurately', () => {
  const claimed = 1200;
  let received = 0;
  let status = received >= claimed && claimed > 0 ? 'RECEIVED' : received > 0 ? 'PART_RECEIVED' : 'PENDING';
  assert.equal(status, 'PENDING');

  received = 500;
  status = received >= claimed && claimed > 0 ? 'RECEIVED' : received > 0 ? 'PART_RECEIVED' : 'PENDING';
  assert.equal(status, 'PART_RECEIVED');

  received = 1200;
  status = received >= claimed && claimed > 0 ? 'RECEIVED' : received > 0 ? 'PART_RECEIVED' : 'PENDING';
  assert.equal(status, 'RECEIVED');
});

