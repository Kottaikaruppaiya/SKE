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
import * as XLSX from 'xlsx';
import { db } from '../server/db.ts';
import { authenticate, requireRole, generateToken, JWT_SECRET, type AuthenticatedRequest } from '../server/auth.ts';
import { generateGstExcelExport } from '../server/excel.ts';

// ==========================================
// MODULE 1: AUDIT HISTORY REMOVAL TESTS
// ==========================================

test('Module 1: Audit History: DatabaseState and db.json contain zero audit records', () => {
  // Verify DatabaseService has no auditLogs array in active state
  assert.equal((db as any).state.auditLogs, undefined, 'db.state.auditLogs must be permanently deleted');
  assert.equal((db as any).logAudit, undefined, 'db.logAudit method must be permanently removed');
  assert.equal((db as any).getAuditLogs, undefined, 'db.getAuditLogs method must be permanently removed');

  // Verify physical storage/data/db.json file has no auditLogs key
  const dbPath = path.resolve('storage/data/db.json');
  if (fs.existsSync(dbPath)) {
    const raw = fs.readFileSync(dbPath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.auditLogs, undefined, 'storage/data/db.json must not retain legacy auditLogs key');
  }
});

test('Module 1: Business Record Preservation: Shipments, payments, consignees, banks, documents remain intact', () => {
  const shipments = db.getShipments();
  assert.ok(shipments.length >= 1, 'Shipment records must be preserved intact');

  const payments = db.getPayments();
  assert.ok(payments.length >= 1, 'Payment records must be preserved intact');

  const consignees = db.getConsignees();
  assert.ok(consignees.length >= 5, 'All 5 buyer consignees must be preserved intact');

  const banks = db.getBanks();
  assert.ok(banks.length >= 1, 'Bank master records must be preserved intact');

  const users = db.getUsers();
  assert.ok(users.length >= 3, 'User accounts must be preserved intact');
});

test('Module 1: Security & Auth without Audit Logs: Login, session token creation, and logout succeed cleanly', () => {
  const user = db.getUserByEmail('owner@skenterprises.com');
  assert.ok(user, 'Owner user must exist');

  // Generate token and verify
  const token = generateToken(user);
  const decoded = jwt.verify(token, JWT_SECRET) as any;
  assert.equal(decoded.id, user.id);

  // Revoke token (logout)
  db.revokeToken(token, user.id);
  assert.equal(db.isTokenRevoked(token), true, 'Revocation must succeed without audit logging');

  // Verify reload from disk preserves state
  db.reloadFromDisk();
  assert.equal(db.isTokenRevoked(token), true, 'Revocation state persists across reload');
});

// ==========================================
// MODULE 2: VIEWER DOWNLOAD & PERMISSIONS TESTS
// ==========================================

test('Module 2: Viewer Account: Can access records and has VIEWER role', () => {
  const viewerUser = db.getUserByEmail('auditor@skenterprises.com');
  assert.ok(viewerUser, 'Viewer user auditor@skenterprises.com must exist');
  assert.equal(viewerUser.role, 'VIEWER', 'Auditor role must be VIEWER');
  assert.equal(viewerUser.isActive, true, 'Viewer must be active');
});

test('Module 2: Viewer Document Download: Permitted for Viewer with valid authentication', () => {
  const viewerUser = db.getUserByEmail('auditor@skenterprises.com')!;
  const docs = db.getDocuments();
  assert.ok(docs.length >= 1, 'Documents must exist for download testing');
  const targetDoc = docs[0];

  const token = generateToken(viewerUser);

  // Simulate authenticate middleware for Viewer on document download
  let authSuccess = false;
  let authError: string | null = null;

  const mockReq: any = {
    headers: { authorization: `Bearer ${token}` },
    params: { id: targetDoc.id },
    query: {},
  };
  const mockRes: any = {
    status(code: number) {
      return {
        json(body: any) {
          authError = body.error;
        },
      };
    },
  };
  const mockNext = () => {
    authSuccess = true;
  };

  authenticate(mockReq, mockRes, mockNext);
  assert.equal(authSuccess, true, 'Viewer must pass authentication for document download');
  assert.equal(mockReq.user?.role, 'VIEWER', 'Requesting user role must be VIEWER');
});

test('Module 2: Viewer Role Restrictions: Viewer is blocked from write operations (Shipments, Docs, GST)', () => {
  const viewerUser = db.getUserByEmail('auditor@skenterprises.com')!;
  assert.equal(viewerUser.role, 'VIEWER');

  const adminOnlyMiddleware = requireRole(['SUPER_ADMIN', 'ADMIN']);

  const mockReq: any = {
    user: viewerUser,
    originalUrl: '/api/documents/upload',
  };

  let statusCode = 0;
  let errorMessage = '';
  const mockRes: any = {
    status(code: number) {
      statusCode = code;
      return {
        json(body: any) {
          errorMessage = body.error;
        },
      };
    },
  };
  let nextCalled = false;
  const mockNext = () => {
    nextCalled = true;
  };

  adminOnlyMiddleware(mockReq, mockRes, mockNext);

  assert.equal(nextCalled, false, 'Viewer must NOT be allowed to execute Admin write endpoints');
  assert.equal(statusCode, 403, 'Must return 403 Forbidden for Viewer role on write endpoints');
  assert.ok(errorMessage.includes('Permission Denied'), 'Error message must specify permission denied');
});

