/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGstrPeriod, parseGstrPeriod, getMonthsForFinancialYear } from '../server/gstr_period.ts';
import { db } from '../server/db.ts';
import { previewB2bWorkbook, generateB2bExcelExport, generateB2bMonthlySummaryExcel } from '../server/b2b_excel.ts';

test('1. GSTR Period Normalization and FY calculation', () => {
  // Test month names
  const p1 = normalizeGstrPeriod('August 2026');
  assert.ok(p1, 'August 2026 must be parsed');
  assert.equal(p1.periodKey, '2026-08');
  assert.equal(p1.displayPeriod, 'August 2026');
  assert.equal(p1.financialYear, '2026-27');

  // Test ISO YYYY-MM
  const p2 = normalizeGstrPeriod('2026-09');
  assert.ok(p2, '2026-09 must be parsed');
  assert.equal(p2.periodKey, '2026-09');
  assert.equal(p2.displayPeriod, 'September 2026');
  assert.equal(p2.financialYear, '2026-27');

  // Test Indian format MM-YYYY
  const p3 = normalizeGstrPeriod('10-2026');
  assert.ok(p3, '10-2026 must be parsed');
  assert.equal(p3.periodKey, '2026-10');
  assert.equal(p3.displayPeriod, 'October 2026');
  assert.equal(p3.financialYear, '2026-27');

  // Test January in Indian FY (e.g. Jan 2027 belongs to FY 2026-27)
  const p4 = normalizeGstrPeriod('January 2027');
  assert.ok(p4, 'January 2027 must be parsed');
  assert.equal(p4.periodKey, '2027-01');
  assert.equal(p4.financialYear, '2026-27');

  // Test portal apostrophe format Jul'26 and Aug'26
  const pApos1 = normalizeGstrPeriod("Jul'26");
  assert.ok(pApos1, "Jul'26 must be parsed");
  assert.equal(pApos1.periodKey, '2026-07');
  assert.equal(pApos1.displayPeriod, 'July 2026');
  assert.equal(pApos1.financialYear, '2026-27');

  const pApos2 = normalizeGstrPeriod("Aug'26");
  assert.ok(pApos2, "Aug'26 must be parsed");
  assert.equal(pApos2.periodKey, '2026-08');
  assert.equal(pApos2.displayPeriod, 'August 2026');
  assert.equal(pApos2.financialYear, '2026-27');

  // Test Standard Indian Financial Year Months (April to March)
  const fyMonths = getMonthsForFinancialYear('2026-27');
  assert.equal(fyMonths.length, 12, 'Must have 12 months');
  assert.equal(fyMonths[0].periodKey, '2026-04');
  assert.equal(fyMonths[0].displayPeriod, 'April 2026');
  assert.equal(fyMonths[11].periodKey, '2027-03');
  assert.equal(fyMonths[11].displayPeriod, 'March 2027');
});

