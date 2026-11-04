/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as XLSX from 'xlsx';
import { normalizeGstrPeriod } from './gstr_period.ts';
import type {
  B2bInvoice,
  Supplier,
  B2bImportPreview,
  B2bMonthlySummary,
} from '../src/types/index.ts';

// Standard 21 field aliases for flexible header mapping
const FIELD_ALIASES: Record<string, string[]> = {
  supplierGstin: ['gstin of supplier', 'supplier gstin', 'gstin', 'supplier_gstin', 'gstin of recipient', 'suppliergstin'],
  supplierName: ['trade/legal name', 'trade legal name', 'legal name', 'supplier name', 'supplier', 'trade name', 'trade_name', 'party name'],
  invoiceNumber: ['invoice number', 'invoice no', 'inv no', 'invoice_no', 'invoice_number', 'doc number'],
  invoiceType: ['invoice type', 'inv type', 'type', 'invoice_type', 'doc type'],
  invoiceDate: ['invoice date', 'inv date', 'date', 'invoice_date', 'doc date'],
  invoiceValue: ['invoice value', 'inv value', 'total value', 'invoice_value', 'value', 'inv amount'],
  placeOfSupply: ['place of supply', 'pos', 'place_of_supply', 'state code'],
  reverseCharge: ['supply attract reverse charge', 'supply attracts reverse charge', 'reverse charge', 'rcm', 'reverse_charge', 'rev charge'],
  taxableValue: ['taxable value', 'taxable amount', 'taxable_value', 'taxable val'],
  integratedTax: ['integrated tax', 'igst', 'integrated_tax', 'igst amount', 'igst (inr)', 'integrated tax amount'],
  centralTax: ['central tax', 'cgst', 'central_tax', 'cgst amount', 'cgst (inr)', 'central tax amount'],
  stateUtTax: ['state/ut tax', 'state ut tax', 'sgst', 'sgst/utgst', 'sgst/ut tax', 'state_ut_tax', 'sgst amount', 'sgst (inr)'],
  cess: ['cess', 'cess amount', 'cess (inr)', 'cess tax'],
  gstrPeriod: ['gstr-1/iff/gstr-5 period', 'gstr 1/iff/gstr 5 period', 'gstr-1 period', 'gstr1 period', 'gstr period', 'period', 'return period', 'gstr_period', 'gstr-2b period', 'gstr2b period', 'month'],
  filingDate: ['gstr-1/iff/gstr-5 filing date', 'gstr 1/iff/gstr 5 filing date', 'filing date', 'gstr-1 filing date', 'filing_date', 'supplier filing date'],
  itcAvailability: ['itc availability', 'itc available', 'itc_availability', 'itc eligibility', 'itc'],
  reason: ['reason', 'itc reason', 'ineligibility reason', 'remarks'],
  applicableTaxRate: ['applicable % of tax rate', 'applicable tax rate', 'tax rate %', 'rate %', 'rate', 'applicable_tax_rate'],
  source: ['source', 'return source', 'doc source', 'auto drafted from'],
  irn: ['irn', 'invoice reference number', 'e-invoice irn', 'irn hash'],
  irnDate: ['irn date', 'e-invoice date', 'irn_date', 'irn acknowledgement date'],
};

function normalizeHeader(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\r\n\t_]+/g, ' ')
    .replace(/[^\w\s\/\%-]/g, '')
    .replace(/\s+/g, ' ');
}

