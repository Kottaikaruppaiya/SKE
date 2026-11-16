/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PrismaClient } from '@prisma/client';
import type {
  B2bDashboardMetrics,
  B2bImportPreview,
  B2bInvoice,
  B2bMonthlySummary,
  ImportBatch,
  Supplier,
} from '../../../shared/contracts/index.ts';
import {
  aggregateB2bDashboard,
  aggregateB2bMonthlySummaries,
  calculateB2bTotalGst,
} from '../../domain/calculations/b2bGst.calc.ts';
import { round2, sumMoney } from '../../domain/calculations/money.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors/AppError.ts';
import { parseGstrPeriod } from '../../gstr_period.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';
import {
  bigIntToNumber,
  decimalToNumber,
  toDateOrUndefined,
  toIsoDate,
  toIsoTimestamp,
} from '../../infrastructure/prismaMappers.ts';

export interface B2bInvoicesFilter {
  periodKey?: string;
  financialYear?: string;
  supplierGstin?: string;
  invoiceType?: string;
  reverseCharge?: string;
  itcAvailability?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface B2bInvoicesPage {
  data: B2bInvoice[];
  total: number;
  page: number;
  limit: number;
  totalTaxableValue: number;
  totalGst: number;
  totalInvoiceValue: number;
}

export interface B2bMonthDetail {
  summary: B2bMonthlySummary;
  invoices: B2bInvoice[];
  topSuppliers: Array<{
    gstin: string;
    name: string;
    invoiceCount: number;
    invoiceValue: number;
    taxableValue: number;
    totalGst: number;
  }>;
}

export interface IB2bGstRepository {
  getSuppliers(search?: string): Promise<Supplier[]>;
  getSupplierById(id: string): Promise<Supplier | null>;
  getSupplierByGstin(gstin: string): Promise<Supplier | null>;
  createSupplier(data: {
    gstin: string;
    legalName: string;
    tradeName?: string;
    address?: string;
    state?: string;
  }): Promise<Supplier>;
  updateSupplier(
    id: string,
    updates: Partial<{ legalName: string; tradeName?: string; address?: string; state?: string }>
  ): Promise<Supplier>;
  deleteSupplier(id: string): Promise<boolean>;

  getInvoices(filters?: B2bInvoicesFilter): Promise<B2bInvoicesPage>;
  getInvoiceById(id: string): Promise<B2bInvoice | null>;
  createInvoice(data: any, userId?: string): Promise<B2bInvoice>;
  updateInvoice(id: string, updates: any, userId?: string): Promise<B2bInvoice>;
  deleteInvoice(id: string): Promise<boolean>;

  getMonthlySummaries(financialYear?: string): Promise<B2bMonthlySummary[]>;
  getMonthDetail(periodKey: string): Promise<B2bMonthDetail>;
  getDashboardMetrics(financialYear?: string): Promise<B2bDashboardMetrics>;

  commitImport(
    batchMeta: { fileName: string; fileSizeBytes?: number },
    previewData: B2bImportPreview,
    mode: 'SKIP_EXISTING' | 'OVERWRITE_EXISTING' | 'INSERT_ALL',
    userId?: string
  ): Promise<{ batchId: string; totalProcessed: number; inserted: number; updated: number; skipped: number }>;
  getImportBatches(): Promise<ImportBatch[]>;
}

function mapPrismaSupplier(row: any, invoices: B2bInvoice[] = []): Supplier {
  const supInvoices = invoices.filter(
    (inv) => inv.supplierId === row.id || inv.supplierGstin.toUpperCase() === row.gstin.toUpperCase()
  );
  const latestInvoiceDate =
    supInvoices.length > 0
      ? [...supInvoices].sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate))[0].invoiceDate
      : undefined;

  return {
    id: row.id,
    gstin: row.gstin,
    legalName: row.legalName,
    tradeName: row.tradeName || undefined,
    address: row.address || undefined,
    state: row.state || undefined,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
    invoiceCount: supInvoices.length,
    totalInvoiceValue: sumMoney(supInvoices.map((i) => i.invoiceValue)),
    totalTaxableValue: sumMoney(supInvoices.map((i) => i.taxableValue)),
    totalGst: sumMoney(supInvoices.map((i) => i.totalGst)),
    latestInvoiceDate,
  };
}