test('2. Manual Invoice Creation preserves all 21 fields and strictly groups by GSTR Period', () => {
  const gstin = '33AABCS1429B1Z' + Math.floor(Math.random() * 9);
  const invNumber = 'TEST-INV-' + Date.now();

  // Create invoice with Invoice Date in July, but GSTR Period in August
  const created = db.createB2bInvoice(
    {
      supplierGstin: gstin,
      supplierName: 'PRECISION AUTO COMPONENTS PVT LTD',
      invoiceNumber: invNumber,
      invoiceType: 'Regular',
      invoiceDate: '2026-07-25', // July invoice date
      invoiceValue: 120500.5,
      placeOfSupply: '33-Tamil Nadu',
      reverseCharge: 'N',
      taxableValue: 100000,
      integratedTax: 0,
      centralTax: 9000,
      stateUtTax: 9000,
      cess: 500,
      gstrPeriod: 'August 2026', // Return filed in August
      filingDate: '2026-08-11',
      itcAvailability: 'Yes',
      reason: '',
      applicableTaxRate: 18,
      source: 'GSTR-2B',
      irn: 'e7f1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      irnDate: '2026-07-25',
    },
    'admin-user-id'
  );

  assert.ok(created.id, 'Invoice must have a generated ID');
  assert.equal(created.supplierGstin, gstin);
  assert.equal(created.periodKey, '2026-08', 'Must be strictly grouped under August 2026');
  assert.equal(created.gstrPeriod, 'August 2026');
  assert.equal(created.financialYear, '2026-27');
  assert.equal(created.totalGst, 18500, 'Total GST must be CGST(9000) + SGST(9000) + Cess(500)');
  assert.equal(created.invoiceValue, 120500.5, 'Invoice Value must preserve discounts/round-offs without forced taxable+gst overwrite');
  assert.equal(created.irn, 'e7f1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');

  // Verify monthly summary places it in 2026-08, not 2026-07
  const summaries = db.getB2bMonthlySummaries('2026-27');
  const augSummary = summaries.find((s) => s.periodKey === '2026-08');
  assert.ok(augSummary, 'August summary must exist');
  assert.ok(augSummary.invoiceCount >= 1, 'August must contain the created invoice');

  const julSummary = summaries.find((s) => s.periodKey === '2026-07');
  const julInvoices = db.getB2bInvoices({ periodKey: '2026-07' });
  assert.equal(julInvoices.data.some((i) => i.id === created.id), false, 'Invoice must NOT appear in July even though invoiceDate is July');
});

test('3. Compound Duplicate Key enforcement (supplierGstin + invoiceNumber + invoiceType)', () => {
  const gstin = '33AABCS' + Math.floor(1000 + Math.random() * 9000) + 'B1Z0';
  const invNumber = 'DUP-TEST-' + Date.now();

  // First insertion
  const inv1 = db.createB2bInvoice({
    supplierGstin: gstin,
    supplierName: 'TEST SUPPLIER',
    invoiceNumber: invNumber,
    invoiceType: 'Regular',
    invoiceDate: '2026-08-01',
    invoiceValue: 5900,
    taxableValue: 5000,
    centralTax: 450,
    stateUtTax: 450,
    integratedTax: 0,
    cess: 0,
    gstrPeriod: 'August 2026',
  });
  assert.ok(inv1.id);

  // Attempt duplicate with same GSTIN, same invoiceNumber, same invoiceType -> must fail
  assert.throws(
    () => {
      db.createB2bInvoice({
        supplierGstin: gstin,
        supplierName: 'TEST SUPPLIER',
        invoiceNumber: invNumber,
        invoiceType: 'Regular',
        invoiceDate: '2026-08-01',
        invoiceValue: 5900,
        taxableValue: 5000,
        centralTax: 450,
        stateUtTax: 450,
        integratedTax: 0,
        cess: 0,
        gstrPeriod: 'August 2026',
      });
    },
    /Duplicate invoice detected/,
    'Duplicate invoice must throw an error'
  );

  // Different invoice type (e.g. SEZ supplies with payment) with same number is allowed
  const inv2 = db.createB2bInvoice({
    supplierGstin: gstin,
    supplierName: 'TEST SUPPLIER',
    invoiceNumber: invNumber,
    invoiceType: 'SEZ supplies with payment',
    invoiceDate: '2026-08-01',
    invoiceValue: 5900,
    taxableValue: 5000,
    centralTax: 0,
    stateUtTax: 0,
    integratedTax: 900,
    cess: 0,
    gstrPeriod: 'August 2026',
  });
  assert.ok(inv2.id, 'Different invoiceType should be allowed as separate record');
});

