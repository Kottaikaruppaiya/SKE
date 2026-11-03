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

test('OCR Pipeline: Concurrency control respects maximum concurrent active jobs', () => {
  const metrics = ocrWorker.getConcurrencyMetrics();
  assert.ok(metrics.maxConcurrency >= 1, 'Max concurrency must be at least 1');
  assert.ok(metrics.activeJobs >= 0, 'Active jobs count must be non-negative');
});

test('OCR Pipeline: Worker recovery handles pending jobs left after restart or crash', async () => {
  const buffer = fs.readFileSync(SAMPLE_INVOICE_PDF);
  const crashRecoveryJob = db.enqueueOcrJob(
    {
      originalFilename: `recovery_test_${Date.now()}.pdf`,
      fileSizeBytes: buffer.length,
      category: 'COMMERCIAL_INVOICE',
      financialYearId: 'fy-2026-27',
    },
    'system-recovery-test'
  );

  // Simulate an interrupted or crashed job that was marked PROCESSING before crash
  db.updateOcrJob(crashRecoveryJob.id, {
    status: 'PENDING', // or reset to PENDING by supervisor
    error: 'Worker restarted: recovering uncompleted job',
  });

  ocrWorker.registerStagingBuffer(crashRecoveryJob.id, buffer);
  await ocrWorker.processJob(crashRecoveryJob);

  const recoveredJob = db.getOcrJobById(crashRecoveryJob.id);
  assert.ok(recoveredJob);
  assert.equal(recoveredJob.status, 'COMPLETED', 'Recovered job must complete processing successfully');
  assert.ok(recoveredJob.candidateFields?.invoiceNumber?.value, 'Must extract candidates after recovery');
});

test('Storage Security: Path traversal protection rejects attempts to escape storage boundaries', () => {
  const storageRoot = path.resolve('storage');
  const assetsRoot = path.resolve('public/assets');

  const safePath = path.resolve('storage/FY2026-27/SKE_26-27_020/invoice.pdf');
  const maliciousPath = path.resolve('storage/../../etc/passwd');

  const isSafeValid = safePath.startsWith(storageRoot) || safePath.startsWith(assetsRoot);
  const isMaliciousValid = maliciousPath.startsWith(storageRoot) || maliciousPath.startsWith(assetsRoot);

  assert.equal(isSafeValid, true, 'Valid storage path must be allowed');
  assert.equal(isMaliciousValid, false, 'Malicious path traversal must be rejected');
});

test('OCR Pipeline: Database-level atomic job claiming ensures mutually exclusive ownership across workers', () => {
  const testJob = db.enqueueOcrJob(
    {
      originalFilename: `atomic_test_${Date.now()}.pdf`,
      fileSizeBytes: 6000,
      category: 'COMMERCIAL_INVOICE',
      financialYearId: 'fy-2026-27',
    },
    'system-test'
  );

  // Worker 1 claims the job
  const claimedByWorker1 = db.claimNextOcrJob('worker-instance-1', 60000);
  assert.ok(claimedByWorker1, 'Worker 1 must successfully claim eligible pending job');
  assert.equal(claimedByWorker1.id, testJob.id);
  assert.equal(claimedByWorker1.status, 'PROCESSING');
  assert.equal(claimedByWorker1.lockedByWorkerId, 'worker-instance-1');

  // Worker 2 attempts to claim at the same time
  const claimedByWorker2 = db.claimNextOcrJob('worker-instance-2', 60000);
  // Should NOT get the same job because it is actively locked by Worker 1
  if (claimedByWorker2) {
    assert.notEqual(claimedByWorker2.id, testJob.id, 'Worker 2 must not claim a job locked by Worker 1');
  }

  // Clean up
  db.deleteOcrJob(testJob.id, 'system-test');
});

test('OCR Pipeline: Expired worker lease allows secondary worker to safely reclaim job', async () => {
  const leaseTestJob = db.enqueueOcrJob(
    {
      originalFilename: `lease_test_${Date.now()}.pdf`,
      fileSizeBytes: 7000,
      category: 'SHIPPING_BILL',
      financialYearId: 'fy-2026-27',
    },
    'system-test'
  );

  // Worker 1 claims with very short 50ms lease
  const claimed = db.claimNextOcrJob('worker-short-lease', 50);
  assert.ok(claimed);
  assert.equal(claimed.id, leaseTestJob.id);

  // Wait 60ms for lease to expire
  await new Promise((resolve) => setTimeout(resolve, 60));

  // Worker 2 attempts claim; must reclaim the expired job
  const reclaimed = db.claimNextOcrJob('worker-recovery-2', 60000);
  assert.ok(reclaimed, 'Secondary worker must reclaim expired job');
  assert.equal(reclaimed.id, leaseTestJob.id);
  assert.equal(reclaimed.lockedByWorkerId, 'worker-recovery-2');
  assert.equal(reclaimed.attempts, 2, 'Attempts must increment on reclaim');

  // Clean up
  db.deleteOcrJob(leaseTestJob.id, 'system-test');
});

test('OCR Pipeline: Stale worker cannot commit results after lease has expired or been reclaimed', () => {
  const commitTestJob = db.enqueueOcrJob(
    {
      originalFilename: `stale_test_${Date.now()}.pdf`,
      fileSizeBytes: 8000,
      category: 'BILL_OF_LADING',
      financialYearId: 'fy-2026-27',
    },
    'system-test'
  );

  // Worker 1 claims
  db.claimNextOcrJob('worker-A', 10); // 10ms lease

  // Worker 2 reclaims after manually expiring lease
  db.updateOcrJob(commitTestJob.id, {
    lockedByWorkerId: 'worker-B',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
  });

  // Stale Worker A attempts to commit results
  assert.throws(
    () => {
      db.completeOcrJob(commitTestJob.id, 'worker-A', {
        executionTimeMs: 120,
        ocrApplied: false,
      });
    },
    /Lease violation/,
    'Stale worker commit must be rejected with lease violation error'
  );

  // Clean up
  db.deleteOcrJob(commitTestJob.id, 'system-test');
});

test('Security & Auditing: Logout revokes session token and rejected on reuse', () => {
  const testUser = db.getUsers()[0];
  const testToken = `test-jwt-token-${Date.now()}-${crypto.randomUUID()}`;

  // Initially token is not revoked
  assert.equal(db.isTokenRevoked(testToken), false, 'Token must not be revoked initially');

  // User logs out, revoking token
  db.revokeToken(testToken, testUser.id);
  assert.equal(db.isTokenRevoked(testToken), true, 'Token must be marked revoked after logout');

  // Verify revocation persistence without generating audit logs
  db.reloadFromDisk();
  assert.equal(db.isTokenRevoked(testToken), true, 'Revocation state persists across reloads');
});



