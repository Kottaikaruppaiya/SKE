/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  B2bDashboardMetrics,
  B2bImportPreview,
  B2bInvoice,
  B2bMonthlySummary,
  ImportBatch,
  Supplier,
} from '../../../shared/contracts/index.ts';
import {
  generateB2bExcelExport,
  generateB2bMonthlySummaryExcel,
  previewB2bWorkbook,
} from '../../b2b_excel.ts';
import { NotFoundError } from '../../domain/errors/AppError.ts';
import type { IMastersRepository } from '../masters/masters.repository.ts';
import type {
  B2bInvoicesFilter,
  B2bInvoicesPage,
  B2bMonthDetail,
  IB2bGstRepository,
} from './b2bGst.repository.ts';

export class B2bGstService {
  constructor(
    private readonly b2bRepo: IB2bGstRepository,
    private readonly mastersRepo: IMastersRepository
  ) {}

  getDashboardMetrics(financialYear?: string): Promise<B2bDashboardMetrics> {
    return this.b2bRepo.getDashboardMetrics(financialYear);
  }

  getMonthlySummaries(financialYear?: string): Promise<B2bMonthlySummary[]> {
    return this.b2bRepo.getMonthlySummaries(financialYear);
  }

  getMonthDetail(periodKey: string): Promise<B2bMonthDetail> {
    return this.b2bRepo.getMonthDetail(periodKey);
  }

  getInvoices(filters?: B2bInvoicesFilter): Promise<B2bInvoicesPage> {
    return this.b2bRepo.getInvoices(filters);
  }

  async getInvoiceById(id: string): Promise<B2bInvoice> {
    const invoice = await this.b2bRepo.getInvoiceById(id);
    if (!invoice) throw new NotFoundError('B2B Invoice not found.');
    return invoice;
  }

  createInvoice(data: any, userId?: string): Promise<B2bInvoice> {
    return this.b2bRepo.createInvoice(data, userId);
  }

  updateInvoice(id: string, updates: any, userId?: string): Promise<B2bInvoice> {
    return this.b2bRepo.updateInvoice(id, updates, userId);
  }

  async deleteInvoice(id: string): Promise<boolean> {
    const ok = await this.b2bRepo.deleteInvoice(id);
    if (!ok) throw new NotFoundError('B2B invoice not found or already deleted.');
    return true;
  }

  getSuppliers(search?: string): Promise<Supplier[]> {
    return this.b2bRepo.getSuppliers(search);
  }

  async getSupplierById(id: string): Promise<Supplier> {
    const supplier = await this.b2bRepo.getSupplierById(id);
    if (!supplier) throw new NotFoundError('Supplier not found.');
    return supplier;
  }

  createSupplier(data: {
    gstin: string;
    legalName: string;
    tradeName?: string;
    address?: string;
    state?: string;
  }): Promise<Supplier> {
    return this.b2bRepo.createSupplier(data);
  }

  updateSupplier(
    id: string,
    updates: Partial<{ legalName: string; tradeName?: string; address?: string; state?: string }>
  ): Promise<Supplier> {
    return this.b2bRepo.updateSupplier(id, updates);
  }

  async deleteSupplier(id: string): Promise<boolean> {
    const ok = await this.b2bRepo.deleteSupplier(id);
    if (!ok) throw new NotFoundError('Supplier not found.');
    return true;
  }

  async previewImport(buffer: Buffer, fileName: string): Promise<B2bImportPreview> {
    const [invoicesPage, suppliers] = await Promise.all([
      this.b2bRepo.getInvoices({ limit: 0 }),
      this.b2bRepo.getSuppliers(),
    ]);
    return previewB2bWorkbook(buffer, fileName, invoicesPage.data, suppliers);
  }

  commitImport(
    batchMeta: { fileName: string; fileSizeBytes?: number },
    previewData: B2bImportPreview,
    mode: 'SKIP_EXISTING' | 'OVERWRITE_EXISTING' | 'INSERT_ALL',
    userId?: string
  ) {
    return this.b2bRepo.commitImport(batchMeta, previewData, mode, userId);
  }

  getImportBatches(): Promise<ImportBatch[]> {
    return this.b2bRepo.getImportBatches();
  }

  async exportExcel(params: {
    reportType?: string;
    periodKey?: string;
    financialYear?: string;
    supplierGstin?: string;
  }): Promise<{ buffer: Buffer; filename: string }> {
    const dateStamp = new Date().toISOString().split('T')[0];

    if (params.reportType === 'monthly_summary') {
      const fy = params.financialYear || (await this.mastersRepo.findCurrentFinancialYear()).label;
      const summaries = await this.b2bRepo.getMonthlySummaries(fy);
      const buffer = generateB2bMonthlySummaryExcel(summaries, fy);
      return {
        buffer,
        filename: `SKE_B2B_Monthly_Summary_${fy}_${dateStamp}.xlsx`,
      };
    }

    const { data: invoices } = await this.b2bRepo.getInvoices({
      periodKey: params.periodKey !== 'ALL' ? params.periodKey : undefined,
      financialYear: params.financialYear !== 'ALL' ? params.financialYear : undefined,
      supplierGstin: params.supplierGstin !== 'ALL' ? params.supplierGstin : undefined,
      limit: 0,
    });

    const title =
      params.periodKey && params.periodKey !== 'ALL'
        ? `B2B Invoices - ${params.periodKey}`
        : 'B2B Invoices - Register';
    const buffer = generateB2bExcelExport(invoices, title);
    return {
      buffer,
      filename: `SKE_B2B_Register_${params.periodKey || params.financialYear || 'All'}_${dateStamp}.xlsx`,
    };
  }
}
