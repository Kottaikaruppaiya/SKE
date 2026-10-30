/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as XLSX from 'xlsx';
import { db } from './db.ts';
import { normalizeInvoiceKey } from './normalizer.ts';

export interface ImportValidationReport {
  totalRowsRead: number;
  acceptedRows: number;
  rejectedRows: number;
  warningsCount: number;
  rejectionLog: Array<{
    rowNumber: number;
    invoiceNo: string;
    consignee: string;
    reason: string;
  }>;
  warnings: Array<{
    rowNumber: number;
    invoiceNo: string;
    message: string;
  }>;
  importedShipmentIds: string[];
}

export function generateExportWorkbook(financialYearId?: string): Buffer {
  const wb = XLSX.utils.book_new();
  const shipments = db.getShipments(financialYearId ? { financialYearId } : undefined);
  const consignees = db.getConsignees();
  const banks = db.getBanks();
  const payments = db.getPayments();
  const metrics = db.getDashboardMetrics(financialYearId);

  // 1. Export Tracker Sheet (44 Columns)
  const trackerData = shipments.map((s, idx) => {
    const dbk = s.incentives?.find((i) => i.type === 'DRAWBACK');
    const rodtep = s.incentives?.find((i) => i.type === 'RODTEP');
    const rosctl = s.incentives?.find((i) => i.type === 'ROSCTL');
    const alloc = s.allocations?.[0];
    const payment = alloc ? payments.find((p) => p.id === alloc.paymentId) : undefined;
    const brc = s.brcRecord;

    return {
      'Sr. No.': idx + 1,
      'Financial Year': s.financialYearLabel || '2026-27',
      'Invoice No.': s.invoiceNumber,
      'Invoice Date': s.invoiceDate,
      'Consignee Name': s.consigneeName,
      'Destination Port': s.portCode,
      'Package Count': s.packageCount || 0,
      'Invoice Value (USD)': s.invoiceValueUsd,
      'Shipping Bill No.': s.shippingBillNumber,
      'Shipping Bill Date': s.shippingBillDate,
      'SB Exchange Rate': s.sbExchangeRate,
      'FOB Value (INR)': s.fobValueInr,
      'DBK Claimed (INR)': dbk?.claimedAmount || 0,
      'DBK Status': dbk?.status || 'PENDING',
      'DBK Received Amount (INR)': dbk?.receivedAmount || 0,
      'DBK Received Date': dbk?.receivedDate || '',
      'RoDTEP Claimed (INR)': rodtep?.claimedAmount || 0,
      'RoDTEP Status': rodtep?.status || 'PENDING',
      'RoDTEP Received Amount (INR)': rodtep?.receivedAmount || 0,
      'RoDTEP Received Date': rodtep?.receivedDate || '',
      'RoSCTL Claimed (INR)': rosctl?.claimedAmount || 0,
      'RoSCTL Status': rosctl?.status || 'PENDING',
      'RoSCTL Received Amount (INR)': rosctl?.receivedAmount || 0,
      'RoSCTL Received Date': rosctl?.receivedDate || '',
      'FIRC / IRM No.': payment?.irmNumber || '',
      'Sender Reference': payment?.senderReference || '',
      'Payment Value Date': payment?.valueDate || '',
      'Payment Credit Date': payment?.creditDate || '',
      'FIRC Issue Date': payment?.fircIssueDate || '',
      'Bank Name': payment?.bankName || '',
      'Allocated USD Amount': s.totalPaidUsd || 0,
      'Realised Exchange Rate': payment?.exchangeRate || 0,
      'Realised INR Amount': s.realisedInr || 0,
      'USD Difference / Balance Due': s.balanceDueUsd || 0,
      'Payment Status': s.paymentStatus,
      'BRC Number': brc?.brcNumber || '',
      'BRC Issue Date': brc?.issueDate || '',
      'Bank Realisation Date': brc?.realisationDate || '',
      'BRC Status': brc?.status || 'PENDING',
      'BRC Deadline': brc?.statutoryDeadline || '',
      'BL / Transport Doc No.': s.blNumber || '',
      'Vessel Name': s.vesselName || '',
      'Review Status': s.reviewStatus,
      'Remarks': s.remarks || '',
    };
  });
  const wsTracker = XLSX.utils.json_to_sheet(trackerData);
  XLSX.utils.book_append_sheet(wb, wsTracker, 'Export Tracker');

  // 2. Quick View Sheet
  const quickViewData = [
    { 'Metric': 'Total Export Shipments', 'Value': metrics.totalShipments },
    { 'Metric': 'Total Invoice Value (USD)', 'Value': `$${metrics.totalInvoiceValueUsd.toLocaleString()}` },
    { 'Metric': 'Total Realised Amount (USD)', 'Value': `$${metrics.totalRealisedUsd.toLocaleString()}` },
    { 'Metric': 'Outstanding USD Balance', 'Value': `$${metrics.totalOutstandingUsd.toLocaleString()}` },
    { 'Metric': 'Fully Realised Invoices', 'Value': metrics.fullyPaidCount },
    { 'Metric': 'Partially Realised Invoices', 'Value': metrics.partPaidCount },
    { 'Metric': 'Unrealised / Unpaid Invoices', 'Value': metrics.unpaidCount },
    { 'Metric': 'Total Incentives Claimed (INR)', 'Value': `₹${metrics.incentivesClaimedInr.toLocaleString()}` },
    { 'Metric': 'Total Incentives Received (INR)', 'Value': `₹${metrics.incentivesReceivedInr.toLocaleString()}` },
    { 'Metric': 'Pending Incentives (INR)', 'Value': `₹${metrics.incentivesPendingInr.toLocaleString()}` },
    { 'Metric': 'BRC Complete Count', 'Value': metrics.brcRealisedCount },
    { 'Metric': 'BRC Pending Count', 'Value': metrics.brcPendingCount },
  ];
  const wsQuick = XLSX.utils.json_to_sheet(quickViewData);
  XLSX.utils.book_append_sheet(wb, wsQuick, 'Quick View');

  // 3. Consignee Summary Sheet
  const consigneeSummary = consignees.map((c) => {
    const cShipments = shipments.filter((s) => s.consigneeId === c.id);
    const totalInvoicedUsd = cShipments.reduce((sum, s) => sum + s.invoiceValueUsd, 0);
    const totalPaidUsd = cShipments.reduce((sum, s) => sum + (s.totalPaidUsd || 0), 0);
    return {
      'Consignee Name': c.name,
      'Country': c.country,
      'Port of Discharge': c.portOfDischarge,
      'Payment Terms': c.paymentTerms,
      'Total Invoices': cShipments.length,
      'Total Invoiced (USD)': totalInvoicedUsd,
      'Total Realised (USD)': totalPaidUsd,
      'Outstanding Balance (USD)': Math.max(0, totalInvoicedUsd - totalPaidUsd),
    };
  });
  const wsConsignee = XLSX.utils.json_to_sheet(consigneeSummary);
  XLSX.utils.book_append_sheet(wb, wsConsignee, 'Consignee Summary');

  // 4. Consignee Master Sheet
  const wsConsigneeMaster = XLSX.utils.json_to_sheet(
    consignees.map((c) => ({
      'ID': c.id,
      'Name': c.name,
      'Country': c.country,
      'Port of Discharge': c.portOfDischarge,
      'Payment Terms': c.paymentTerms,
      'Currency': c.currency,
      'Contact Email': c.contactEmail || '',
      'Status': c.isActive ? 'Active' : 'Inactive',
    }))
  );
  XLSX.utils.book_append_sheet(wb, wsConsigneeMaster, 'Consignee Master');

  // 5. Bank Master Sheet
  const wsBankMaster = XLSX.utils.json_to_sheet(
    banks.map((b) => ({
      'ID': b.id,
      'Bank Name': b.name,
      'Branch': b.branch,
      'AD Code': b.adCode,
      'IFSC Code': b.ifscCode,
      'SWIFT Code': b.swiftCode,
      'Account Number': b.accountNumber,
      'Status': b.isActive ? 'Active' : 'Inactive',
    }))
  );
  XLSX.utils.book_append_sheet(wb, wsBankMaster, 'Bank Master');

  // 6. Payments Sheet
  const paymentsData = payments.map((p) => ({
    'IRM Number': p.irmNumber,
    'Sender Reference': p.senderReference || '',
    'Remittance USD': p.verifiedAmount,
    'Allocated USD': p.totalAllocatedUsd || 0,
    'Available Balance USD': p.availableBalanceUsd || 0,
    'Exchange Rate': p.exchangeRate || 0,
    'INR Amount': p.inrAmount || 0,
    'Credit Date': p.creditDate,
    'Value Date': p.valueDate,
    'Bank': p.bankName || '',
    'Purpose Code': p.purposeCode || '',
  }));
  const wsPayments = XLSX.utils.json_to_sheet(paymentsData);
  XLSX.utils.book_append_sheet(wb, wsPayments, 'Inward Remittances');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function parseHistoricalExcelMigration(
  fileBuffer: Buffer,
  targetFinancialYearId: string,
  actorUserId: string
): ImportValidationReport {
  const wb = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.find((s) => s.toLowerCase().includes('export') || s.toLowerCase().includes('tracker')) || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const report: ImportValidationReport = {
    totalRowsRead: rows.length,
    acceptedRows: 0,
    rejectedRows: 0,
    warningsCount: 0,
    rejectionLog: [],
    warnings: [],
    importedShipmentIds: [],
  };

  const consignees = db.getConsignees();
  const banks = db.getBanks();
  const defaultBank = banks[0];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // header is row 1
    const invoiceNo = String(row['Invoice No.'] || row['Invoice No'] || row['INVOICE NO'] || '').trim();
    const consigneeName = String(row['Consignee Name'] || row['Consignee'] || row['BUYER'] || '').trim();
    const fircIrm = String(
      row['FIRC / IRM No.'] || row['FIRC No.'] || row['IRM Number'] || row['FIRC'] || row['IRM'] || ''
    ).trim();

    if (!invoiceNo) {
      report.rejectedRows++;
      report.rejectionLog.push({
        rowNumber: rowNum,
        invoiceNo: 'BLANK',
        consignee: consigneeName,
        reason: 'Invoice number is missing or empty.',
      });
      return;
    }

    // MANDATORY IMPORT RULE: Exclude legacy rows that have no FIRC under the confirmed import rule
    if (!fircIrm) {
      report.rejectedRows++;
      report.rejectionLog.push({
        rowNumber: rowNum,
        invoiceNo,
        consignee: consigneeName,
        reason: 'EXCLUDED UNDER RULE: No valid FIRC / IRM remittance record linked to this invoice.',
      });
      return;
    }

    const normalizedKey = normalizeInvoiceKey(invoiceNo);
    // Duplicate check
    const existing = db.getShipmentByNormalizedKey(normalizedKey, targetFinancialYearId);
    if (existing) {
      report.rejectedRows++;
      report.rejectionLog.push({
        rowNumber: rowNum,
        invoiceNo,
        consignee: consigneeName,
        reason: `DUPLICATE DETECTED: Normalized key '${normalizedKey}' already exists in database.`,
      });
      return;
    }

    // Match or create Consignee
    let matchedConsignee = consignees.find((c) => c.name.toLowerCase() === consigneeName.toLowerCase());
    if (!matchedConsignee) {
      try {
        matchedConsignee = db.createConsignee(
          {
            name: consigneeName || `Consignee ${invoiceNo}`,
            country: 'International',
            portOfDischarge: '',
            paymentTerms: 'Historical Migration',
            currency: 'USD',
            isActive: true,
          },
          actorUserId
        );
        report.warnings.push({
          rowNumber: rowNum,
          invoiceNo,
          message: `Created new Consignee Master record for '${consigneeName}'.`,
        });
        report.warningsCount++;
      } catch (e: any) {
        matchedConsignee = consignees[0];
      }
    }

    // Values extraction
    const invoiceUsd = parseFloat(String(row['Invoice Value (USD)'] || row['Invoice Value'] || '0').replace(/,/g, '')) || 1000;
    const sbNo = String(row['Shipping Bill No.'] || row['SB No'] || `SB-${invoiceNo}`).trim();
    const sbDate = parseExcelDate(row['Shipping Bill Date'] || row['SB Date']) || '2026-05-01';
    const invDate = parseExcelDate(row['Invoice Date'] || row['Date']) || '2026-05-01';
    const rate = parseFloat(String(row['SB Exchange Rate'] || row['Rate'] || '84.50')) || 84.5;
    const fobInr = parseFloat(String(row['FOB Value (INR)'] || row['FOB INR'] || '0').replace(/,/g, '')) || invoiceUsd * rate;

    // Check if Payment FIRC exists or create
    let payment = db.getPayments().find((p) => p.irmNumber.toUpperCase() === fircIrm.toUpperCase());
    if (!payment) {
      payment = db.createPayment(
        {
          irmNumber: fircIrm,
          senderReference: String(row['Sender Reference'] || '').trim(),
          verifiedAmount: invoiceUsd,
          inrAmount: fobInr,
          exchangeRate: rate,
          valueDate: invDate,
          creditDate: invDate,
          bankId: defaultBank.id,
          purposeCode: 'P0102',
          remarks: `Migrated from Excel historical file for ${invoiceNo}`,
        },
        actorUserId
      );
    }

    try {
      const shipment = db.createShipment(
        {
          financialYearId: targetFinancialYearId,
          invoiceNumber: invoiceNo,
          invoiceDate: invDate,
          consigneeId: matchedConsignee.id,
          portCode: String(row['Destination Port'] || 'INNSA1').trim().toUpperCase(),
          packageCount: parseInt(String(row['Package Count'] || '0'), 10) || 0,
          invoiceValueUsd: invoiceUsd,
          shippingBillNumber: sbNo,
          shippingBillDate: sbDate,
          sbExchangeRate: rate,
          fobValueInr: fobInr,
          blNumber: String(row['BL / Transport Doc No.'] || '').trim() || undefined,
          vesselName: String(row['Vessel Name'] || '').trim() || undefined,
          remarks: String(row['Remarks'] || 'Imported via Excel Migration').trim(),
          initialFircPaymentId: payment.id,
          initialFircAllocationAmount: invoiceUsd,
          reviewStatus: 'CONFIRMED',
          incentives: {
            dbkClaimed: parseFloat(String(row['DBK Claimed (INR)'] || '0').replace(/,/g, '')) || 0,
            rodtepClaimed: parseFloat(String(row['RoDTEP Claimed (INR)'] || '0').replace(/,/g, '')) || 0,
            rosctlClaimed: parseFloat(String(row['RoSCTL Claimed (INR)'] || '0').replace(/,/g, '')) || 0,
          },
        },
        actorUserId
      );

      report.acceptedRows++;
      report.importedShipmentIds.push(shipment.id);
    } catch (err: any) {
      report.rejectedRows++;
      report.rejectionLog.push({
        rowNumber: rowNum,
        invoiceNo,
        consignee: consigneeName,
        reason: err.message || 'Error creating shipment.',
      });
    }
  });

  return report;
}

function parseExcelDate(val: any): string | null {
  if (!val) return null;
  if (typeof val === 'number') {
    // Excel serial number to date
    const d = new Date((val - (25567 + 2)) * 86400 * 1000);
    return d.toISOString().split('T')[0];
  }
  const str = String(val).trim();
  const m = str.match(/([0-9]{4})[-.\/]([0-9]{1,2})[-.\/]([0-9]{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const m2 = str.match(/([0-9]{1,2})[-.\/]([0-9]{1,2})[-.\/]([0-9]{2,4})/);
  if (m2) {
    const yr = m2[3].length === 2 ? `20${m2[3]}` : m2[3];
    return `${yr}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  }
  return null;
}
