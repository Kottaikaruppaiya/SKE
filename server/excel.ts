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
  importType?: 'TRACKER' | 'BANK_MASTER' | 'CONSIGNEE_MASTER';
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

  // 1. Export Tracker Sheet (Comprehensive master columns)
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
    const totalRealisedInr = cShipments.reduce((sum, s) => sum + (s.realisedInr || 0), 0);
    return {
      'Consignee Name': c.name,
      'Country': c.country,
      'Port of Discharge': c.portOfDischarge,
      'Payment Terms': c.paymentTerms,
      'Total Invoices': cShipments.length,
      'Total Invoiced (USD)': totalInvoicedUsd,
      'Total Realised (USD)': totalPaidUsd,
      'Outstanding Balance (USD)': Math.max(0, totalInvoicedUsd - totalPaidUsd),
      'Realised INR Amount': totalRealisedInr,
    };
  });
  const wsConsignee = XLSX.utils.json_to_sheet(consigneeSummary);
  XLSX.utils.book_append_sheet(wb, wsConsignee, 'Consignee Summary');

  // 4. S K Global Ventures (Specific Company Detailed Ledger Sheet)
  const skGlobalConsignee = consignees.find((c) => c.name.toLowerCase().includes('sk global') || c.name.toLowerCase().includes('s k global'));
  const skGlobalShipments = shipments.filter((s) => s.consigneeId === skGlobalConsignee?.id || s.consigneeName?.toLowerCase().includes('sk global') || s.consigneeName?.toLowerCase().includes('s k global'));
  const wsSKGlobal = XLSX.utils.json_to_sheet(
    skGlobalShipments.map((s, idx) => ({
      'Sr. No.': idx + 1,
      'Invoice No.': s.invoiceNumber,
      'Invoice Date': s.invoiceDate,
      'Shipping Bill No.': s.shippingBillNumber,
      'Shipping Bill Date': s.shippingBillDate,
      'Port Code': s.portCode,
      'Packages': s.packageCount || 0,
      'Invoice USD': s.invoiceValueUsd,
      'FIRC IRM No.': s.allocations?.[0]?.paymentIrm || '',
      'Credit Date': s.allocations?.[0]?.allocatedAt?.split('T')[0] || '',
      'Allocated USD': s.totalPaidUsd || 0,
      'Balance USD': s.balanceDueUsd || 0,
      'Realised Rate': s.averageRealisedRate || 0,
      'Realised INR': s.realisedInr || 0,
      'BRC No.': s.brcRecord?.brcNumber || '',
      'BRC Status': s.brcRecord?.status || 'PENDING',
      'Payment Status': s.paymentStatus,
      'Remarks': s.remarks || '',
    }))
  );
  XLSX.utils.book_append_sheet(wb, wsSKGlobal, 'S K Global Ventures');

  // 5. Shasvanth Impex (Specific Company Detailed Ledger Sheet)
  const shasvanthConsignee = consignees.find((c) => c.name.toLowerCase().includes('shasvanth'));
  const shasvanthShipments = shipments.filter((s) => s.consigneeId === shasvanthConsignee?.id || s.consigneeName?.toLowerCase().includes('shasvanth'));
  const wsShasvanth = XLSX.utils.json_to_sheet(
    shasvanthShipments.map((s, idx) => ({
      'Sr. No.': idx + 1,
      'Invoice No.': s.invoiceNumber,
      'Invoice Date': s.invoiceDate,
      'Shipping Bill No.': s.shippingBillNumber,
      'Shipping Bill Date': s.shippingBillDate,
      'Port Code': s.portCode,
      'Packages': s.packageCount || 0,
      'Invoice USD': s.invoiceValueUsd,
      'FIRC IRM No.': s.allocations?.[0]?.paymentIrm || '',
      'Credit Date': s.allocations?.[0]?.allocatedAt?.split('T')[0] || '',
      'Allocated USD': s.totalPaidUsd || 0,
      'Balance USD': s.balanceDueUsd || 0,
      'Realised Rate': s.averageRealisedRate || 0,
      'Realised INR': s.realisedInr || 0,
      'BRC No.': s.brcRecord?.brcNumber || '',
      'BRC Status': s.brcRecord?.status || 'PENDING',
      'Payment Status': s.paymentStatus,
      'Remarks': s.remarks || '',
    }))
  );
  XLSX.utils.book_append_sheet(wb, wsShasvanth, 'Shasvanth Impex');

  // 6. Consignee Master Sheet
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

  // 7. Bank Master Sheet (Matches uploaded CSV format)
  const wsBankMaster = XLSX.utils.json_to_sheet(
    banks.map((b) => ({
      'Bank (receiving export proceeds)': b.name,
      'Branch': b.branch,
      'AD Code': b.adCode,
      'IFSC Code': b.ifscCode,
      'SWIFT Code': b.swiftCode,
      'Account Number': b.accountNumber,
      'Status': b.isActive ? 'Active' : 'Inactive',
    }))
  );
  XLSX.utils.book_append_sheet(wb, wsBankMaster, 'Bank Master');

  // 8. Inward Remittances / Payments Sheet
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