export function parseDateCell(val: any): string | null {
  if (val === undefined || val === null || val === '') return null;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().split('T')[0];
  }
  if (typeof val === 'number') {
    // Excel serial number
    const date = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
  }
  const str = String(val).trim();
  // Format DD-MM-YYYY or DD/MM/YYYY
  const ddmmyyyy = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (ddmmyyyy) {
    const day = ddmmyyyy[1].padStart(2, '0');
    const month = ddmmyyyy[2].padStart(2, '0');
    const year = ddmmyyyy[3];
    return `${year}-${month}-${day}`;
  }
  // Format DD-MM-YY or DD/MM/YY
  const ddmmyy = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2})$/);
  if (ddmmyy) {
    const day = ddmmyy[1].padStart(2, '0');
    const month = ddmmyy[2].padStart(2, '0');
    let y = parseInt(ddmmyy[3], 10);
    if (y < 100) y += 2000;
    return `${y}-${month}-${day}`;
  }
  // Format YYYY-MM-DD
  const yyyymmdd = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (yyyymmdd) {
    const year = yyyymmdd[1];
    const month = yyyymmdd[2].padStart(2, '0');
    const day = yyyymmdd[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
  return null;
}

const round2 = (num: number) => Math.round(num * 100) / 100;

export function previewB2bWorkbook(
  buffer: Buffer,
  fileName = 'uploaded.xlsx',
  existingInvoices: B2bInvoice[] = [],
  existingSuppliers: Supplier[] = []
): B2bImportPreview {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new Error('The uploaded file contains no worksheets.');
  }

  // Detect B2B worksheet
  let b2bSheetName = wb.SheetNames.find((s) => s.trim().toUpperCase() === 'B2B');
  if (!b2bSheetName) {
    b2bSheetName = wb.SheetNames.find((s) => s.trim().toUpperCase().includes('B2B'));
  }
  if (!b2bSheetName) {
    // If only one sheet in workbook or CSV, allow it as B2B
    if (wb.SheetNames.length === 1) {
      b2bSheetName = wb.SheetNames[0];
    } else {
      // Search all sheets for rows containing GSTIN and invoice keywords
      for (const sName of wb.SheetNames) {
        const testWs = wb.Sheets[sName];
        if (!testWs) continue;
        const testRows: any[][] = XLSX.utils.sheet_to_json(testWs, { header: 1, defval: '' });
        for (let i = 0; i < Math.min(testRows.length, 10); i++) {
          const rowStr = (testRows[i] || []).map((c) => String(c).toLowerCase()).join(' ');
          if (rowStr.includes('gstin') && (rowStr.includes('invoice') || rowStr.includes('inv') || rowStr.includes('supplier'))) {
            b2bSheetName = sName;
            break;
          }
        }
        if (b2bSheetName) break;
      }
    }
  }

  // Fallback to first sheet if still not matched
  if (!b2bSheetName) {
    b2bSheetName = wb.SheetNames[0];
  }

  const ws = wb.Sheets[b2bSheetName];
  // Parse rows as 2D array to locate the true header row
  const rawRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rawRows.length === 0) {
    throw new Error(`The "${b2bSheetName}" worksheet is empty.`);
  }

  // Find candidate header row indices in the first 12 rows
  let maxColCount = 0;
  for (let i = 0; i < Math.min(rawRows.length, 12); i++) {
    if (rawRows[i] && rawRows[i].length > maxColCount) maxColCount = rawRows[i].length;
  }

  const candidateHeaderRows: number[] = [];
  for (let i = 0; i < Math.min(rawRows.length, 10); i++) {
    const row = rawRows[i] || [];
    // If any cell in this row matches an actual 15-character GSTIN pattern, this is a data row!
    const hasGstinData = row.some((c: any) => {
      const val = String(c || '').trim();
      return /^\d{2}[A-Z]{5}\d{4}[A-Z0-9]{4}$/i.test(val) || /^\d{2}[A-Z]{5}\d{4}/i.test(val);
    });
    if (hasGstinData) {
      break;
    }

    const rowStr = row.map((c: any) => String(c).toLowerCase()).join(' ');
    const isHeaderCandidate =
      rowStr.includes('gstin of supplier') ||
      rowStr.includes('supplier gstin') ||
      rowStr.includes('gstin') ||
      rowStr.includes('trade/legal') ||
      rowStr.includes('trade name') ||
      rowStr.includes('legal name') ||
      rowStr.includes('invoice number') ||
      rowStr.includes('invoice details') ||
      rowStr.includes('invoice no') ||
      rowStr.includes('invoice date') ||
      rowStr.includes('taxable value') ||
      rowStr.includes('integrated tax') ||
      rowStr.includes('central tax') ||
      rowStr.includes('state/ut tax');

    if (isHeaderCandidate) {
      candidateHeaderRows.push(i);
    }
  }

  if (candidateHeaderRows.length === 0) {
    candidateHeaderRows.push(0);
  }

  const headerMap: Record<string, number> = {}; // canonicalField -> colIndex

  // Map each alias to column index, checking individual candidate rows and merged multi-tier rows
  for (const [canonicalField, aliases] of Object.entries(FIELD_ALIASES)) {
    // 1. Check individual candidate rows
    for (const rIdx of candidateHeaderRows) {
      const row = rawRows[rIdx] || [];
      for (let colIdx = 0; colIdx < maxColCount; colIdx++) {
        const colHeaderNorm = normalizeHeader(row[colIdx]);
        if (aliases.some((a) => a === colHeaderNorm || colHeaderNorm.includes(a))) {
          if (headerMap[canonicalField] === undefined) {
            headerMap[canonicalField] = colIdx;
            break;
          }
        }
      }
      if (headerMap[canonicalField] !== undefined) break;
    }

    // 2. Check merged multi-tier headers across candidate rows (e.g. Row 4 "Invoice details" + Row 5 "Invoice number")
    if (headerMap[canonicalField] === undefined && candidateHeaderRows.length > 1) {
      for (let colIdx = 0; colIdx < maxColCount; colIdx++) {
        const mergedColStr = candidateHeaderRows
          .map((rIdx) => String((rawRows[rIdx] || [])[colIdx] || '').trim())
          .filter(Boolean)
          .join(' ');
        const colHeaderNorm = normalizeHeader(mergedColStr);
        if (aliases.some((a) => a === colHeaderNorm || colHeaderNorm.includes(a))) {
          headerMap[canonicalField] = colIdx;
          break;
        }
      }
    }
  }

  const missingColumns: string[] = [];
  const requiredFields = ['supplierGstin', 'invoiceNumber', 'invoiceDate', 'gstrPeriod'];
  for (const req of requiredFields) {
    if (headerMap[req] === undefined) {
      missingColumns.push(req);
    }
  }

  const existingInvoiceSet = new Set<string>();
  existingInvoices.forEach((inv) => {
    const key = `${inv.supplierGstin.trim().toUpperCase()}_${inv.invoiceNumber.trim().toUpperCase()}_${inv.invoiceType.trim().toUpperCase()}`;
    existingInvoiceSet.add(key);
  });

  const existingSupplierSet = new Set<string>(
    existingSuppliers.map((s) => s.gstin.trim().toUpperCase())
  );

  const seenInFileSet = new Set<string>();
  const parsedRecords: any[] = [];
  const errors: B2bImportPreview['errors'] = [];
  const duplicates: B2bImportPreview['duplicates'] = [];
  const periodDistributionMap = new Map<string, { displayPeriod: string; financialYear: string; newInvoices: number; existingInvoices: number; invalidRows: number }>();

  let newSuppliersFound = new Set<string>();
  let existingSuppliersMatched = new Set<string>();

  // Determine starting row for data (after the last header row)
  const lastHeaderRowIndex = Math.max(...candidateHeaderRows);
  const dataStartRowIndex = lastHeaderRowIndex + 1;

  // Process rows starting after headers
  for (let r = dataStartRowIndex; r < rawRows.length; r++) {
    const row = rawRows[r];
    // Skip empty rows
    if (!row || row.every((c: any) => c === '' || c === undefined || c === null)) {
      continue;
    }

    // Skip summary/total/blank rows
    const firstCell = String(row[0] || '').trim().toUpperCase();
    const secondCell = String(row[1] || '').trim().toUpperCase();
    if (
      firstCell.includes('TOTAL') ||
      secondCell.includes('TOTAL') ||
      firstCell.startsWith('SUMMARY') ||
      firstCell === 'GRAND TOTAL'
    ) {
      continue;
    }

    const rowNumber = r + 1;
    const getVal = (field: string) => {
      const idx = headerMap[field];
      return idx !== undefined ? row[idx] : undefined;
    };

    const rawGstin = String(getVal('supplierGstin') || '').trim().toUpperCase();
    const rawSupplierName = String(getVal('supplierName') || '').trim();
    const rawInvoiceNumber = String(getVal('invoiceNumber') || '').trim();
    const rawInvoiceType = String(getVal('invoiceType') || 'Regular').trim() || 'Regular';
    const rawInvoiceDate = parseDateCell(getVal('invoiceDate'));
    const rawInvoiceValue = Number(String(getVal('invoiceValue') || 0).replace(/,/g, '')) || 0;
    const rawPlaceOfSupply = String(getVal('placeOfSupply') || '').trim();
    let rawReverseCharge = String(getVal('reverseCharge') || 'N').trim().toUpperCase();
    if (rawReverseCharge === 'YES') rawReverseCharge = 'Y';
    if (rawReverseCharge === 'NO') rawReverseCharge = 'N';

    const rawTaxableValue = Number(String(getVal('taxableValue') || 0).replace(/,/g, '')) || 0;
    const rawIgst = Number(String(getVal('integratedTax') || 0).replace(/,/g, '')) || 0;
    const rawCgst = Number(String(getVal('centralTax') || 0).replace(/,/g, '')) || 0;
    const rawSgst = Number(String(getVal('stateUtTax') || 0).replace(/,/g, '')) || 0;
    const rawCess = Number(String(getVal('cess') || 0).replace(/,/g, '')) || 0;
    const rawGstrPeriod = getVal('gstrPeriod');
    const rawFilingDate = parseDateCell(getVal('filingDate'));
    let rawItc = String(getVal('itcAvailability') || 'Yes').trim();
    if (rawItc.toLowerCase() === 'y' || rawItc.toLowerCase() === 'yes') rawItc = 'Yes';
    else if (rawItc.toLowerCase() === 'n' || rawItc.toLowerCase() === 'no') rawItc = 'No';

    const rawReason = String(getVal('reason') || '').trim() || undefined;
    const rawTaxRateVal = getVal('applicableTaxRate');
    const cleanTaxRateStr = rawTaxRateVal !== undefined && rawTaxRateVal !== null ? String(rawTaxRateVal).replace(/%/g, '').trim() : '';
    const rawTaxRate = cleanTaxRateStr && !isNaN(Number(cleanTaxRateStr)) ? Number(cleanTaxRateStr) : undefined;
    const rawSource = String(getVal('source') || 'GSTR-1').trim() || 'GSTR-1';
    const rawIrn = String(getVal('irn') || '').trim() || undefined;
    const rawIrnDate = parseDateCell(getVal('irnDate')) || undefined;

    // Validate GSTR Period strictly: never guess from invoice date or upload date
    const normPeriod = normalizeGstrPeriod(rawGstrPeriod);
    if (!normPeriod) {
      errors.push({
        rowNumber,
        invoiceNumber: rawInvoiceNumber || undefined,
        supplierGstin: rawGstin || undefined,
        issue: `Missing or invalid GSTR Period: "${rawGstrPeriod || 'BLANK'}". Valid period required (e.g. "August 2026").`,
      });
      // Track in period distribution under UNASSIGNED
      const unassignedKey = 'UNASSIGNED';
      const pEntry = periodDistributionMap.get(unassignedKey) || {
        displayPeriod: 'Invalid / Missing Period',
        financialYear: '—',
        newInvoices: 0,
        existingInvoices: 0,
        invalidRows: 0,
      };
      pEntry.invalidRows++;
      periodDistributionMap.set(unassignedKey, pEntry);
      continue;
    }

    // Validate GSTIN
    if (!rawGstin || rawGstin.length < 10) {
      errors.push({
        rowNumber,
        invoiceNumber: rawInvoiceNumber,
        issue: `Invalid Supplier GSTIN: "${rawGstin}". Must be a valid 15-character GSTIN.`,
      });
      continue;
    }

    // Validate Invoice Number
    if (!rawInvoiceNumber) {
      errors.push({
        rowNumber,
        supplierGstin: rawGstin,
        issue: 'Invoice number is missing or empty.',
      });
      continue;
    }

    // Validate Invoice Date
    if (!rawInvoiceDate) {
      errors.push({
        rowNumber,
        invoiceNumber: rawInvoiceNumber,
        supplierGstin: rawGstin,
        issue: `Invalid or unparseable invoice date: "${getVal('invoiceDate')}".`,
      });
      continue;
    }

    // Track period distribution
    const pKey = normPeriod.periodKey;
    const pEntry = periodDistributionMap.get(pKey) || {
      displayPeriod: normPeriod.displayPeriod,
      financialYear: normPeriod.financialYear,
      newInvoices: 0,
      existingInvoices: 0,
      invalidRows: 0,
    };

    // Duplicate detection: Supplier GSTIN + Invoice Number + Invoice Type
    const uniqueKey = `${rawGstin}_${rawInvoiceNumber.toUpperCase()}_${rawInvoiceType.toUpperCase()}`;
    const isExistingInDb = existingInvoiceSet.has(uniqueKey);
    const isDuplicateInFile = seenInFileSet.has(uniqueKey);

    const totalGst = round2(rawIgst + rawCgst + rawSgst + rawCess);

    const invoiceDraft = {
      supplierGstin: rawGstin,
      supplierName: rawSupplierName || rawGstin,
      invoiceNumber: rawInvoiceNumber,
      invoiceType: rawInvoiceType,
      invoiceDate: rawInvoiceDate,
      invoiceValue: round2(rawInvoiceValue),
      placeOfSupply: rawPlaceOfSupply || undefined,
      reverseCharge: rawReverseCharge,
      taxableValue: round2(rawTaxableValue),
      integratedTax: round2(rawIgst),
      centralTax: round2(rawCgst),
      stateUtTax: round2(rawSgst),
      cess: round2(rawCess),
      totalGst,
      gstrPeriod: normPeriod.displayPeriod,
      periodKey: normPeriod.periodKey,
      financialYear: normPeriod.financialYear,
      filingDate: rawFilingDate || undefined,
      itcAvailability: rawItc,
      reason: rawReason,
      applicableTaxRate: rawTaxRate,
      source: rawSource,
      irn: rawIrn,
      irnDate: rawIrnDate,
      rowNumber,
    };

    if (isExistingInDb || isDuplicateInFile) {
      pEntry.existingInvoices++;
      const existingRecord = existingInvoices.find(
        (i) =>
          i.supplierGstin.toUpperCase() === rawGstin &&
          i.invoiceNumber.toUpperCase() === rawInvoiceNumber.toUpperCase() &&
          i.invoiceType.toUpperCase() === rawInvoiceType.toUpperCase()
      );

      const differingFields: string[] = [];
      if (existingRecord) {
        if (existingRecord.invoiceValue !== invoiceDraft.invoiceValue) differingFields.push('invoiceValue');
        if (existingRecord.taxableValue !== invoiceDraft.taxableValue) differingFields.push('taxableValue');
        if (existingRecord.totalGst !== invoiceDraft.totalGst) differingFields.push('totalGst');
        if (existingRecord.gstrPeriod !== invoiceDraft.gstrPeriod) differingFields.push('gstrPeriod');
      }

      duplicates.push({
        rowNumber,
        invoiceNumber: rawInvoiceNumber,
        supplierGstin: rawGstin,
        invoiceType: rawInvoiceType,
        existingRecord: existingRecord || {},
        uploadedRecord: invoiceDraft,
        differingFields,
      });
    } else {
      pEntry.newInvoices++;
      seenInFileSet.add(uniqueKey);
    }

    periodDistributionMap.set(pKey, pEntry);

    // Track suppliers
    if (existingSupplierSet.has(rawGstin)) {
      existingSuppliersMatched.add(rawGstin);
    } else {
      newSuppliersFound.add(rawGstin);
    }

    parsedRecords.push(invoiceDraft);
  }

  // Convert period distribution to sorted list
  const periodDistribution = Array.from(periodDistributionMap.entries())
    .map(([periodKey, stats]) => ({
      periodKey,
      displayPeriod: stats.displayPeriod,
      financialYear: stats.financialYear,
      newInvoices: stats.newInvoices,
      existingInvoices: stats.existingInvoices,
      invalidRows: stats.invalidRows,
    }))
    .sort((a, b) => a.periodKey.localeCompare(b.periodKey));

  return {
    fileName,
    worksheetDetected: b2bSheetName,
    totalRows: rawRows.length - dataStartRowIndex,
    validRows: parsedRecords.length - duplicates.length,
    invalidRows: errors.length,
    duplicateRows: duplicates.length,
    newSuppliersCount: newSuppliersFound.size,
    existingSuppliersCount: existingSuppliersMatched.size,
    missingColumns,
    periodDistribution,
    sampleRows: parsedRecords.slice(0, 10),
    allParsedRecords: parsedRecords,
    errors,
    duplicates,
  };
}