test('Module 2: Unauthenticated Document Download: Rejected with 401', () => {
  const mockReq: any = {
    headers: {},
    query: {},
  };
  let statusCode = 0;
  const mockRes: any = {
    status(code: number) {
      statusCode = code;
      return {
        json(body: any) {},
      };
    },
  };
  let nextCalled = false;
  authenticate(mockReq, mockRes, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'Unauthenticated request must not pass');
  assert.equal(statusCode, 401, 'Must return 401 Authentication Required');
});

// ==========================================
// MODULE 3: GST ENTRY MODULE TESTS
// ==========================================

test('Module 3.2: GST Calculation — Example 1: GAIN (Difference > 0)', () => {
  const consignees = db.getConsignees();
  const c = consignees[0];
  const admin = db.getUsers().find((u) => u.role === 'ADMIN')!;

  // Example 1: IGST=10000, CGST=2000, SGST=2000, Total GST=14000, Refund Eligible=20000
  // Difference = 20000 - 14000 = +6000 -> GAIN
  const entry = db.createGstEntry(
    {
      entryDate: '2026-11-01',
      consigneeId: c.id,
      igst: 10000,
      cgst: 2000,
      sgst: 2000,
      refundEligible: 20000,
      remarks: 'Test GAIN calculation',
    }
  );

  assert.equal(entry.totalGst, 14000, 'Total GST must equal IGST + CGST + SGST (14000)');
  assert.equal(entry.difference, 6000, 'Difference must equal Refund Eligible - Total GST (+6000)');
  assert.equal(entry.result, 'GAIN', 'Result must be GAIN when difference > 0');
  assert.equal(entry.consigneeId, c.id);
  assert.equal(entry.consigneeName, c.name);
  assert.ok(entry.id.startsWith('GST-'), 'Entry number must be auto-generated format');
});

test('Module 3.2: GST Calculation — Example 2: LOSS (Difference < 0)', () => {
  const consignees = db.getConsignees();
  const c = consignees[1] || consignees[0];
  const admin = db.getUsers().find((u) => u.role === 'ADMIN')!;

  // Example 2: IGST=10000, CGST=2000, SGST=2000, Total GST=14000, Refund Eligible=12000
  // Difference = 12000 - 14000 = -2000 -> LOSS
  const entry = db.createGstEntry(
    {
      entryDate: '2026-11-02',
      consigneeId: c.id,
      igst: 10000,
      cgst: 2000,
      sgst: 2000,
      refundEligible: 12000,
      remarks: 'Test LOSS calculation',
    }
  );

  assert.equal(entry.totalGst, 14000, 'Total GST must equal 14000');
  assert.equal(entry.difference, -2000, 'Difference must equal -2000');
  assert.equal(entry.result, 'LOSS', 'Result must be LOSS when difference < 0');
});

test('Module 3.2: GST Calculation — Example 3: NIL (Difference == 0)', () => {
  const consignees = db.getConsignees();
  const c = consignees[2] || consignees[0];
  const admin = db.getUsers().find((u) => u.role === 'ADMIN')!;

  // Example 3: IGST=10000, CGST=2000, SGST=2000, Total GST=14000, Refund Eligible=14000
  // Difference = 14000 - 14000 = 0 -> NIL
  const entry = db.createGstEntry(
    {
      entryDate: '2026-11-03',
      consigneeId: c.id,
      igst: 10000,
      cgst: 2000,
      sgst: 2000,
      refundEligible: 14000,
      remarks: 'Test NIL calculation',
    }
  );

  assert.equal(entry.totalGst, 14000, 'Total GST must equal 14000');
  assert.equal(entry.difference, 0, 'Difference must equal 0');
  assert.equal(entry.result, 'NIL', 'Result must be NIL when difference == 0');
});