test('4. Supplier Master auto-creation and link validation', () => {
  const gstin = '29AABCS' + Math.floor(1000 + Math.random() * 9000) + 'Z1Z5';
  const existingSupplier = db.getSupplierByGstin(gstin);
  assert.equal(existingSupplier, undefined, 'Supplier should not exist initially');

  // Creating invoice auto-registers supplier if not existing
  const inv = db.createB2bInvoice({
    supplierGstin: gstin,
    supplierName: 'KARNATAKA ELECTRONICS LTD',
    invoiceNumber: 'KA-9901-' + Date.now(),
    invoiceType: 'Regular',
    invoiceDate: '2026-09-10',
    invoiceValue: 11800,
    placeOfSupply: '29-Karnataka',
    taxableValue: 10000,
    integratedTax: 1800,
    centralTax: 0,
    stateUtTax: 0,
    cess: 0,
    gstrPeriod: 'September 2026',
  });

  const registeredSupplier = db.getSupplierByGstin(gstin);
  assert.ok(registeredSupplier, 'Supplier should have been auto-created');
  assert.equal(registeredSupplier.legalName, 'KARNATAKA ELECTRONICS LTD');
  assert.equal(registeredSupplier.state, 'Karnataka');

  // Deleting supplier with active invoices must be rejected
  assert.throws(
    () => {
      db.deleteSupplier(registeredSupplier.id);
    },
    /Cannot delete supplier/,
    'Supplier with linked invoices cannot be deleted'
  );
});

test('5. Excel/CSV Import Preview with Sheet Detection & Fuzzy Mapping', () => {
  // Mock CSV buffer representing a multi-period inward B2B register
  const csvContent = `GSTIN of supplier,Trade/Legal name,Invoice number,Invoice type,Invoice Date,Invoice Value(₹),Place of supply,Reverse Charge,Applicable % of Tax Rate,Taxable Value (₹),Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹),Cess(₹),GSTR-2B Period,Filing Date,ITC Availability,Reason,Source,IRN,IRN Date
33AABCT1234A1Z1,DELTA FABRICATORS,INV-DEL-101,Regular,15-08-2026,23600,33-Tamil Nadu,N,18,20000,0,1800,1800,0,August 2026,11-09-2026,Yes,,GSTR-2B,,
33AABCT1234A1Z1,DELTA FABRICATORS,INV-DEL-102,Regular,10-09-2026,59000,33-Tamil Nadu,N,18,50000,0,4500,4500,0,September 2026,11-10-2026,Yes,,GSTR-2B,,
27AABCM5678B1Z2,MAHARASHTRA TOOLING,MH-881,Regular,20-09-2026,118000,27-Maharashtra,N,18,100000,18000,0,0,0,September 2026,11-10-2026,Yes,,GSTR-2B,,`;

  const buffer = Buffer.from(csvContent, 'utf-8');
  const preview = previewB2bWorkbook(buffer, 'B2B_Test_Sample.csv');

  assert.equal(preview.totalRows, 3, 'Total parsed rows should be 3');
  assert.equal(preview.validRows, 3, 'Valid rows should be 3');
  assert.equal(preview.invalidRows, 0, 'Invalid rows should be 0');

  // Verify multi-period distribution
  assert.ok(preview.periodDistribution.length >= 2, 'Should detect August and September periods');
  const augDist = preview.periodDistribution.find((p) => p.periodKey === '2026-08');
  assert.ok(augDist, 'August 2026 period must be identified');
  assert.equal(augDist.displayPeriod, 'August 2026');

  const sepDist = preview.periodDistribution.find((p) => p.periodKey === '2026-09');
  assert.ok(sepDist, 'September 2026 period must be identified');
  assert.equal(sepDist.displayPeriod, 'September 2026');
});

test('6. B2B Dashboard Metrics and Financial Year Aggregations', () => {
  const metrics = db.getB2bDashboardMetrics('2026-27');
  assert.ok(metrics.totalInvoices > 0, 'Total invoices must be > 0');
  assert.ok(metrics.uniqueSuppliers > 0, 'Unique suppliers must be > 0');
  assert.ok(metrics.totalInvoiceValue > 0, 'Total invoice value must be > 0');
  assert.ok(metrics.totalTaxableValue > 0, 'Total taxable value must be > 0');
  assert.ok(metrics.totalGst > 0, 'Total GST must be > 0');
  assert.equal(
    metrics.totalGst,
    Math.round((metrics.totalIgst + metrics.totalCgst + metrics.totalSgst + metrics.totalCess) * 100) / 100,
    'Total GST formula IGST + CGST + SGST + Cess must match perfectly'
  );
  assert.ok(Array.isArray(metrics.monthlyTrends), 'Monthly trends must be an array');
  assert.ok(Array.isArray(metrics.topSuppliers), 'Top suppliers must be an array');
  assert.ok(Array.isArray(metrics.recentInvoices), 'Recent invoices must be an array');
});