function mapPrismaB2bInvoice(row: any): B2bInvoice {
  return {
    id: row.id,
    supplierId: row.supplierId,
    supplierGstin: row.supplierGstin,
    supplierName: row.supplierName,
    invoiceNumber: row.invoiceNumber,
    invoiceType: row.invoiceType,
    invoiceDate: toIsoDate(row.invoiceDate),
    invoiceValue: decimalToNumber(row.invoiceValue),
    placeOfSupply: row.placeOfSupply || undefined,
    reverseCharge: row.reverseCharge,
    taxableValue: decimalToNumber(row.taxableValue),
    integratedTax: decimalToNumber(row.integratedTax),
    centralTax: decimalToNumber(row.centralTax),
    stateUtTax: decimalToNumber(row.stateUtTax),
    cess: decimalToNumber(row.cess),
    totalGst: decimalToNumber(row.totalGst),
    gstrPeriod: row.gstrPeriod,
    periodKey: row.periodKey,
    financialYear: row.financialYear,
    filingDate: toDateOrUndefined(row.filingDate),
    itcAvailability: row.itcAvailability,
    reason: row.reason || undefined,
    applicableTaxRate:
      row.applicableTaxRate !== null && row.applicableTaxRate !== undefined
        ? decimalToNumber(row.applicableTaxRate)
        : undefined,
    source: row.source || undefined,
    irn: row.irn || undefined,
    irnDate: toDateOrUndefined(row.irnDate),
    importBatchId: row.importBatchId || undefined,
    createdBy: row.createdBy || undefined,
    updatedBy: row.updatedBy || undefined,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

function mapPrismaImportBatch(row: any): ImportBatch {
  return {
    id: row.id,
    fileName: row.fileName,
    fileSizeBytes:
      row.fileSizeBytes !== null && row.fileSizeBytes !== undefined ? bigIntToNumber(row.fileSizeBytes) : undefined,
    uploadedAt: toIsoTimestamp(row.uploadedAt),
    uploadedBy: row.uploadedBy || undefined,
    totalRows: row.totalRows,
    successfulRows: row.successfulRows,
    failedRows: row.failedRows,
    duplicateRows: row.duplicateRows,
    importStatus: row.importStatus,
    gstrPeriodSummary: (row.gstrPeriodSummary as Record<string, number>) || undefined,
  };
}

function filterSortAndPaginateB2bInvoices(list: B2bInvoice[], filters?: B2bInvoicesFilter): B2bInvoicesPage {
  let filtered = [...list];

  if (filters?.periodKey && filters.periodKey !== 'ALL') {
    filtered = filtered.filter((inv) => inv.periodKey === filters.periodKey);
  }
  if (filters?.financialYear && filters.financialYear !== 'ALL') {
    filtered = filtered.filter((inv) => inv.financialYear === filters.financialYear);
  }
  if (filters?.supplierGstin && filters.supplierGstin !== 'ALL') {
    const g = filters.supplierGstin.trim().toUpperCase();
    filtered = filtered.filter((inv) => inv.supplierGstin.toUpperCase() === g);
  }
  if (filters?.invoiceType && filters.invoiceType !== 'ALL') {
    const t = filters.invoiceType.toLowerCase();
    filtered = filtered.filter((inv) => inv.invoiceType.toLowerCase() === t);
  }
  if (filters?.reverseCharge && filters.reverseCharge !== 'ALL') {
    const rc = filters.reverseCharge.toUpperCase();
    filtered = filtered.filter((inv) => inv.reverseCharge.toUpperCase() === rc);
  }
  if (filters?.itcAvailability && filters.itcAvailability !== 'ALL') {
    const itc = filters.itcAvailability.toLowerCase();
    filtered = filtered.filter((inv) => inv.itcAvailability.toLowerCase() === itc);
  }
  if (filters?.search) {
    const s = filters.search.trim().toLowerCase();
    filtered = filtered.filter(
      (inv) =>
        inv.invoiceNumber.toLowerCase().includes(s) ||
        inv.supplierName.toLowerCase().includes(s) ||
        inv.supplierGstin.toLowerCase().includes(s) ||
        (inv.irn && inv.irn.toLowerCase().includes(s))
    );
  }

  const totalTaxableValue = sumMoney(filtered.map((inv) => inv.taxableValue || 0));
  const totalGst = sumMoney(filtered.map((inv) => inv.totalGst || 0));
  const totalInvoiceValue = sumMoney(filtered.map((inv) => inv.invoiceValue || 0));
  const total = filtered.length;

  const sortBy = filters?.sortBy || 'invoiceDate';
  const sortOrder = filters?.sortOrder || 'desc';
  filtered.sort((a: any, b: any) => {
    const valA = a[sortBy];
    const valB = b[sortBy];
    if (typeof valA === 'string') {
      const cmp = valA.localeCompare(valB || '');
      return sortOrder === 'asc' ? cmp : -cmp;
    }
    if (typeof valA === 'number') {
      const cmp = (valA || 0) - (valB || 0);
      return sortOrder === 'asc' ? cmp : -cmp;
    }
    return 0;
  });

  const page = Math.max(1, filters?.page || 1);
  const limit = filters?.limit === 0 ? total || 1 : Math.max(1, filters?.limit || 50);
  const start = (page - 1) * limit;
  const data = filters?.limit === 0 ? filtered : filtered.slice(start, start + limit);

  return {
    data,
    total,
    page,
    limit: filters?.limit === 0 ? total : limit,
    totalTaxableValue,
    totalGst,
    totalInvoiceValue,
  };
}

function buildMonthDetailData(periodKey: string, invoices: B2bInvoice[]): B2bMonthDetail {
  const periodInvoices = invoices.filter((inv) => inv.periodKey === periodKey);
  const parsed = parseGstrPeriod(periodKey);
  const displayPeriod = parsed?.displayPeriod || periodKey;
  const financialYear = parsed?.financialYear || '2026-27';

  const uniqueSuppliers = new Set(periodInvoices.map((inv) => inv.supplierGstin.toUpperCase())).size;
  const summary: B2bMonthlySummary = {
    periodKey,
    displayPeriod,
    financialYear,
    invoiceCount: periodInvoices.length,
    uniqueSuppliers,
    totalInvoiceValue: sumMoney(periodInvoices.map((i) => i.invoiceValue)),
    totalTaxableValue: sumMoney(periodInvoices.map((i) => i.taxableValue)),
    totalIgst: sumMoney(periodInvoices.map((i) => i.integratedTax)),
    totalCgst: sumMoney(periodInvoices.map((i) => i.centralTax)),
    totalSgst: sumMoney(periodInvoices.map((i) => i.stateUtTax)),
    totalCess: sumMoney(periodInvoices.map((i) => i.cess)),
    totalGst: sumMoney(periodInvoices.map((i) => i.totalGst)),
    itcAvailableCount: periodInvoices.filter((i) => i.itcAvailability === 'Yes').length,
    reverseChargeCount: periodInvoices.filter((i) => i.reverseCharge === 'Y').length,
  };

  const supMap = new Map<
    string,
    { gstin: string; name: string; invoiceCount: number; invoiceValue: number; taxableValue: number; totalGst: number }
  >();
  for (const inv of periodInvoices) {
    const gstin = inv.supplierGstin.toUpperCase();
    const existing = supMap.get(gstin) || {
      gstin,
      name: inv.supplierName,
      invoiceCount: 0,
      invoiceValue: 0,
      taxableValue: 0,
      totalGst: 0,
    };
    existing.invoiceCount += 1;
    existing.invoiceValue = round2(existing.invoiceValue + (inv.invoiceValue || 0));
    existing.taxableValue = round2(existing.taxableValue + (inv.taxableValue || 0));
    existing.totalGst = round2(existing.totalGst + (inv.totalGst || 0));
    supMap.set(gstin, existing);
  }

  const topSuppliers = Array.from(supMap.values()).sort((a, b) => b.taxableValue - a.taxableValue);
  return { summary, invoices: periodInvoices, topSuppliers };
}

export class PrismaB2bGstRepository implements IB2bGstRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getSuppliers(search?: string): Promise<Supplier[]> {
    const [supplierRows, invoiceRows] = await Promise.all([
      this.prisma.supplier.findMany({ orderBy: { legalName: 'asc' } }),
      this.prisma.b2bInvoice.findMany(),
    ]);
    const invoices = invoiceRows.map(mapPrismaB2bInvoice);
    const searchLower = (search || '').trim().toLowerCase();

    return supplierRows
      .map((row) => mapPrismaSupplier(row, invoices))
      .filter((sup) => {
        if (!searchLower) return true;
        return (
          sup.legalName.toLowerCase().includes(searchLower) ||
          sup.gstin.toLowerCase().includes(searchLower) ||
          Boolean(sup.tradeName && sup.tradeName.toLowerCase().includes(searchLower)) ||
          Boolean(sup.state && sup.state.toLowerCase().includes(searchLower))
        );
      });
  }

  async getSupplierById(id: string): Promise<Supplier | null> {
    const row = await this.prisma.supplier.findUnique({ where: { id } });
    if (!row) return null;
    const invoiceRows = await this.prisma.b2bInvoice.findMany({
      where: { OR: [{ supplierId: id }, { supplierGstin: row.gstin }] },
    });
    return mapPrismaSupplier(row, invoiceRows.map(mapPrismaB2bInvoice));
  }

  async getSupplierByGstin(gstin: string): Promise<Supplier | null> {
    const clean = gstin.trim().toUpperCase();
    const row = await this.prisma.supplier.findUnique({ where: { gstin: clean } });
    return row ? mapPrismaSupplier(row) : null;
  }

  async createSupplier(data: {
    gstin: string;
    legalName: string;
    tradeName?: string;
    address?: string;
    state?: string;
  }): Promise<Supplier> {
    const gstin = data.gstin.trim().toUpperCase();
    if (!gstin || gstin.length !== 15) {
      throw new ValidationError('Valid 15-character GSTIN is required.');
    }
    const legalName = data.legalName.trim();
    if (!legalName) {
      throw new ValidationError('Supplier legal name is required.');
    }

    const existing = await this.prisma.supplier.findUnique({ where: { gstin } });
    if (existing) {
      throw new ConflictError(`Supplier with GSTIN "${gstin}" already exists (${existing.legalName}).`);
    }

    const created = await this.prisma.supplier.create({
      data: {
        gstin,
        legalName,
        tradeName: data.tradeName?.trim() || null,
        address: data.address?.trim() || null,
        state: data.state?.trim() || null,
      },
    });
    return mapPrismaSupplier(created);
  }

  async updateSupplier(
    id: string,
    updates: Partial<{ legalName: string; tradeName?: string; address?: string; state?: string }>
  ): Promise<Supplier> {
    const existing = await this.prisma.supplier.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Supplier not found.');

    const updated = await this.prisma.$transaction(async (tx) => {
      let nextLegalName = existing.legalName;
      if (updates.legalName !== undefined) {
        nextLegalName = updates.legalName.trim();
        if (!nextLegalName) throw new ValidationError('Legal name cannot be empty.');
        await tx.b2bInvoice.updateMany({
          where: { OR: [{ supplierId: id }, { supplierGstin: existing.gstin }] },
          data: { supplierName: nextLegalName },
        });
      }

      return tx.supplier.update({
        where: { id },
        data: {
          ...(updates.legalName !== undefined ? { legalName: nextLegalName } : {}),
          ...(updates.tradeName !== undefined ? { tradeName: updates.tradeName?.trim() || null } : {}),
          ...(updates.address !== undefined ? { address: updates.address?.trim() || null } : {}),
          ...(updates.state !== undefined ? { state: updates.state?.trim() || null } : {}),
        },
      });
    });

    return mapPrismaSupplier(updated);
  }

  async deleteSupplier(id: string): Promise<boolean> {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) return false;

    const linkedCount = await this.prisma.b2bInvoice.count({
      where: { OR: [{ supplierId: id }, { supplierGstin: supplier.gstin }] },
    });
    if (linkedCount > 0) {
      throw new ConflictError(`Cannot delete supplier "${supplier.legalName}" as it has linked B2B invoices.`);
    }

    await this.prisma.supplier.delete({ where: { id } });
    return true;
  }

  async getInvoices(filters?: B2bInvoicesFilter): Promise<B2bInvoicesPage> {
    const rows = await this.prisma.b2bInvoice.findMany({ orderBy: { invoiceDate: 'desc' } });
    return filterSortAndPaginateB2bInvoices(rows.map(mapPrismaB2bInvoice), filters);
  }

  async getInvoiceById(id: string): Promise<B2bInvoice | null> {
    const row = await this.prisma.b2bInvoice.findUnique({ where: { id } });
    return row ? mapPrismaB2bInvoice(row) : null;
  }

  async createInvoice(data: any, userId?: string): Promise<B2bInvoice> {
    const supplierGstin = (data.supplierGstin || '').trim().toUpperCase();
    if (!supplierGstin || supplierGstin.length !== 15) {
      throw new ValidationError('Valid 15-character Supplier GSTIN is required.');
    }
    const invoiceNumber = (data.invoiceNumber || '').trim();
    if (!invoiceNumber) {
      throw new ValidationError('Invoice Number is required.');
    }
    const invoiceType = (data.invoiceType || 'Regular').trim();

    const parsedPeriod = parseGstrPeriod(data.gstrPeriod);
    if (!parsedPeriod) {
      throw new ValidationError(
        `Invalid GSTR Period: "${data.gstrPeriod}". Must be a valid period like "August 2026", "2026-08", or "08-2026".`
      );
    }

    const existing = await this.prisma.b2bInvoice.findFirst({
      where: {
        supplierGstin: { equals: supplierGstin, mode: 'insensitive' },
        invoiceNumber: { equals: invoiceNumber, mode: 'insensitive' },
        invoiceType: { equals: invoiceType, mode: 'insensitive' },
      },
    });
    if (existing) {
      throw new ConflictError(
        `Duplicate invoice detected: Invoice "${invoiceNumber}" for supplier "${supplierGstin}" already exists in GSTR Period ${existing.gstrPeriod}.`
      );
    }

    const integratedTax = round2(data.integratedTax);
    const centralTax = round2(data.centralTax);
    const stateUtTax = round2(data.stateUtTax);
    const cess = round2(data.cess);
    const totalGst = calculateB2bTotalGst({ integratedTax, centralTax, stateUtTax, cess });
    const taxableValue = round2(data.taxableValue);
    let invoiceValue = round2(data.invoiceValue);
    if (!invoiceValue || invoiceValue === 0) {
      invoiceValue = round2(taxableValue + totalGst);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      let supplier = await tx.supplier.findUnique({ where: { gstin: supplierGstin } });
      if (!supplier) {
        const supplierName = (data.supplierName || `SUPPLIER ${supplierGstin}`).trim();
        const state = data.placeOfSupply?.replace(/^\d+-/, '').trim() || null;
        supplier = await tx.supplier.create({
          data: {
            gstin: supplierGstin,
            legalName: supplierName,
            tradeName: supplierName,
            state,
          },
        });
      }

      return tx.b2bInvoice.create({
        data: {
          supplierId: supplier.id,
          supplierGstin,
          supplierName: supplier.legalName,
          invoiceNumber,
          invoiceType,
          invoiceDate: new Date(data.invoiceDate),
          invoiceValue,
          placeOfSupply: data.placeOfSupply?.trim() || null,
          reverseCharge: data.reverseCharge?.toUpperCase() === 'Y' ? 'Y' : 'N',
          taxableValue,
          integratedTax,
          centralTax,
          stateUtTax,
          cess,
          totalGst,
          gstrPeriod: parsedPeriod.displayPeriod,
          periodKey: parsedPeriod.periodKey,
          financialYear: parsedPeriod.financialYear,
          filingDate: data.filingDate ? new Date(data.filingDate) : null,
          itcAvailability: data.itcAvailability === 'No' ? 'No' : 'Yes',
          reason: data.reason?.trim() || null,
          applicableTaxRate: data.applicableTaxRate ? Number(data.applicableTaxRate) : 100,
          source: data.source?.trim() || 'GSTR-1',
          irn: data.irn?.trim() || null,
          irnDate: data.irnDate ? new Date(data.irnDate) : null,
          importBatchId: data.importBatchId || null,
          createdBy: userId || null,
        },
      });
    });

    return mapPrismaB2bInvoice(created);
  }

  async updateInvoice(id: string, updates: any, userId?: string): Promise<B2bInvoice> {
    const existing = await this.prisma.b2bInvoice.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('B2B Invoice not found.');

    const newGstin = (updates.supplierGstin || existing.supplierGstin).trim().toUpperCase();
    const newInvoiceNumber = (updates.invoiceNumber || existing.invoiceNumber).trim();
    const newInvoiceType = (updates.invoiceType || existing.invoiceType).trim();

    if (
      newGstin !== existing.supplierGstin ||
      newInvoiceNumber.toUpperCase() !== existing.invoiceNumber.toUpperCase() ||
      newInvoiceType.toUpperCase() !== existing.invoiceType.toUpperCase()
    ) {
      const dup = await this.prisma.b2bInvoice.findFirst({
        where: {
          id: { not: id },
          supplierGstin: { equals: newGstin, mode: 'insensitive' },
          invoiceNumber: { equals: newInvoiceNumber, mode: 'insensitive' },
          invoiceType: { equals: newInvoiceType, mode: 'insensitive' },
        },
      });
      if (dup) {
        throw new ConflictError(
          `Duplicate conflict: Another invoice with number "${newInvoiceNumber}" for supplier "${newGstin}" already exists.`
        );
      }
    }

    let gstrPeriod = existing.gstrPeriod;
    let periodKey = existing.periodKey;
    let financialYear = existing.financialYear;
    if (updates.gstrPeriod !== undefined) {
      const parsed = parseGstrPeriod(updates.gstrPeriod);
      if (!parsed) throw new ValidationError(`Invalid GSTR Period: "${updates.gstrPeriod}"`);
      gstrPeriod = parsed.displayPeriod;
      periodKey = parsed.periodKey;
      financialYear = parsed.financialYear;
    }

    const integratedTax =
      updates.integratedTax !== undefined ? round2(updates.integratedTax) : decimalToNumber(existing.integratedTax);
    const centralTax =
      updates.centralTax !== undefined ? round2(updates.centralTax) : decimalToNumber(existing.centralTax);
    const stateUtTax =
      updates.stateUtTax !== undefined ? round2(updates.stateUtTax) : decimalToNumber(existing.stateUtTax);
    const cess = updates.cess !== undefined ? round2(updates.cess) : decimalToNumber(existing.cess);
    const totalGst = calculateB2bTotalGst({ integratedTax, centralTax, stateUtTax, cess });
    const taxableValue =
      updates.taxableValue !== undefined ? round2(updates.taxableValue) : decimalToNumber(existing.taxableValue);
    let invoiceValue =
      updates.invoiceValue !== undefined ? round2(updates.invoiceValue) : decimalToNumber(existing.invoiceValue);
    if (updates.invoiceValue === undefined && !invoiceValue) {
      invoiceValue = round2(taxableValue + totalGst);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      let supplierId = existing.supplierId;
      let supplierName =
        updates.supplierName !== undefined ? updates.supplierName.trim() : existing.supplierName;

      if (updates.supplierGstin !== undefined) {
        let sup = await tx.supplier.findUnique({ where: { gstin: newGstin } });
        if (!sup) {
          sup = await tx.supplier.create({
            data: {
              gstin: newGstin,
              legalName: updates.supplierName || `SUPPLIER ${newGstin}`,
            },
          });
        }
        supplierId = sup.id;
        supplierName = updates.supplierName || sup.legalName;
      }

      return tx.b2bInvoice.update({
        where: { id },
        data: {
          supplierId,
          supplierGstin: newGstin,
          supplierName,
          invoiceNumber: newInvoiceNumber,
          invoiceType: newInvoiceType,
          ...(updates.invoiceDate !== undefined ? { invoiceDate: new Date(updates.invoiceDate) } : {}),
          invoiceValue,
          ...(updates.placeOfSupply !== undefined ? { placeOfSupply: updates.placeOfSupply?.trim() || null } : {}),
          ...(updates.reverseCharge !== undefined
            ? { reverseCharge: updates.reverseCharge.toUpperCase() === 'Y' ? 'Y' : 'N' }
            : {}),
          taxableValue,
          integratedTax,
          centralTax,
          stateUtTax,
          cess,
          totalGst,
          gstrPeriod,
          periodKey,
          financialYear,
          ...(updates.filingDate !== undefined ? { filingDate: updates.filingDate ? new Date(updates.filingDate) : null } : {}),
          ...(updates.itcAvailability !== undefined
            ? { itcAvailability: updates.itcAvailability === 'No' ? 'No' : 'Yes' }
            : {}),
          ...(updates.reason !== undefined ? { reason: updates.reason?.trim() || null } : {}),
          ...(updates.applicableTaxRate !== undefined ? { applicableTaxRate: Number(updates.applicableTaxRate) } : {}),
          ...(updates.source !== undefined ? { source: updates.source?.trim() || null } : {}),
          ...(updates.irn !== undefined ? { irn: updates.irn?.trim() || null } : {}),
          ...(updates.irnDate !== undefined ? { irnDate: updates.irnDate ? new Date(updates.irnDate) : null } : {}),
          ...(updates.importBatchId !== undefined ? { importBatchId: updates.importBatchId || null } : {}),
          updatedBy: userId || null,
        },
      });
    });

    return mapPrismaB2bInvoice(updated);
  }

  async deleteInvoice(id: string): Promise<boolean> {
    const existing = await this.prisma.b2bInvoice.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return false;
    await this.prisma.b2bInvoice.delete({ where: { id } });
    return true;
  }

  async getMonthlySummaries(financialYear?: string): Promise<B2bMonthlySummary[]> {
    const fy = financialYear && financialYear !== 'ALL' ? financialYear : '2026-27';
    const rows = await this.prisma.b2bInvoice.findMany({ where: { financialYear: fy } });
    return aggregateB2bMonthlySummaries(rows.map(mapPrismaB2bInvoice), fy);
  }

  async getMonthDetail(periodKey: string): Promise<B2bMonthDetail> {
    const rows = await this.prisma.b2bInvoice.findMany({ where: { periodKey } });
    return buildMonthDetailData(periodKey, rows.map(mapPrismaB2bInvoice));
  }

  async getDashboardMetrics(financialYear?: string): Promise<B2bDashboardMetrics> {
    const fy = financialYear && financialYear !== 'ALL' ? financialYear : '2026-27';
    const [invoiceRows, supplierRows] = await Promise.all([
      this.prisma.b2bInvoice.findMany(fy !== 'ALL' ? { where: { financialYear: fy } } : undefined),
      this.prisma.supplier.findMany(),
    ]);
    return aggregateB2bDashboard(
      invoiceRows.map(mapPrismaB2bInvoice),
      supplierRows.map((s) => mapPrismaSupplier(s)),
      fy
    );
  }

  async commitImport(
    batchMeta: { fileName: string; fileSizeBytes?: number },
    previewData: B2bImportPreview,
    mode: 'SKIP_EXISTING' | 'OVERWRITE_EXISTING' | 'INSERT_ALL',
    userId?: string
  ): Promise<{ batchId: string; totalProcessed: number; inserted: number; updated: number; skipped: number }> {
    const rowsToProcess = previewData.allParsedRecords || previewData.sampleRows || [];
    const batchId = `batch-${Date.now()}`;
    const gstrPeriodSummary: Record<string, number> = {};
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    await this.prisma.$transaction(
      async (tx) => {
        await tx.importBatch.create({
          data: {
            id: batchId,
            fileName: batchMeta.fileName,
            fileSizeBytes: batchMeta.fileSizeBytes ? BigInt(batchMeta.fileSizeBytes) : null,
            uploadedBy: userId || null,
            totalRows: rowsToProcess.length,
            successfulRows: 0,
            failedRows: (previewData.errors || []).length,
            duplicateRows: (previewData.duplicates || []).length,
            importStatus: 'PROCESSING',
          },
        });

        const existingSuppliers = await tx.supplier.findMany();
        const supplierByGstin = new Map(existingSuppliers.map((s) => [s.gstin.toUpperCase(), s]));

        const existingInvoices = await tx.b2bInvoice.findMany({
          select: { id: true, supplierGstin: true, invoiceNumber: true, invoiceType: true },
        });
        const invoiceByCompound = new Map(
          existingInvoices.map((inv) => [
            `${inv.supplierGstin.toUpperCase()}_${inv.invoiceNumber.trim().toUpperCase()}_${inv.invoiceType.trim().toUpperCase()}`,
            inv,
          ])
        );

        for (const row of rowsToProcess) {
          const supplierGstin = (row.supplierGstin || '').trim().toUpperCase();
          const invoiceNumber = (row.invoiceNumber || '').trim();
          const invoiceType = (row.invoiceType || 'Regular').trim();

          if (!supplierGstin || !invoiceNumber) {
            skipped++;
            continue;
          }

          const compoundKey = `${supplierGstin}_${invoiceNumber.toUpperCase()}_${invoiceType.toUpperCase()}`;
          const existingInv = invoiceByCompound.get(compoundKey);

          const parsedPeriod =
            (row.periodKey ? parseGstrPeriod(row.periodKey) : null) || parseGstrPeriod(row.gstrPeriod);
          if (!parsedPeriod) {
            skipped++;
            continue;
          }

          let sup = supplierByGstin.get(supplierGstin);
          if (!sup) {
            sup = await tx.supplier.create({
              data: {
                gstin: supplierGstin,
                legalName: row.supplierName || `SUPPLIER ${supplierGstin}`,
                state: row.placeOfSupply?.replace(/^\d+-/, '').trim() || null,
              },
            });
            supplierByGstin.set(supplierGstin, sup);
          }

          const taxableValue = round2(row.taxableValue);
          const integratedTax = round2(row.integratedTax);
          const centralTax = round2(row.centralTax);
          const stateUtTax = round2(row.stateUtTax);
          const cess = round2(row.cess);
          const totalGst = calculateB2bTotalGst({ integratedTax, centralTax, stateUtTax, cess });
          let invoiceValue = round2(row.invoiceValue);
          if (!invoiceValue || invoiceValue === 0) {
            invoiceValue = round2(taxableValue + totalGst);
          }

          if (existingInv) {
            if (mode === 'SKIP_EXISTING' || mode === 'INSERT_ALL') {
              skipped++;
              continue;
            }
            await tx.b2bInvoice.update({
              where: { id: existingInv.id },
              data: {
                supplierId: sup.id,
                supplierName: sup.legalName,
                invoiceDate: new Date(row.invoiceDate),
                invoiceValue,
                placeOfSupply: row.placeOfSupply?.trim() || null,
                reverseCharge: row.reverseCharge === 'Y' ? 'Y' : 'N',
                taxableValue,
                integratedTax,
                centralTax,
                stateUtTax,
                cess,
                totalGst,
                gstrPeriod: parsedPeriod.displayPeriod,
                periodKey: parsedPeriod.periodKey,
                financialYear: parsedPeriod.financialYear,
                filingDate: row.filingDate ? new Date(row.filingDate) : null,
                itcAvailability: row.itcAvailability === 'No' ? 'No' : 'Yes',
                reason: row.reason?.trim() || null,
                applicableTaxRate: row.applicableTaxRate ? Number(row.applicableTaxRate) : 100,
                source: row.source?.trim() || 'GSTR-1',
                irn: row.irn?.trim() || null,
                irnDate: row.irnDate ? new Date(row.irnDate) : null,
                importBatchId: batchId,
                updatedBy: userId || null,
              },
            });
            updated++;
            gstrPeriodSummary[parsedPeriod.periodKey] = (gstrPeriodSummary[parsedPeriod.periodKey] || 0) + 1;
            continue;
          }

          const createdInv = await tx.b2bInvoice.create({
            data: {
              supplierId: sup.id,
              supplierGstin,
              supplierName: sup.legalName,
              invoiceNumber,
              invoiceType,
              invoiceDate: new Date(row.invoiceDate),
              invoiceValue,
              placeOfSupply: row.placeOfSupply?.trim() || null,
              reverseCharge: row.reverseCharge === 'Y' ? 'Y' : 'N',
              taxableValue,
              integratedTax,
              centralTax,
              stateUtTax,
              cess,
              totalGst,
              gstrPeriod: parsedPeriod.displayPeriod,
              periodKey: parsedPeriod.periodKey,
              financialYear: parsedPeriod.financialYear,
              filingDate: row.filingDate ? new Date(row.filingDate) : null,
              itcAvailability: row.itcAvailability === 'No' ? 'No' : 'Yes',
              reason: row.reason?.trim() || null,
              applicableTaxRate: row.applicableTaxRate ? Number(row.applicableTaxRate) : 100,
              source: row.source?.trim() || 'GSTR-1',
              irn: row.irn?.trim() || null,
              irnDate: row.irnDate ? new Date(row.irnDate) : null,
              importBatchId: batchId,
              createdBy: userId || null,
            },
          });
          invoiceByCompound.set(compoundKey, {
            id: createdInv.id,
            supplierGstin,
            invoiceNumber,
            invoiceType,
          });
          inserted++;
          gstrPeriodSummary[parsedPeriod.periodKey] = (gstrPeriodSummary[parsedPeriod.periodKey] || 0) + 1;
        }

        await tx.importBatch.update({
          where: { id: batchId },
          data: {
            successfulRows: inserted + updated,
            importStatus: inserted + updated > 0 ? 'COMPLETED' : 'FAILED',
            gstrPeriodSummary,
          },
        });
      },
      { timeout: 60000 }
    );

    return {
      batchId,
      totalProcessed: rowsToProcess.length,
      inserted,
      updated,
      skipped,
    };
  }

  async getImportBatches(): Promise<ImportBatch[]> {
    const rows = await this.prisma.importBatch.findMany({ orderBy: { uploadedAt: 'desc' } });
    return rows.map(mapPrismaImportBatch);
  }
}