test('Module 3.3: GST Financial Precision & Negative Value Rejection', () => {
  const consignees = db.getConsignees();
  const c = consignees[0];
  const admin = db.getUsers().find((u) => u.role === 'ADMIN')!;

  // Decimal precision handling: 100.55 + 200.33 + 300.12 = 601.00
  const entry = db.createGstEntry(
    {
      entryDate: '2026-11-03',
      consigneeId: c.id,
      igst: 100.55,
      cgst: 200.33,
      sgst: 300.12,
      refundEligible: 700.0,
      remarks: 'Decimal precision test',
    }
  );

  assert.equal(entry.totalGst, 601.0);
  assert.equal(entry.difference, 99.0);
  assert.equal(entry.result, 'GAIN');

  // Negative values must be rejected
  assert.throws(
    () => {
      db.createGstEntry(
        {
          entryDate: '2026-11-03',
          consigneeId: c.id,
          igst: -500,
          cgst: 100,
          sgst: 100,
          refundEligible: 500,
        }
      );
    },
    /cannot be negative/i,
    'Must reject negative IGST'
  );

  assert.throws(
    () => {
      db.createGstEntry(
        {
          entryDate: '2026-11-03',
          consigneeId: c.id,
          igst: 100,
          cgst: 100,
          sgst: 100,
          refundEligible: -100,
        }
      );
    },
    /cannot be negative/i,
    'Must reject negative Refund Eligible'
  );

  // Invalid Consignee must be rejected
  assert.throws(
    () => {
      db.createGstEntry(
        {
          entryDate: '2026-11-03',
          consigneeId: 'non-existent-consignee-uuid',
          igst: 100,
          cgst: 100,
          sgst: 100,
          refundEligible: 500,
        }
      );
    },
    /Consignee/i,
    'Must reject invalid foreign key consignee'
  );
});

test('Module 3.5: GST Entry CRUD: Update recalculates backend values; Delete preserves other records', () => {
  const consignees = db.getConsignees();
  const c = consignees[0];
  const admin = db.getUsers().find((u) => u.role === 'ADMIN')!;

  // 1. Create entry (Initial NIL: 5000 + 0 + 0 = 5000, Refund = 5000)
  const created = db.createGstEntry(
    {
      entryDate: '2026-11-03',
      consigneeId: c.id,
      igst: 5000,
      cgst: 0,
      sgst: 0,
      refundEligible: 5000,
      remarks: 'Initial before edit',
    }
  );
  assert.equal(created.result, 'NIL');

  // 2. Update entry to GAIN (Refund increased to 8000 -> Diff = +3000)
  const updated = db.updateGstEntry(
    created.id,
    {
      refundEligible: 8000,
      remarks: 'Updated to GAIN',
    }
  );
  assert.equal(updated.totalGst, 5000);
  assert.equal(updated.refundEligible, 8000);
  assert.equal(updated.difference, 3000);
  assert.equal(updated.result, 'GAIN', 'Authoritative recalculation must update result to GAIN');
  assert.equal(updated.remarks, 'Updated to GAIN');

  // 3. Delete entry
  const initialGstCount = db.getGstEntries().entries.length;
  const initialConsigneeCount = db.getConsignees().length;
  const initialShipmentCount = db.getShipments().length;

  const delRes = db.deleteGstEntry(created.id);
  assert.equal(delRes, true);
  assert.equal(db.getGstEntries().entries.length, initialGstCount - 1);

  // Consignee and shipments must be completely preserved
  assert.equal(db.getConsignees().length, initialConsigneeCount, 'Consignee records must not be deleted');
  assert.equal(db.getShipments().length, initialShipmentCount, 'Shipments must not be deleted');
});

test('Module 3.6: GST Summary: Correctly sums components, counts GAIN/LOSS/NIL, and derives Net Difference', () => {
  const summary = db.getGstSummary();

  assert.ok(summary.totalEntries >= 3, 'Must have at least 3 entries');
  assert.equal(summary.gainCount + summary.lossCount + summary.nilCount, summary.totalEntries);
  assert.equal(
    Math.round((summary.totalIgst + summary.totalCgst + summary.totalSgst) * 100) / 100,
    summary.totalGst,
    'Total GST in summary must equal sum of IGST, CGST, SGST'
  );
  assert.equal(
    Math.round((summary.totalRefundEligible - summary.totalGst) * 100) / 100,
    summary.netDifference,
    'Net Difference must equal Total Refund Eligible - Total GST'
  );
});

test('Module 3.7: GST Excel Export: Generates valid workbook buffer with totals section and numeric cells', () => {
  const buffer = generateGstExcelExport();
  assert.ok(buffer && buffer.length > 0, 'Excel buffer must be generated');

  // Parse workbook back with XLSX to verify format and numeric preservation
  const wb = XLSX.read(buffer, { type: 'buffer' });
  assert.ok(wb.SheetNames.includes('GST Entries'), 'Workbook must have GST Entries sheet');

  const ws = wb.Sheets['GST Entries'];
  const jsonRows = XLSX.utils.sheet_to_json<any>(ws);
  assert.ok(jsonRows.length >= 4, 'Must contain entries plus totals row');

  // Check last row is TOTAL row
  const totalsRow = jsonRows[jsonRows.length - 1];
  assert.equal(totalsRow['Entry ID'], 'TOTAL');
  assert.ok(typeof totalsRow['Total GST (INR)'] === 'number', 'Total GST cell in Excel must be numeric');
  assert.ok(typeof totalsRow['Refund Eligible (INR)'] === 'number', 'Refund Eligible in Excel must be numeric');
  assert.ok(typeof totalsRow['Difference (INR)'] === 'number', 'Difference in Excel must be numeric');
});