export function generateB2bExcelExport(invoices: B2bInvoice[], reportTitle = 'B2B Invoice Register'): Buffer {
  const wb = XLSX.utils.book_new();

  const rows = invoices.map((inv, idx) => ({
    'S.No': idx + 1,
    'GSTIN of supplier': inv.supplierGstin,
    'Trade/Legal name': inv.supplierName,
    'Invoice number': inv.invoiceNumber,
    'Invoice type': inv.invoiceType,
    'Invoice date': inv.invoiceDate,
    'Invoice value': Number(inv.invoiceValue.toFixed(2)),
    'Place of supply': inv.placeOfSupply || '—',
    'Reverse charge': inv.reverseCharge,
    'Taxable value': Number(inv.taxableValue.toFixed(2)),
    'Integrated Tax': Number(inv.integratedTax.toFixed(2)),
    'Central Tax': Number(inv.centralTax.toFixed(2)),
    'State/UT Tax': Number(inv.stateUtTax.toFixed(2)),
    'Cess': Number(inv.cess.toFixed(2)),
    'Total GST': Number(inv.totalGst.toFixed(2)),
    'GSTR period': inv.gstrPeriod,
    'Filing date': inv.filingDate || '—',
    'ITC availability': inv.itcAvailability,
    'Reason': inv.reason || '—',
    'Applicable % of tax rate': inv.applicableTaxRate ?? '—',
    'Source': inv.source || 'GSTR-1',
    'IRN': inv.irn || '—',
    'IRN date': inv.irnDate || '—',
  }));

  // Totals row
  const totalInvVal = invoices.reduce((s, i) => s + i.invoiceValue, 0);
  const totalTaxVal = invoices.reduce((s, i) => s + i.taxableValue, 0);
  const totalIgst = invoices.reduce((s, i) => s + i.integratedTax, 0);
  const totalCgst = invoices.reduce((s, i) => s + i.centralTax, 0);
  const totalSgst = invoices.reduce((s, i) => s + i.stateUtTax, 0);
  const totalCess = invoices.reduce((s, i) => s + i.cess, 0);
  const totalGst = invoices.reduce((s, i) => s + i.totalGst, 0);

  rows.push({
    'S.No': '' as any,
    'GSTIN of supplier': 'TOTAL',
    'Trade/Legal name': `${invoices.length} Invoices`,
    'Invoice number': '',
    'Invoice type': '',
    'Invoice date': '',
    'Invoice value': round2(totalInvVal),
    'Place of supply': '',
    'Reverse charge': '',
    'Taxable value': round2(totalTaxVal),
    'Integrated Tax': round2(totalIgst),
    'Central Tax': round2(totalCgst),
    'State/UT Tax': round2(totalSgst),
    'Cess': round2(totalCess),
    'Total GST': round2(totalGst),
    'GSTR period': '',
    'Filing date': '',
    'ITC availability': '',
    'Reason': '',
    'Applicable % of tax rate': '' as any,
    'Source': '',
    'IRN': '',
    'IRN date': '',
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 6 },
    { wch: 18 },
    { wch: 35 },
    { wch: 18 },
    { wch: 12 },
    { wch: 12 },
    { wch: 15 },
    { wch: 16 },
    { wch: 14 },
    { wch: 15 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 10 },
    { wch: 16 },
    { wch: 14 },
    { wch: 12 },
    { wch: 14 },
    { wch: 20 },
    { wch: 14 },
    { wch: 12 },
    { wch: 30 },
    { wch: 12 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, reportTitle.slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function generateB2bMonthlySummaryExcel(summaries: B2bMonthlySummary[], financialYear: string): Buffer {
  const wb = XLSX.utils.book_new();

  const rows = summaries.map((s, idx) => ({
    'S.No': idx + 1,
    'GSTR Period': s.displayPeriod,
    'Period Key': s.periodKey,
    'Financial Year': s.financialYear,
    'Invoice Count': s.invoiceCount,
    'Unique Suppliers': s.uniqueSuppliers,
    'Invoice Value (INR)': Number(s.totalInvoiceValue.toFixed(2)),
    'Taxable Value (INR)': Number(s.totalTaxableValue.toFixed(2)),
    'Integrated Tax (INR)': Number(s.totalIgst.toFixed(2)),
    'Central Tax (INR)': Number(s.totalCgst.toFixed(2)),
    'State/UT Tax (INR)': Number(s.totalSgst.toFixed(2)),
    'Cess (INR)': Number(s.totalCess.toFixed(2)),
    'Total GST (INR)': Number(s.totalGst.toFixed(2)),
    'ITC Available Count': s.itcAvailableCount,
    'Reverse Charge Count': s.reverseChargeCount,
  }));

  const totalInvoices = summaries.reduce((sum, s) => sum + s.invoiceCount, 0);
  const totalInvVal = summaries.reduce((sum, s) => sum + s.totalInvoiceValue, 0);
  const totalTaxVal = summaries.reduce((sum, s) => sum + s.totalTaxableValue, 0);
  const totalGst = summaries.reduce((sum, s) => sum + s.totalGst, 0);

  rows.push({
    'S.No': '' as any,
    'GSTR Period': 'TOTAL',
    'Period Key': '',
    'Financial Year': financialYear,
    'Invoice Count': totalInvoices,
    'Unique Suppliers': '' as any,
    'Invoice Value (INR)': round2(totalInvVal),
    'Taxable Value (INR)': round2(totalTaxVal),
    'Integrated Tax (INR)': round2(summaries.reduce((sum, s) => sum + s.totalIgst, 0)),
    'Central Tax (INR)': round2(summaries.reduce((sum, s) => sum + s.totalCgst, 0)),
    'State/UT Tax (INR)': round2(summaries.reduce((sum, s) => sum + s.totalSgst, 0)),
    'Cess (INR)': round2(summaries.reduce((sum, s) => sum + s.totalCess, 0)),
    'Total GST (INR)': round2(totalGst),
    'ITC Available Count': summaries.reduce((sum, s) => sum + s.itcAvailableCount, 0),
    'Reverse Charge Count': summaries.reduce((sum, s) => sum + s.reverseChargeCount, 0),
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 6 },
    { wch: 18 },
    { wch: 12 },
    { wch: 14 },
    { wch: 14 },
    { wch: 16 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 12 },
    { wch: 18 },
    { wch: 18 },
    { wch: 20 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, `Monthly_Summary_${financialYear}`.slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