export class JsonB2bGstRepository implements IB2bGstRepository {
  async getSuppliers(search?: string): Promise<Supplier[]> {
    const state = jsonStore.getState();
    const invoices = state.b2bInvoices || [];
    const searchLower = (search || '').trim().toLowerCase();

    return (state.suppliers || [])
      .map((sup) => {
        const supInvoices = invoices.filter(
          (inv) => inv.supplierId === sup.id || inv.supplierGstin.toUpperCase() === sup.gstin.toUpperCase()
        );
        const latestInvoiceDate =
          supInvoices.length > 0
            ? [...supInvoices].sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate))[0].invoiceDate
            : undefined;

        return {
          ...sup,
          invoiceCount: supInvoices.length,
          totalInvoiceValue: sumMoney(supInvoices.map((inv) => inv.invoiceValue || 0)),
          totalTaxableValue: sumMoney(supInvoices.map((inv) => inv.taxableValue || 0)),
          totalGst: sumMoney(supInvoices.map((inv) => inv.totalGst || 0)),
          latestInvoiceDate,
        };
      })
      .filter((sup) => {
        if (!searchLower) return true;
        return (
          sup.legalName.toLowerCase().includes(searchLower) ||
          sup.gstin.toLowerCase().includes(searchLower) ||
          Boolean(sup.tradeName && sup.tradeName.toLowerCase().includes(searchLower)) ||
          Boolean(sup.state && sup.state.toLowerCase().includes(searchLower))
        );
      })
      .sort((a, b) => a.legalName.localeCompare(b.legalName));
  }

  async getSupplierById(id: string): Promise<Supplier | null> {
    const list = await this.getSuppliers();
    return list.find((s) => s.id === id) || null;
  }

  async getSupplierByGstin(gstin: string): Promise<Supplier | null> {
    const clean = gstin.trim().toUpperCase();
    return (jsonStore.getState().suppliers || []).find((s) => s.gstin.toUpperCase() === clean) || null;
  }

  async createSupplier(data: {
    gstin: string;
    legalName: string;
    tradeName?: string;
    address?: string;
    state?: string;
  }): Promise<Supplier> {
    const state = jsonStore.getState();
    const gstin = data.gstin.trim().toUpperCase();
    if (!gstin || gstin.length !== 15) {
      throw new ValidationError('Valid 15-character GSTIN is required.');
    }
    const legalName = data.legalName.trim();
    if (!legalName) {
      throw new ValidationError('Supplier legal name is required.');
    }

    const existing = (state.suppliers || []).find((s) => s.gstin.toUpperCase() === gstin);
    if (existing) {
      throw new ConflictError(`Supplier with GSTIN "${gstin}" already exists (${existing.legalName}).`);
    }

    const now = new Date().toISOString();
    const newSupplier: Supplier = {
      id: `sup-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      gstin,
      legalName,
      tradeName: data.tradeName?.trim() || undefined,
      address: data.address?.trim() || undefined,
      state: data.state?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };

    if (!state.suppliers) state.suppliers = [];
    state.suppliers.push(newSupplier);
    jsonStore.save();
    return newSupplier;
  }

  async updateSupplier(
    id: string,
    updates: Partial<{ legalName: string; tradeName?: string; address?: string; state?: string }>
  ): Promise<Supplier> {
    const state = jsonStore.getState();
    const supplier = (state.suppliers || []).find((s) => s.id === id);
    if (!supplier) throw new NotFoundError('Supplier not found.');

    if (updates.legalName !== undefined) {
      const name = updates.legalName.trim();
      if (!name) throw new ValidationError('Legal name cannot be empty.');
      supplier.legalName = name;

      for (const inv of state.b2bInvoices || []) {
        if (inv.supplierId === id || inv.supplierGstin.toUpperCase() === supplier.gstin.toUpperCase()) {
          inv.supplierName = name;
        }
      }
    }

    if (updates.tradeName !== undefined) supplier.tradeName = updates.tradeName.trim() || undefined;
    if (updates.address !== undefined) supplier.address = updates.address.trim() || undefined;
    if (updates.state !== undefined) supplier.state = updates.state.trim() || undefined;

    supplier.updatedAt = new Date().toISOString();
    jsonStore.save();
    return supplier;
  }

  async deleteSupplier(id: string): Promise<boolean> {
    const state = jsonStore.getState();
    const supplier = (state.suppliers || []).find((s) => s.id === id);
    if (!supplier) return false;

    const hasLinked = (state.b2bInvoices || []).some(
      (inv) => inv.supplierId === id || inv.supplierGstin.toUpperCase() === supplier.gstin.toUpperCase()
    );
    if (hasLinked) {
      throw new ConflictError(`Cannot delete supplier "${supplier.legalName}" as it has linked B2B invoices.`);
    }

    const idx = state.suppliers.findIndex((s) => s.id === id);
    if (idx !== -1) {
      state.suppliers.splice(idx, 1);
      jsonStore.save();
      return true;
    }
    return false;
  }

  async getInvoices(filters?: B2bInvoicesFilter): Promise<B2bInvoicesPage> {
    return filterSortAndPaginateB2bInvoices(jsonStore.getState().b2bInvoices || [], filters);
  }

  async getInvoiceById(id: string): Promise<B2bInvoice | null> {
    return (jsonStore.getState().b2bInvoices || []).find((inv) => inv.id === id) || null;
  }

  async createInvoice(data: any, userId?: string): Promise<B2bInvoice> {
    const state = jsonStore.getState();
    const supplierGstin = (data.supplierGstin || '').trim().toUpperCase();
    if (!supplierGstin || supplierGstin.length !== 15) {
      throw new ValidationError('Valid 15-character Supplier GSTIN is required.');
    }
    const invoiceNumber = (data.invoiceNumber || '').trim();
    if (!invoiceNumber) {
      throw new ValidationError('Invoice Number is required.');
    }
    const invoiceType = (data.invoiceType || 'Regular').trim();

    const existing = (state.b2bInvoices || []).find(
      (inv) =>
        inv.supplierGstin.toUpperCase() === supplierGstin &&
        inv.invoiceNumber.trim().toUpperCase() === invoiceNumber.toUpperCase() &&
        inv.invoiceType.trim().toUpperCase() === invoiceType.toUpperCase()
    );
    if (existing) {
      throw new ConflictError(
        `Duplicate invoice detected: Invoice "${invoiceNumber}" for supplier "${supplierGstin}" already exists in GSTR Period ${existing.gstrPeriod}.`
      );
    }

    const parsedPeriod = parseGstrPeriod(data.gstrPeriod);
    if (!parsedPeriod) {
      throw new ValidationError(
        `Invalid GSTR Period: "${data.gstrPeriod}". Must be a valid period like "August 2026", "2026-08", or "08-2026".`
      );
    }

    let supplier = await this.getSupplierByGstin(supplierGstin);
    if (!supplier) {
      const supplierName = (data.supplierName || `SUPPLIER ${supplierGstin}`).trim();
      const supState = data.placeOfSupply?.replace(/^\d+-/, '').trim() || undefined;
      supplier = await this.createSupplier({
        gstin: supplierGstin,
        legalName: supplierName,
        tradeName: supplierName,
        state: supState,
      });
    }

    const taxableValue = round2(data.taxableValue);
    const integratedTax = round2(data.integratedTax);
    const centralTax = round2(data.centralTax);
    const stateUtTax = round2(data.stateUtTax);
    const cess = round2(data.cess);
    const totalGst = calculateB2bTotalGst({ integratedTax, centralTax, stateUtTax, cess });

    let invoiceValue = round2(data.invoiceValue);
    if (!invoiceValue || invoiceValue === 0) {
      invoiceValue = round2(taxableValue + totalGst);
    }

    const now = new Date().toISOString();
    const newInvoice: B2bInvoice = {
      id: `b2b-inv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      supplierId: supplier.id,
      supplierGstin,
      supplierName: supplier.legalName,
      invoiceNumber,
      invoiceType,
      invoiceDate: data.invoiceDate,
      invoiceValue,
      placeOfSupply: data.placeOfSupply?.trim() || undefined,
      reverseCharge: data.reverseCharge?.toUpperCase() === 'Y' ? 'Y' : 'N',
      taxableValue,
      integratedTax,
      centralTax,
      stateUtTax,
      cess,
      totalGst,
      gstrPeriod: parsedPeriod.displayPeriod,
      periodKey: parsedPeriod.periodKey,
      financialYear: parsedPeriod.financialYear,
      filingDate: data.filingDate || undefined,
      itcAvailability: data.itcAvailability === 'No' ? 'No' : 'Yes',
      reason: data.reason?.trim() || undefined,
      applicableTaxRate: data.applicableTaxRate ? Number(data.applicableTaxRate) : 100,
      source: data.source?.trim() || 'GSTR-1',
      irn: data.irn?.trim() || undefined,
      irnDate: data.irnDate || undefined,
      importBatchId: data.importBatchId || undefined,
      createdBy: userId || undefined,
      createdAt: now,
      updatedAt: now,
    };

    if (!state.b2bInvoices) state.b2bInvoices = [];
    state.b2bInvoices.unshift(newInvoice);
    jsonStore.save();
    return newInvoice;
  }

  async updateInvoice(id: string, updates: any, userId?: string): Promise<B2bInvoice> {
    const state = jsonStore.getState();
    const invoice = (state.b2bInvoices || []).find((inv) => inv.id === id);
    if (!invoice) throw new NotFoundError('B2B Invoice not found.');

    const newGstin = (updates.supplierGstin || invoice.supplierGstin).trim().toUpperCase();
    const newInvoiceNumber = (updates.invoiceNumber || invoice.invoiceNumber).trim();
    const newInvoiceType = (updates.invoiceType || invoice.invoiceType).trim();

    if (
      newGstin !== invoice.supplierGstin ||
      newInvoiceNumber.toUpperCase() !== invoice.invoiceNumber.toUpperCase() ||
      newInvoiceType.toUpperCase() !== invoice.invoiceType.toUpperCase()
    ) {
      const dup = (state.b2bInvoices || []).find(
        (inv) =>
          inv.id !== id &&
          inv.supplierGstin.toUpperCase() === newGstin &&
          inv.invoiceNumber.trim().toUpperCase() === newInvoiceNumber.toUpperCase() &&
          inv.invoiceType.trim().toUpperCase() === newInvoiceType.toUpperCase()
      );
      if (dup) {
        throw new ConflictError(
          `Duplicate conflict: Another invoice with number "${newInvoiceNumber}" for supplier "${newGstin}" already exists.`
        );
      }
    }

    if (updates.gstrPeriod !== undefined) {
      const parsed = parseGstrPeriod(updates.gstrPeriod);
      if (!parsed) throw new ValidationError(`Invalid GSTR Period: "${updates.gstrPeriod}"`);
      invoice.gstrPeriod = parsed.displayPeriod;
      invoice.periodKey = parsed.periodKey;
      invoice.financialYear = parsed.financialYear;
    }

    if (updates.supplierGstin !== undefined) {
      invoice.supplierGstin = newGstin;
      let sup = await this.getSupplierByGstin(newGstin);
      if (!sup) {
        sup = await this.createSupplier({
          gstin: newGstin,
          legalName: updates.supplierName || `SUPPLIER ${newGstin}`,
        });
      }
      invoice.supplierId = sup.id;
      invoice.supplierName = updates.supplierName || sup.legalName;
    } else if (updates.supplierName !== undefined) {
      invoice.supplierName = updates.supplierName.trim();
    }

    if (updates.invoiceNumber !== undefined) invoice.invoiceNumber = newInvoiceNumber;
    if (updates.invoiceType !== undefined) invoice.invoiceType = newInvoiceType;
    if (updates.invoiceDate !== undefined) invoice.invoiceDate = updates.invoiceDate;
    if (updates.placeOfSupply !== undefined) invoice.placeOfSupply = updates.placeOfSupply.trim() || undefined;
    if (updates.reverseCharge !== undefined) {
      invoice.reverseCharge = updates.reverseCharge.toUpperCase() === 'Y' ? 'Y' : 'N';
    }
    if (updates.taxableValue !== undefined) invoice.taxableValue = round2(updates.taxableValue);
    if (updates.integratedTax !== undefined) invoice.integratedTax = round2(updates.integratedTax);
    if (updates.centralTax !== undefined) invoice.centralTax = round2(updates.centralTax);
    if (updates.stateUtTax !== undefined) invoice.stateUtTax = round2(updates.stateUtTax);
    if (updates.cess !== undefined) invoice.cess = round2(updates.cess);

    invoice.totalGst = calculateB2bTotalGst({
      integratedTax: invoice.integratedTax,
      centralTax: invoice.centralTax,
      stateUtTax: invoice.stateUtTax,
      cess: invoice.cess,
    });

    if (updates.invoiceValue !== undefined) {
      invoice.invoiceValue = round2(updates.invoiceValue);
    } else if (updates.taxableValue !== undefined || updates.integratedTax !== undefined) {
      if (!invoice.invoiceValue) invoice.invoiceValue = round2(invoice.taxableValue + invoice.totalGst);
    }

    if (updates.filingDate !== undefined) invoice.filingDate = updates.filingDate || undefined;
    if (updates.itcAvailability !== undefined) {
      invoice.itcAvailability = updates.itcAvailability === 'No' ? 'No' : 'Yes';
    }
    if (updates.reason !== undefined) invoice.reason = updates.reason.trim() || undefined;
    if (updates.applicableTaxRate !== undefined) invoice.applicableTaxRate = Number(updates.applicableTaxRate);
    if (updates.source !== undefined) invoice.source = updates.source.trim() || undefined;
    if (updates.irn !== undefined) invoice.irn = updates.irn.trim() || undefined;
    if (updates.irnDate !== undefined) invoice.irnDate = updates.irnDate || undefined;
    if (updates.importBatchId !== undefined) invoice.importBatchId = updates.importBatchId || undefined;

    invoice.updatedBy = userId || undefined;
    invoice.updatedAt = new Date().toISOString();

    jsonStore.save();
    return invoice;
  }

  async deleteInvoice(id: string): Promise<boolean> {
    const state = jsonStore.getState();
    const idx = (state.b2bInvoices || []).findIndex((inv) => inv.id === id);
    if (idx === -1) return false;
    state.b2bInvoices.splice(idx, 1);
    jsonStore.save();
    return true;
  }

  async getMonthlySummaries(financialYear?: string): Promise<B2bMonthlySummary[]> {
    const fy = financialYear && financialYear !== 'ALL' ? financialYear : '2026-27';
    return aggregateB2bMonthlySummaries(jsonStore.getState().b2bInvoices || [], fy);
  }

  async getMonthDetail(periodKey: string): Promise<B2bMonthDetail> {
    return buildMonthDetailData(periodKey, jsonStore.getState().b2bInvoices || []);
  }

  async getDashboardMetrics(financialYear?: string): Promise<B2bDashboardMetrics> {
    const fy = financialYear && financialYear !== 'ALL' ? financialYear : '2026-27';
    const state = jsonStore.getState();
    return aggregateB2bDashboard(state.b2bInvoices || [], state.suppliers || [], fy);
  }

  async commitImport(
    batchMeta: { fileName: string; fileSizeBytes?: number },
    previewData: B2bImportPreview,
    mode: 'SKIP_EXISTING' | 'OVERWRITE_EXISTING' | 'INSERT_ALL',
    userId?: string
  ): Promise<{ batchId: string; totalProcessed: number; inserted: number; updated: number; skipped: number }> {
    return jsonStore.runInTransaction(async (state) => {
      const batchId = `batch-${Date.now()}`;
      let inserted = 0;
      let updated = 0;
      let skipped = 0;

      const gstrPeriodSummary: Record<string, number> = {};
      const rowsToProcess = previewData.allParsedRecords || previewData.sampleRows || [];
      if (!state.b2bInvoices) state.b2bInvoices = [];
      if (!state.suppliers) state.suppliers = [];

      for (const row of rowsToProcess) {
        const supplierGstin = (row.supplierGstin || '').trim().toUpperCase();
        const invoiceNumber = (row.invoiceNumber || '').trim();
        const invoiceType = (row.invoiceType || 'Regular').trim();

        if (!supplierGstin || !invoiceNumber) {
          skipped++;
          continue;
        }

        const existingIndex = state.b2bInvoices.findIndex(
          (inv) =>
            inv.supplierGstin.toUpperCase() === supplierGstin &&
            inv.invoiceNumber.trim().toUpperCase() === invoiceNumber.toUpperCase() &&
            inv.invoiceType.trim().toUpperCase() === invoiceType.toUpperCase()
        );

        if (existingIndex !== -1) {
          if (mode === 'SKIP_EXISTING') {
            skipped++;
            continue;
          } else if (mode === 'OVERWRITE_EXISTING') {
            const existingInv = state.b2bInvoices[existingIndex];
            await this.updateInvoice(existingInv.id, { ...row, importBatchId: batchId }, userId);
            updated++;
            gstrPeriodSummary[row.periodKey] = (gstrPeriodSummary[row.periodKey] || 0) + 1;
            continue;
          }
        }

        const parsedPeriod =
          (row.periodKey ? parseGstrPeriod(row.periodKey) : null) || parseGstrPeriod(row.gstrPeriod);
        if (!parsedPeriod) {
          skipped++;
          continue;
        }

        let sup = state.suppliers.find((s) => s.gstin.toUpperCase() === supplierGstin);
        if (!sup) {
          const now = new Date().toISOString();
          sup = {
            id: `sup-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            gstin: supplierGstin,
            legalName: row.supplierName || `SUPPLIER ${supplierGstin}`,
            state: row.placeOfSupply?.replace(/^\d+-/, '').trim() || undefined,
            createdAt: now,
            updatedAt: now,
          };
          state.suppliers.push(sup);
        }

        const taxableValue = round2(row.taxableValue);
        const integratedTax = round2(row.integratedTax);
        const centralTax = round2(row.centralTax);
        const stateUtTax = round2(row.stateUtTax);
        const cess = round2(row.cess);
        const totalGst = calculateB2bTotalGst({ integratedTax, centralTax, stateUtTax, cess });
        let invoiceValue = round2(row.invoiceValue);
        if (!invoiceValue || invoiceValue === 0) {
          invoiceValue = round2(taxableValue + totalGst);
        }

        const now = new Date().toISOString();
        const newInv: B2bInvoice = {
          id: `b2b-inv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          supplierId: sup.id,
          supplierGstin,
          supplierName: sup.legalName,
          invoiceNumber,
          invoiceType,
          invoiceDate: row.invoiceDate,
          invoiceValue,
          placeOfSupply: row.placeOfSupply?.trim() || undefined,
          reverseCharge: row.reverseCharge === 'Y' ? 'Y' : 'N',
          taxableValue,
          integratedTax,
          centralTax,
          stateUtTax,
          cess,
          totalGst,
          gstrPeriod: parsedPeriod.displayPeriod,
          periodKey: parsedPeriod.periodKey,
          financialYear: parsedPeriod.financialYear,
          filingDate: row.filingDate || undefined,
          itcAvailability: row.itcAvailability === 'No' ? 'No' : 'Yes',
          reason: row.reason?.trim() || undefined,
          applicableTaxRate: row.applicableTaxRate ? Number(row.applicableTaxRate) : 100,
          source: row.source?.trim() || 'GSTR-1',
          irn: row.irn?.trim() || undefined,
          irnDate: row.irnDate || undefined,
          importBatchId: batchId,
          createdBy: userId || undefined,
          createdAt: now,
          updatedAt: now,
        };

        state.b2bInvoices.unshift(newInv);
        inserted++;
        gstrPeriodSummary[parsedPeriod.periodKey] = (gstrPeriodSummary[parsedPeriod.periodKey] || 0) + 1;
      }

      const batchRecord: ImportBatch = {
        id: batchId,
        fileName: batchMeta.fileName,
        fileSizeBytes: batchMeta.fileSizeBytes,
        uploadedAt: new Date().toISOString(),
        uploadedBy: userId,
        totalRows: rowsToProcess.length,
        successfulRows: inserted + updated,
        failedRows: (previewData.errors || []).length,
        duplicateRows: (previewData.duplicates || []).length,
        importStatus: inserted + updated > 0 ? 'COMPLETED' : 'FAILED',
        gstrPeriodSummary,
      };

      if (!state.importBatches) state.importBatches = [];
      state.importBatches.unshift(batchRecord);

      return {
        batchId,
        totalProcessed: rowsToProcess.length,
        inserted,
        updated,
        skipped,
      };
    });
  }

  async getImportBatches(): Promise<ImportBatch[]> {
    return jsonStore.getState().importBatches || [];
  }
}
