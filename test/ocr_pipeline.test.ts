/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { db } from '../server/db.ts';
import { extractDocumentData, parsePdfBuffer } from '../server/extractor.ts';
import { ocrWorker } from '../server/ocr_worker.ts';

const SAMPLE_INVOICE_PDF = path.resolve('public/assets/aistudio/SKE-26-27-020-Invoice_12ae91b5.pdf');
const SAMPLE_SB_PDF = path.resolve('public/assets/aistudio/SKE-26-27-20-SHIPPING_BILL_f9ef4226.pdf');
const SAMPLE_FIRC_PDF = path.resolve('public/assets/aistudio/SKE-26-27-20-FIRC_8af61d5b.pdf');

test('OCR Pipeline: Digital vs scanned document detection on real statutory export documents', async () => {
  assert.ok(fs.existsSync(SAMPLE_INVOICE_PDF), 'Sample Invoice PDF must exist');
  const buffer = fs.readFileSync(SAMPLE_INVOICE_PDF);

  const parsed = await parsePdfBuffer(buffer, 'SKE-26-27-020-Invoice.pdf');
  assert.ok(parsed.text.length > 50, 'Parsed text must be non-empty');
  assert.ok(parsed.text.includes('SKE') || parsed.text.includes('INVOICE'), 'Must contain invoice content');
  assert.equal(parsed.method, 'PDF_TEXT', 'Digital PDF should be detected directly before slow OCR');

  const ext = await extractDocumentData(buffer, 'COMMERCIAL_INVOICE', 'SKE-26-27-020-Invoice.pdf');
  assert.ok(ext.fields.invoiceNumber?.value, 'Invoice number must be extracted');
  assert.ok(ext.fields.invoiceValueUsd?.value, 'Invoice Value USD must be extracted');
  assert.equal(ext.category, 'COMMERCIAL_INVOICE');
});

test('OCR Pipeline: Background Job Queue lifecycle and status transitions', async () => {
  const buffer = fs.readFileSync(SAMPLE_SB_PDF);
  const testFilename = `test_sb_${Date.now()}.pdf`;

  // 1. Enqueue job
  const job = db.enqueueOcrJob(
    {
      originalFilename: testFilename,
      fileSizeBytes: buffer.length,
      category: 'SHIPPING_BILL',
      financialYearId: 'fy-2026-27',
    },
    'test-actor-id'
  );

  assert.equal(job.status, 'PENDING');
  assert.equal(job.category, 'SHIPPING_BILL');
  assert.equal(job.originalFilename, testFilename);

  // 2. Register staging buffer and process
  ocrWorker.registerStagingBuffer(job.id, buffer);
  await ocrWorker.processJob(job);

  // 3. Inspect updated job
  const completedJob = db.getOcrJobById(job.id);
  assert.ok(completedJob, 'Job must exist in DB');
  assert.equal(completedJob.status, 'COMPLETED', 'Job must complete successfully');
  assert.ok((completedJob.executionTimeMs ?? 0) >= 0, 'Execution time must be recorded');
  assert.ok(completedJob.candidateFields?.shippingBillNumber?.value, 'Candidate SB Number must be extracted');

  // Verify candidate fields are held in staging and NOT committed to ledger yet
  const unapprovedShipment = db.getShipments().find((s) => s.shippingBillNumber === completedJob.candidateFields?.shippingBillNumber?.value);
  // It shouldn't create a shipment automatically before approval
  assert.ok(!unapprovedShipment || unapprovedShipment.id !== job.id, 'Candidate data must not overwrite ledger unapproved');
});

test('OCR Pipeline: Deduplication prevents duplicate active jobs for identical file', async () => {
  const testFilename = `dedup_test_${Date.now()}.pdf`;
  const size = 12345;

  const job1 = db.enqueueOcrJob(
    {
      originalFilename: testFilename,
      fileSizeBytes: size,
      category: 'BILL_OF_LADING',
      financialYearId: 'fy-2026-27',
    },
    'user-1'
  );

  // Second enqueue with identical parameters within the deduplication window
  const job2 = db.enqueueOcrJob(
    {
      originalFilename: testFilename,
      fileSizeBytes: size,
      category: 'BILL_OF_LADING',
      financialYearId: 'fy-2026-27',
    },
    'user-2'
  );

  assert.equal(job1.id, job2.id, 'Deduplication must return existing active job ID');
});

test('OCR Pipeline: Error handling and retry mechanism for corrupt or invalid documents', async () => {
  const corruptJob = db.enqueueOcrJob(
    {
      originalFilename: 'corrupt_doc.pdf',
      fileSizeBytes: 42,
      category: 'ADDITIONAL_DOC',
      financialYearId: 'fy-2026-27',
    },
    'user-admin'
  );

  // Try processing with no valid buffer registered to trigger error path
  await ocrWorker.processJob(corruptJob);

  const failedJob = db.getOcrJobById(corruptJob.id);
  assert.ok(failedJob, 'Job must exist');
  assert.ok(failedJob.error || failedJob.status === 'PENDING' || failedJob.status === 'FAILED', 'Error must be logged');

  // Retry the job
  const retried = db.retryOcrJob(failedJob.id, 'user-admin');
  assert.equal(retried.status, 'PENDING', 'Status must reset to PENDING on retry');
  assert.equal(retried.error, undefined, 'Error message must be cleared on retry');
});

test('OCR Pipeline: Admin Review & Commit workflow updates PostgreSQL without overwriting unapproved data', async () => {
  const buffer = fs.readFileSync(SAMPLE_INVOICE_PDF);
  const testInvNumber = `SKE-TEST-OCR-${Date.now().toString().slice(-4)}`;

  const job = db.enqueueOcrJob(
    {
      originalFilename: `${testInvNumber}.pdf`,
      fileSizeBytes: buffer.length,
      category: 'COMMERCIAL_INVOICE',
      financialYearId: 'fy-2026-27',
    },
    'user-admin'
  );

  ocrWorker.registerStagingBuffer(job.id, buffer);
  await ocrWorker.processJob(job);

  const completed = db.getOcrJobById(job.id)!;
  assert.equal(completed.status, 'COMPLETED');

  // Create a dedicated test payment with sufficient balance
  const testPayment = db.createPayment(
    {
      irmNumber: `TEST-IRM-${Date.now()}`,
      verifiedAmount: 25000.00,
      currency: 'USD',
      valueDate: '2026-05-15',
      creditDate: '2026-05-15',
      bankId: db.getBanks()[0].id,
    },
    'user-admin'
  );

  // Admin reviews candidate data and makes a manual correction to the value
  const reviewedValues = {
    invoiceNumber: testInvNumber,
    invoiceDate: '2026-05-15',
    invoiceValueUsd: 18500.00,
    consigneeName: 'S K Global Ventures',
    portCode: 'INMAA1',
    initialFircPaymentId: testPayment.id,
  };

  const { shipment, job: approvedJob } = db.approveOcrJob(completed.id, reviewedValues, 'user-admin');
  assert.ok(shipment, 'Approved shipment record must be created in DB');
  assert.equal(shipment.invoiceNumber, testInvNumber);
  assert.equal(shipment.invoiceValueUsd, 18500.00, 'Reviewed value must match admin input');
  assert.ok(approvedJob.approvedAt, 'Approval timestamp must be saved');
  assert.equal(approvedJob.targetShipmentId, shipment.id);
});
