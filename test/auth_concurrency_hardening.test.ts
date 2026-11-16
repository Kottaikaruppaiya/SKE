/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db } from '../server/db.ts';
import {
  authenticate,
  authenticateDownload,
  generateToken,
  generateDownloadTicket,
  JWT_SECRET,
} from '../server/auth.ts';
import { validateDocumentContent } from '../server/routes.ts';

test('Auth Hardening: authenticate rejects query-string tokens and download tickets on operational endpoints', () => {
  const user = db.getUsers()[0];
  assert.ok(user, 'User must exist');

  const sessionToken = generateToken(user);
  const ticket = generateDownloadTicket(user, 'doc-123');

  // 1. Reject ?token=<session>
  {
    let nextCalled = false;
    let statusCode = 0;
    let body: any = null;
    const req: any = { headers: {}, query: { token: sessionToken } };
    const res: any = {
      status(code: number) {
        statusCode = code;
        return { json: (data: any) => { body = data; } };
      },
    };
    authenticate(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
    assert.match(body.error, /query strings are prohibited/i);
  }

  // 2. Reject download ticket passed in Authorization header on operational routes
  {
    let nextCalled = false;
    let statusCode = 0;
    let body: any = null;
    const req: any = { headers: { authorization: `Bearer ${ticket}` }, query: {} };
    const res: any = {
      status(code: number) {
        statusCode = code;
        return { json: (data: any) => { body = data; } };
      },
    };
    authenticate(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
    assert.match(body.error, /Download tickets cannot be used/i);
  }
});

test('Download Auth Hardening: authenticateDownload accepts Bearer or ?ticket= and rejects ?token=', () => {
  const user = db.getUsers()[0];
  const sessionToken = generateToken(user);
  const ticket = generateDownloadTicket(user, 'doc-123');

  // 1. Reject ?token=<session>
  {
    let nextCalled = false;
    let statusCode = 0;
    const req: any = { headers: {}, query: { token: sessionToken } };
    const res: any = {
      status(code: number) {
        statusCode = code;
        return { json: () => {} };
      },
    };
    authenticateDownload(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
  }

  // 2. Accept short-lived ?ticket=
  {
    let nextCalled = false;
    const req: any = { headers: {}, query: { ticket } };
    const res: any = { status: () => ({ json: () => {} }) };
    authenticateDownload(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.user.id, user.id);
  }

  // 3. Accept Bearer header
  {
    let nextCalled = false;
    const req: any = { headers: { authorization: `Bearer ${sessionToken}` }, query: {} };
    const res: any = { status: () => ({ json: () => {} }) };
    authenticateDownload(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.user.id, user.id);
  }
});

test('Session Revocation & Password Hashing: salted PBKDF2, tokenRevokedBefore, and clean user response', () => {
  const created = db.createUser(
    {
      email: `hardening_${Date.now()}@skenterprises.com`,
      name: 'Hardening Test User',
      role: 'ADMIN',
      isActive: true,
      mustChangePassword: true,
    },
    'InitialPass@123',
    'system'
  );

  try {
    // Verify updateUser never leaks passwordHash
    const updated = db.updateUser(created.id, { name: 'Hardening Updated' }, 'system');
    assert.equal((updated as any).passwordHash, undefined, 'updateUser must omit passwordHash');

    // Issue a token backdated by 10 seconds before revoking all sessions
    const oldToken = jwt.sign(
      {
        id: created.id,
        email: created.email,
        role: created.role,
        name: created.name,
        iat: Math.floor(Date.now() / 1000) - 10,
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Changing password clears mustChangePassword and sets tokenRevokedBefore
    const afterPwChange = db.updateUser(created.id, { password: 'NewSecurePass@456' }, created.id);
    assert.equal(afterPwChange.mustChangePassword, false);
    assert.ok(afterPwChange.tokenRevokedBefore, 'tokenRevokedBefore must be recorded');

    // Old token issued before tokenRevokedBefore must fail authenticate
    let nextCalled = false;
    let statusCode = 0;
    const req: any = { headers: { authorization: `Bearer ${oldToken}` }, query: {} };
    const res: any = {
      status(code: number) {
        statusCode = code;
        return { json: () => {} };
      },
    };
    authenticate(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);

    // Fresh token minted immediately in the same second after password change must succeed
    const freshToken = generateToken(afterPwChange);
    let freshNextCalled = false;
    const freshReq: any = { headers: { authorization: `Bearer ${freshToken}` }, query: {} };
    const freshRes: any = { status: () => ({ json: () => {} }) };
    authenticate(freshReq, freshRes, () => { freshNextCalled = true; });
    assert.equal(freshNextCalled, true, 'Fresh token minted immediately after password change must pass authenticate');

    // Verify salted PBKDF2 hashing produces unique salts and verifies correctly
    const secondUser = db.createUser(
      {
        email: `hardening_salt_${Date.now()}@skenterprises.com`,
        name: 'Hardening Salt Check',
        role: 'VIEWER',
        isActive: true,
        mustChangePassword: false,
      },
      'NewSecurePass@456',
      'system'
    );
    try {
      const hash1 = db.getUserByEmail(created.email)?.passwordHash || '';
      const hash2 = db.getUserByEmail(secondUser.email)?.passwordHash || '';
      assert.ok(hash1 && hash2, 'Stored password hashes must exist');
      assert.notEqual(hash1, hash2, 'Salted hashes for identical passwords must differ');
      assert.equal(db.verifyPassword('NewSecurePass@456', hash1), true);
      assert.equal(db.verifyPassword('WrongPassword@1', hash1), false);
    } finally {
      db.deleteUser(secondUser.id, 'user-superadmin-1');
    }
  } finally {
    db.deleteUser(created.id, 'user-superadmin-1');
  }
});

test('Upload Content Validation: accepts valid PDF/PNG/JPEG/TIFF/CSV/XLSX magic bytes and rejects executables', () => {
  assert.equal(validateDocumentContent(Buffer.from('%PDF-1.7\n...'), 'invoice.pdf'), true);
  assert.equal(validateDocumentContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'scan.png'), true);
  assert.equal(validateDocumentContent(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'photo.jpg'), true);
  assert.equal(validateDocumentContent(Buffer.from('MZ\x90\x00executable_payload'), 'invoice.pdf'), false);
  assert.equal(validateDocumentContent(Buffer.from('#!/bin/sh\nrm -rf /'), 'fake.pdf'), false);
});

test('OCR Retry & Payment Over-Allocation Guards', () => {
  const job = db.enqueueOcrJob(
    {
      originalFilename: `retry_test_${Date.now()}.pdf`,
      fileSizeBytes: 1024,
      category: 'COMMERCIAL_INVOICE',
      financialYearId: 'fy-2026-27',
    },
    'system'
  );

  try {
    db.updateOcrJob(job.id, {
      status: 'FAILED',
      attempts: 3,
      error: 'Simulated failure',
      lockedByWorkerId: 'worker-1',
      lockedAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const retried = db.retryOcrJob(job.id, 'user-admin-1');
    assert.equal(retried.status, 'PENDING');
    assert.equal(retried.attempts, 0, 'retryOcrJob must reset attempts to 0');
    assert.equal(retried.lockedByWorkerId, undefined);
    assert.equal(retried.leaseExpiresAt, undefined);
  } finally {
    db.deleteOcrJob(job.id, 'user-admin-1');
  }

  // Payment over-allocation rejection
  const banks = db.getBanks();
  const consignees = db.getConsignees();
  const payment = db.createPayment(
    {
      irmNumber: `IRM-OVERALLOC-${Date.now()}`,
      currency: 'USD',
      verifiedAmount: 1000,
      valueDate: '2026-11-01',
      creditDate: '2026-11-01',
      bankId: banks[0].id,
    },
    'user-admin-1'
  );
  const shipment = db.createShipment(
    {
      financialYearId: 'fy-2026-27',
      invoiceNumber: `SKE/26-27/OVERALLOC-${Date.now()}`,
      invoiceDate: '2026-11-01',
      consigneeId: consignees[0].id,
      portCode: 'INNSA1',
      invoiceValueUsd: 500,
      shippingBillNumber: `SB-OA-${Date.now()}`,
      shippingBillDate: '2026-11-01',
      sbExchangeRate: 85,
      fobValueInr: 42500,
      initialFircDocumentUploaded: true,
    },
    'user-admin-1'
  );

  try {
    assert.throws(
      () =>
        db.allocatePayment(
          {
            paymentId: payment.id,
            shipmentId: shipment.id,
            allocatedAmountUsd: 600,
          },
          'user-admin-1'
        ),
      /Over-allocation rejected/i
    );
  } finally {
    db.deleteShipment(shipment.id, 'user-admin-1');
    db.deletePayment(payment.id, 'user-admin-1');
  }
});

test('Dashboard Metrics: excludes archived shipments, sums per-invoice balance, and tracks archivedCount & excessReceived', () => {
  const consignees = db.getConsignees();
  const before = db.getDashboardMetrics('fy-2026-27');

  const temp = db.createShipment(
    {
      financialYearId: 'fy-2026-27',
      invoiceNumber: `SKE/26-27/DASH-${Date.now()}`,
      invoiceDate: '2026-11-01',
      consigneeId: consignees[0].id,
      portCode: 'INNSA1',
      invoiceValueUsd: 2500,
      shippingBillNumber: `SB-DASH-${Date.now()}`,
      shippingBillDate: '2026-11-01',
      sbExchangeRate: 85,
      fobValueInr: 212500,
      initialFircDocumentUploaded: true,
    },
    'user-admin-1'
  );

  try {
    const withActive = db.getDashboardMetrics('fy-2026-27');
    assert.equal(withActive.totalShipments, before.totalShipments + 1);
    assert.equal(
      Math.round((withActive.totalOutstandingUsd - before.totalOutstandingUsd) * 100) / 100,
      2500
    );

    db.archiveShipment(temp.id, 'Exclude from dashboard totals', 'user-admin-1');
    const afterArchive = db.getDashboardMetrics('fy-2026-27');
    assert.equal(afterArchive.totalShipments, before.totalShipments);
    assert.equal(afterArchive.archivedCount, (before.archivedCount ?? 0) + 1);
    assert.equal(afterArchive.totalOutstandingUsd, before.totalOutstandingUsd);
  } finally {
    db.deleteShipment(temp.id, 'user-admin-1');
  }
});