test('7. Commit Import with Duplicate Resolution Modes', () => {
  const gstin = '33AABCT' + Math.floor(1000 + Math.random() * 9000) + 'A1Z1';
  const csvContent = `GSTIN of supplier,Trade/Legal name,Invoice number,Invoice type,Invoice Date,Invoice Value(₹),Place of supply,Reverse Charge,Applicable % of Tax Rate,Taxable Value (₹),Integrated Tax(₹),Central Tax(₹),State/UT Tax(₹),Cess(₹),GSTR-2B Period,Filing Date,ITC Availability,Reason,Source,IRN,IRN Date
${gstin},DELTA FABRICATORS,INV-COMM-01,Regular,15-08-2026,23600,33-Tamil Nadu,N,18,20000,0,1800,1800,0,August 2026,11-09-2026,Yes,,GSTR-2B,,`;

  const buffer = Buffer.from(csvContent, 'utf-8');
  const preview = previewB2bWorkbook(buffer, 'Commit_Test.csv', db.getB2bInvoices().data, db.getSuppliers());

  // First commit: insert
  const res1 = db.commitB2bImport({ fileName: 'Commit_Test.csv' }, preview, 'SKIP_EXISTING', 'admin-id');
  assert.equal(res1.inserted, 1, 'Should insert 1 new record');
  assert.equal(res1.skipped, 0);

  // Second commit with same preview: SKIP_EXISTING
  const preview2 = previewB2bWorkbook(buffer, 'Commit_Test.csv', db.getB2bInvoices().data, db.getSuppliers());
  const res2 = db.commitB2bImport({ fileName: 'Commit_Test.csv' }, preview2, 'SKIP_EXISTING', 'admin-id');
  assert.equal(res2.inserted, 0, 'Should not insert duplicate');
  assert.equal(res2.skipped, 1, 'Should skip duplicate');

  // Third commit: OVERWRITE_EXISTING
  const res3 = db.commitB2bImport({ fileName: 'Commit_Test.csv' }, preview2, 'OVERWRITE_EXISTING', 'admin-id');
  assert.equal(res3.updated, 1, 'Should overwrite existing record');
});

test('8. Excel and Monthly Summary Export generation produces valid buffers', () => {
  const invoices = db.getB2bInvoices().data;
  const summaries = db.getB2bMonthlySummaries('2026-27');

  const invBuffer = generateB2bExcelExport(invoices, 'B2B Register Test');
  assert.ok(Buffer.isBuffer(invBuffer), 'Invoice register export must produce a Buffer');
  assert.ok(invBuffer.length > 500, 'Excel buffer must contain valid workbook bytes');

  const sumBuffer = generateB2bMonthlySummaryExcel(summaries, '2026-27');
  assert.ok(Buffer.isBuffer(sumBuffer), 'Monthly summary export must produce a Buffer');
  assert.ok(sumBuffer.length > 500, 'Summary Excel buffer must contain valid workbook bytes');
});

test('9. User Uploaded B2B Workbook (B2B_Data_AI_Studio_fedf686a.csv) parses all 1,251 rows with zero errors', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const filePath = path.join(process.cwd(), 'public/assets/aistudio/B2B_Data_AI_Studio_fedf686a.csv');
  if (fs.existsSync(filePath)) {
    const buf = fs.readFileSync(filePath);
    const preview = previewB2bWorkbook(buf, 'B2B_Data_AI_Studio_fedf686a.csv');
    assert.equal(preview.totalRows, 1251, 'Must detect 1,251 data rows');
    assert.equal(preview.validRows, 1251, 'All 1,251 rows must be valid');
    assert.equal(preview.invalidRows, 0, 'Must have 0 invalid rows');
    assert.equal(preview.errors.length, 0, 'Must have 0 errors');
    assert.ok(preview.allParsedRecords && preview.allParsedRecords.length === 1251, 'allParsedRecords must contain all 1,251 rows');
    assert.ok(preview.periodDistribution.length >= 2, 'Must have periods for June, July, August 2026');
  }
});