export function generateCsvExport(sheetName: string, financialYearId?: string): string {
  const wbBuffer = generateExportWorkbook(financialYearId);
  const wb = XLSX.read(wbBuffer, { type: 'buffer' });
  const targetSheet = wb.SheetNames.find((s) => s.toLowerCase().includes(sheetName.toLowerCase())) || wb.SheetNames[0];
  const sheet = wb.Sheets[targetSheet];
  return XLSX.utils.sheet_to_csv(sheet);
}

export function parseHistoricalExcelMigration(
  fileBuffer: Buffer,
  targetFinancialYearId: string,
  actorUserId: string
): ImportValidationReport {
  // Support both XLSX and CSV files!
  const wb = XLSX.read(fileBuffer, { type: 'buffer' });
  const rawText = fileBuffer.toString('utf-8');

  const report: ImportValidationReport = {
    totalRowsRead: 0,
    acceptedRows: 0,
    rejectedRows: 0,
    warningsCount: 0,
    rejectionLog: [],
    warnings: [],
    importedShipmentIds: [],
  };

  // Case A: User uploaded Bank Master CSV (such as Export_Realisation_Tracker_FY26-27_3d40b01e.csv)
  if (rawText.includes('BANK MASTER') || rawText.includes('Bank (receiving export proceeds)')) {
    report.importType = 'BANK_MASTER';
    const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const existingBanks = db.getBanks();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('BANK MASTER') || line.includes('Bank (receiving export proceeds)')) continue;
      const parts = line.split(',').map((p) => p.trim());
      const bankName = parts[0];
      if (!bankName) continue;

      report.totalRowsRead++;
      const exists = existingBanks.some((b) => b.name.toLowerCase() === bankName.toLowerCase());
      if (exists) {
        report.warnings.push({
          rowNumber: i + 1,
          invoiceNo: bankName,
          message: `Bank '${bankName}' already exists in Bank Master (preserved).`,
        });
        report.acceptedRows++;
      } else {
        try {
          db.createBank(
            {
              name: bankName,
              branch: 'Chennai Branch',
              adCode: '6690005',
              ifscCode: bankName.toLowerCase().includes('dbs') ? 'DBSS0IN0811' : bankName.toLowerCase().includes('hdfc') ? 'HDFC0000166' : 'BANK0001234',
              swiftCode: '',
              accountNumber: '',
              isActive: true,
            },
            actorUserId
          );
          report.acceptedRows++;
          report.warnings.push({
            rowNumber: i + 1,
            invoiceNo: bankName,
            message: `Created new Bank Master entry for '${bankName}'.`,
          });
        } catch (e: any) {
          report.rejectedRows++;
          report.rejectionLog.push({
            rowNumber: i + 1,
            invoiceNo: bankName,
            consignee: 'Bank Master',
            reason: e.message,
          });
        }
      }
    }
    return report;
  }

  // Case B: Consignee Master CSV
  if (rawText.includes('CONSIGNEE MASTER') || (rawText.includes('Country') && rawText.includes('Port of Discharge'))) {
    report.importType = 'CONSIGNEE_MASTER';
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    report.totalRowsRead = rows.length;

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const name = String(row['Name'] || row['Consignee Name'] || row['CONSIGNEE'] || '').trim();
      if (!name) continue;

      const existing = db.getConsignees().find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (!existing) {
        db.createConsignee(
          {
            name,
            country: String(row['Country'] || 'International').trim(),
            portOfDischarge: String(row['Port of Discharge'] || row['Port'] || '').trim(),
            paymentTerms: String(row['Payment Terms'] || 'FOB COLOMBO | DA 90 DAYS').trim(),
            currency: String(row['Currency'] || 'USD').trim(),
            contactEmail: String(row['Contact Email'] || '').trim(),
            isActive: true,
          },
          actorUserId
        );
        report.acceptedRows++;
      } else {
        report.acceptedRows++;
      }
    }
    return report;
  }

  // Case C: Standard Export Tracker Workbook or CSV
  report.importType = 'TRACKER';
  const sheetName = wb.SheetNames.find((s) => s.toLowerCase().includes('export') || s.toLowerCase().includes('tracker')) || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  report.totalRowsRead = rows.length;

  const consignees = db.getConsignees();
  const banks = db.getBanks();
  const defaultBank = banks[0];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
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
            paymentTerms: 'FOB COLOMBO | DA 90 DAYS',
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
    const sbDate = parseExcelDate(row['Shipping Bill Date'] || row['SB Date']) || '2026-04-07';
    const invDate = parseExcelDate(row['Invoice Date'] || row['Date']) || '2026-04-06';
    const rate = parseFloat(String(row['SB Exchange Rate'] || row['Rate'] || '92.10')) || 92.1;
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
          purposeCode: 'P0103',
          remarks: `Migrated from Excel historical file for ${invoiceNo}`,
        },
        actorUserId
      );
    }

    try {
      const createdShipment = db.createShipment(
        {
          financialYearId: targetFinancialYearId,
          invoiceNumber: invoiceNo,
          invoiceDate: invDate,
          consigneeId: matchedConsignee?.id || consignees[0].id,
          portCode: String(row['Destination Port'] || row['Port'] || 'INMAA1').trim().toUpperCase(),
          packageCount: parseInt(String(row['Package Count'] || '0'), 10) || 0,
          invoiceValueUsd: invoiceUsd,
          shippingBillNumber: sbNo,
          shippingBillDate: sbDate,
          sbExchangeRate: rate,
          fobValueInr: fobInr,
          blNumber: String(row['BL / Transport Doc No.'] || row['BL No'] || '').trim(),
          vesselName: String(row['Vessel Name'] || '').trim(),
          remarks: String(row['Remarks'] || 'Historical migration').trim(),
          initialFircPaymentId: payment.id,
          initialFircAllocationAmount: invoiceUsd,
          reviewStatus: 'CONFIRMED',
          incentives: {
            dbkClaimed: parseFloat(String(row['DBK Claimed (INR)'] || '0').replace(/,/g, '')) || 0,
            rodtepClaimed: parseFloat(String(row['RoDTEP Claimed (INR)'] || '0').replace(/,/g, '')) || 0,
            rosctlClaimed: parseFloat(String(row['RoSCTL Claimed (INR)'] || '0').replace(/,/g, '')) || 0,
          },
          brc: {
            uploadMode: 'SINGLE',
            statutoryDeadline: parseExcelDate(row['BRC Deadline']) || undefined,
            remarks: String(row['BRC Remarks'] || '').trim(),
          },
        },
        actorUserId
      );

      // If BRC details exist in row, update BRC
      const brcNo = String(row['BRC Number'] || row['BRC No'] || '').trim();
      if (brcNo) {
        db.updateBrcRecord(
          createdShipment.id,
          {
            brcNumber: brcNo,
            issueDate: parseExcelDate(row['BRC Issue Date']) || undefined,
            realisationDate: parseExcelDate(row['Bank Realisation Date']) || undefined,
            realisedAmount: invoiceUsd,
            realisedCurrency: 'USD',
            status: 'REALISED',
          },
          actorUserId
        );
      }

      report.acceptedRows++;
      report.importedShipmentIds.push(createdShipment.id);
    } catch (err: any) {
      report.rejectedRows++;
      report.rejectionLog.push({
        rowNumber: rowNum,
        invoiceNo,
        consignee: consigneeName,
        reason: err.message,
      });
    }
  });

  return report;
}

function parseExcelDate(val: any): string | null {
  if (!val) return null;
  if (typeof val === 'number') {
    // Excel date serial number
    const date = new Date((val - (25567 + 2)) * 86400 * 1000);
    return date.toISOString().split('T')[0];
  }
  const str = String(val).trim();
  const parts = str.replace(/[\/\.]/g, '-').split('-');
  if (parts.length === 3) {
    if (parts[0].length === 4) return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    if (parts[2].length === 4) return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }
  return str;
}
