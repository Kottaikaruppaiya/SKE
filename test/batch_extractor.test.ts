import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractDocumentData, mergeExtractedDocuments } from '../server/extractor.ts';

test('Extracts real user commercial invoice PDF without missing critical fields', async () => {
  const filePath = path.join(process.cwd(), 'public/assets/aistudio/SKE-26-27-020-Invoice_12ae91b5.pdf');
  if (!fs.existsSync(filePath)) {
    return;
  }
  const buffer = fs.readFileSync(filePath);
  const result = await extractDocumentData(buffer, 'COMMERCIAL_INVOICE', 'SKE-26-27-020-Invoice.pdf');

  assert.equal(result.fields['invoiceNumber']?.value, 'SKE/26-27/020');
  assert.equal(result.fields['invoiceDate']?.value, '2026-04-06');
  assert.equal(result.fields['invoiceValueUsd']?.value, 24025.65);
  assert.equal(result.fields['packageCount']?.value, 88);
  assert.match(String(result.fields['consigneeName']?.value), /S K Global Ventures/i);
});

test('Extracts real user Shipping Bill PDF without missing critical fields', async () => {
  const filePath = path.join(process.cwd(), 'public/assets/aistudio/SKE-26-27-20-SHIPPING_BILL_f9ef4226.pdf');
  if (!fs.existsSync(filePath)) {
    return;
  }
  const buffer = fs.readFileSync(filePath);
  const result = await extractDocumentData(buffer, 'SHIPPING_BILL', 'SKE-26-27-20-SHIPPING BILL.pdf');

  assert.equal(result.fields['shippingBillNumber']?.value, '2173318');
  assert.equal(result.fields['shippingBillDate']?.value, '2026-04-07');
  assert.equal(result.fields['portCode']?.value, 'INMAA1');
  assert.equal(result.fields['sbExchangeRate']?.value, 92.1);
  assert.equal(result.fields['fobValueInr']?.value, 2212762.37);
  assert.equal(result.fields['dbkClaimed']?.value, 65291);
  assert.equal(result.fields['rodtepClaimed']?.value, 26254);
  assert.equal(result.fields['rosctlClaimed']?.value, 49195);
});

test('Extracts real user FIRC and BRC PDFs', async () => {
  const fircPath = path.join(process.cwd(), 'public/assets/aistudio/SKE-26-27-20-FIRC_8af61d5b.pdf');
  const brcPath = path.join(process.cwd(), 'public/assets/aistudio/BRC_Copy_4229e495.pdf');

  if (fs.existsSync(fircPath)) {
    const fircBuf = fs.readFileSync(fircPath);
    const fircRes = await extractDocumentData(fircBuf, 'FIRC_PAYMENT', 'SKE-26-27-20-FIRC.pdf');
    assert.equal(fircRes.fields['irmNumber']?.value, '210426I049900457');
    assert.equal(fircRes.fields['verifiedAmount']?.value, 24025.65);
    assert.equal(fircRes.fields['exchangeRate']?.value, 93.28);
    assert.equal(fircRes.fields['inrAmount']?.value, 2241112.63);
  }

  if (fs.existsSync(brcPath)) {
    const brcBuf = fs.readFileSync(brcPath);
    const brcRes = await extractDocumentData(brcBuf, 'BRC_COPY_1', 'BRC Copy.pdf');
    assert.equal(brcRes.fields['brcNumber']?.value, 'HDFC0000166A02685488');
    assert.equal(brcRes.fields['realisationDate']?.value, '2026-04-20');
    assert.equal(brcRes.fields['realisedAmount']?.value, 24025.65);
  }
});

test('mergeExtractedDocuments merges 5 real documents with zero data loss', async () => {
  const invPath = path.join(process.cwd(), 'public/assets/aistudio/SKE-26-27-020-Invoice_12ae91b5.pdf');
  const sbPath = path.join(process.cwd(), 'public/assets/aistudio/SKE-26-27-20-SHIPPING_BILL_f9ef4226.pdf');
  const blPath = path.join(process.cwd(), 'public/assets/aistudio/BL_SKE-26-27-20_697529d4.pdf');
  const fircPath = path.join(process.cwd(), 'public/assets/aistudio/SKE-26-27-20-FIRC_8af61d5b.pdf');
  const brcPath = path.join(process.cwd(), 'public/assets/aistudio/BRC_Copy_4229e495.pdf');

  if (!fs.existsSync(invPath) || !fs.existsSync(sbPath)) return;

  const docs = await Promise.all([
    extractDocumentData(fs.readFileSync(invPath), 'COMMERCIAL_INVOICE', 'Invoice.pdf'),
    extractDocumentData(fs.readFileSync(sbPath), 'SHIPPING_BILL', 'SB.pdf'),
    extractDocumentData(fs.readFileSync(blPath), 'BILL_OF_LADING', 'BL.pdf'),
    extractDocumentData(fs.readFileSync(fircPath), 'FIRC_PAYMENT', 'FIRC.pdf'),
    extractDocumentData(fs.readFileSync(brcPath), 'BRC_COPY_1', 'BRC.pdf'),
  ]);

  const merged = mergeExtractedDocuments(docs);
  assert.equal(merged.invoiceNumber, 'SKE/26-27/020');
  assert.equal(merged.shippingBillNumber, '2173318');
  assert.equal(merged.blNumber, '736116000605');
  assert.equal(merged.fircIrmNumber, '210426I049900457');
  assert.equal(merged.brcNumber, 'HDFC0000166A02685488');
  assert.equal(merged.invoiceValueUsd, 24025.65);
  assert.equal(merged.fobValueInr, 2212762.37);
});
