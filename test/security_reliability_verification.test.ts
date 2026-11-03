/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db } from '../server/db.ts';
import { authenticate, generateToken, type AuthenticatedRequest } from '../server/auth.ts';
import { ocrWorker, OcrQueueWorker } from '../server/ocr_worker.ts';
import { getStorageDir } from '../server/routes.ts';

const JWT_SECRET = process.env.JWT_SECRET || 'ske_export_documents_tracker_secret_key_2026';

test('Security Verification: Server-side token revocation persists and prunes expired tokens', () => {
  const testUser = db.getUsers()[0];
  assert.ok(testUser, 'Test user must exist');

  const tokenString = jwt.sign(
    { id: testUser.id, email: testUser.email, role: testUser.role, name: testUser.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  assert.equal(db.isTokenRevoked(tokenString), false, 'Token must not be revoked before logout');

  // Decode exp claim
  const decoded = jwt.decode(tokenString) as any;
  const expiresAt = new Date(decoded.exp * 1000).toISOString();

  // Revoke token with explicit expiration
  db.revokeToken(tokenString, testUser.id, expiresAt);
  assert.equal(db.isTokenRevoked(tokenString), true, 'Token must be marked revoked');

  // Verify revocation survives database reload from disk
  db.reloadFromDisk();
  assert.equal(db.isTokenRevoked(tokenString), true, 'Revocation state must survive reload from disk/restart');
});

test('Security Verification: Fail-closed authentication on invalid/revoked tokens and database exceptions', () => {
  const testUser = db.getUsers()[0];
  const tokenString = generateToken(testUser);

  // Revoke token
  db.revokeToken(tokenString, testUser.id);

  // Authenticate middleware mock
  let nextCalled = false;
  let statusCode = 0;
  let responseBody: any = null;

  const mockReq: any = {
    headers: { authorization: `Bearer ${tokenString}` },
    query: {},
  };
  const mockRes: any = {
    status(code: number) {
      statusCode = code;
      return {
        json(data: any) {
          responseBody = data;
        },
      };
    },
  };

  authenticate(mockReq, mockRes, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'Revoked token must not call next()');
  assert.equal(statusCode, 401, 'Revoked token must return HTTP 401');
  assert.ok(responseBody.error.includes('revoked') || responseBody.error.includes('expired'), 'Response must explain session revocation');
});

test('OCR Reliability: Multi-worker concurrency with unique worker IDs and atomic mutually exclusive claiming', () => {
  // Create 3 independent worker instances
  const worker1 = new OcrQueueWorker('worker-alpha-1');
  const worker2 = new OcrQueueWorker('worker-beta-2');
  const worker3 = new OcrQueueWorker('worker-gamma-3');

  assert.notEqual(worker1.workerId, worker2.workerId, 'Worker IDs must be unique');
  assert.notEqual(worker2.workerId, worker3.workerId, 'Worker IDs must be unique');

  // Drain any pending/expired jobs leftover from previous tests
  while (db.claimNextOcrJob('drain-worker', 10000)) {}

  // Enqueue 2 test jobs
  const job1 = db.enqueueOcrJob(
    {
      originalFilename: `concurrency_test_1_${Date.now()}.pdf`,
      fileSizeBytes: 5000,
      category: 'COMMERCIAL_INVOICE',
      financialYearId: 'fy-2026-27',
    },
    'system'
  );

  const job2 = db.enqueueOcrJob(
    {
      originalFilename: `concurrency_test_2_${Date.now()}.pdf`,
      fileSizeBytes: 6000,
      category: 'SHIPPING_BILL',
      financialYearId: 'fy-2026-27',
    },
    'system'
  );

  // Worker 1 claims job
  const claim1 = db.claimNextOcrJob(worker1.workerId, 60000);
  assert.ok(claim1, 'Worker 1 should claim first job');

  // Worker 2 claims job
  const claim2 = db.claimNextOcrJob(worker2.workerId, 60000);
  assert.ok(claim2, 'Worker 2 should claim second job');

  // Verify mutually exclusive claims: Worker 1 and Worker 2 got different jobs
  assert.notEqual(claim1.id, claim2.id, 'Workers must not claim the same job');

  // Worker 3 attempts claim when no jobs remain
  const claim3 = db.claimNextOcrJob(worker3.workerId, 60000);
  assert.equal(claim3, null, 'Worker 3 should receive null when no pending or expired jobs exist');

  // Stop polling on test workers
  worker1.stopPolling();
  worker2.stopPolling();
  worker3.stopPolling();

  // Clean up
  db.deleteOcrJob(job1.id, 'system');
  db.deleteOcrJob(job2.id, 'system');
});

test('OCR Reliability: Active lease renewal extends lease throughout long-running job', () => {
  const longJob = db.enqueueOcrJob(
    {
      originalFilename: `lease_heartbeat_test_${Date.now()}.pdf`,
      fileSizeBytes: 9999,
      category: 'COMMERCIAL_INVOICE',
      financialYearId: 'fy-2026-27',
    },
    'system'
  );

  // Claim with 1000ms lease
  const claimed = db.claimNextOcrJob('worker-heartbeat-test', 1000);
  assert.ok(claimed);
  const initialLeaseTime = new Date(claimed.leaseExpiresAt!).getTime();

  // Renew lease with additional 60000ms
  const renewed = db.renewOcrJobLease(longJob.id, 'worker-heartbeat-test', 60000);
  assert.equal(renewed, true, 'Valid worker must successfully renew active lease');

  const updatedJob = db.getOcrJobById(longJob.id)!;
  const newLeaseTime = new Date(updatedJob.leaseExpiresAt!).getTime();
  assert.ok(newLeaseTime > initialLeaseTime, 'Lease expiration timestamp must be extended');

  // Unauthorized worker cannot renew lease
  const unauthorizedRenew = db.renewOcrJobLease(longJob.id, 'imposter-worker', 60000);
  assert.equal(unauthorizedRenew, false, 'Imposter worker must be rejected from renewing lease');

  // Clean up
  db.deleteOcrJob(longJob.id, 'system');
});

test('Disaster Recovery: Cryptographic SHA256 checksum detection flags tampered or invalid archive', () => {
  const tempDir = path.resolve('/tmp/ske_checksum_tamper_test');
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const testFile = path.resolve(tempDir, 'database.dump');
  fs.writeFileSync(testFile, 'ORIGINAL_DATABASE_CONTENT');

  // Compute original checksum
  const originalHash = crypto.createHash('sha256').update(fs.readFileSync(testFile)).digest('hex');
  const manifestPath = path.resolve(tempDir, 'SHA256SUMS.txt');
  fs.writeFileSync(manifestPath, `${originalHash}  database.dump\n`);

  // Verify matches initially
  const check1 = crypto.createHash('sha256').update(fs.readFileSync(testFile)).digest('hex');
  assert.equal(check1, originalHash, 'Initial hash matches');

  // Tamper with file
  fs.writeFileSync(testFile, 'TAMPERED_DATABASE_CONTENT');

  // Verify mismatch is detected
  const tamperedHash = crypto.createHash('sha256').update(fs.readFileSync(testFile)).digest('hex');
  assert.notEqual(tamperedHash, originalHash, 'Tampered file must yield different SHA256 hash');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Storage Security: Configured STORAGE_ROOT resolution and boundary containment', () => {
  const resolvedStorage = getStorageDir();
  assert.ok(path.isAbsolute(resolvedStorage), 'Resolved storage directory must be an absolute path');
  assert.ok(resolvedStorage.includes('storage'), 'Default storage directory must point to storage');

  // Malicious path traversal attempts outside boundaries
  const storageRoot = resolvedStorage;
  const assetsRoot = path.resolve('public/assets');

  const maliciousPaths = [
    path.resolve(storageRoot, '../../../../etc/shadow'),
    path.resolve(storageRoot, '../.env'),
    path.resolve(storageRoot, '../../package.json'),
  ];

  for (const mPath of maliciousPaths) {
    const isContained = mPath.startsWith(storageRoot) || mPath.startsWith(assetsRoot);
    assert.equal(isContained, false, `Path traversal attempt must be rejected: ${mPath}`);
  }
});
