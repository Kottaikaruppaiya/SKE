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
