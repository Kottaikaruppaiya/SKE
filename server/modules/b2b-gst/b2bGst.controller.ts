/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { B2bImportPreview } from '../../../shared/contracts/index.ts';
import { ValidationError } from '../../domain/errors/AppError.ts';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import { validateDocumentContent } from '../../middleware/upload.ts';
import type { B2bGstService } from './b2bGst.service.ts';
import {
  validateCommitB2bImport,
  validateCreateSupplier,
  validateUpdateSupplier,
} from './b2bGst.validator.ts';

export class B2bGstController {
  constructor(private readonly b2bService: B2bGstService) {}

  dashboard = async (req: AuthenticatedRequest, res: Response) => {
    const financialYear = req.query.financialYear ? String(req.query.financialYear) : undefined;
    res.json(await this.b2bService.getDashboardMetrics(financialYear));
  };

  monthly = async (req: AuthenticatedRequest, res: Response) => {
    const financialYear = req.query.financialYear ? String(req.query.financialYear) : undefined;
    res.json(await this.b2bService.getMonthlySummaries(financialYear));
  };

  monthDetail = async (req: AuthenticatedRequest, res: Response) => {
    res.json(await this.b2bService.getMonthDetail(req.params.periodKey));
  };

  listInvoices = async (req: AuthenticatedRequest, res: Response) => {
    const {
      periodKey,
      financialYear,
      supplierGstin,
      invoiceType,
      reverseCharge,
      itcAvailability,
      search,
      page,
      limit,
      sortBy,
      sortOrder,
    } = req.query as Record<string, any>;

    const result = await this.b2bService.getInvoices({
      periodKey,
      financialYear,
      supplierGstin,
      invoiceType,
      reverseCharge,
      itcAvailability,
      search,
      page: page ? parseInt(String(page), 10) : undefined,
      limit: limit !== undefined ? parseInt(String(limit), 10) : 50,
      sortBy,
      sortOrder,
    });
    res.json(result);
  };

  getInvoice = async (req: AuthenticatedRequest, res: Response) => {
    res.json(await this.b2bService.getInvoiceById(req.params.id));
  };

  createInvoice = async (req: AuthenticatedRequest, res: Response) => {
    const created = await this.b2bService.createInvoice(req.body, req.user!.id);
    res.status(201).json(created);
  };

  updateInvoice = async (req: AuthenticatedRequest, res: Response) => {
    const updated = await this.b2bService.updateInvoice(req.params.id, req.body, req.user!.id);
    res.json(updated);
  };

  deleteInvoice = async (req: AuthenticatedRequest, res: Response) => {
    await this.b2bService.deleteInvoice(req.params.id);
    res.json({ success: true, message: 'B2B invoice deleted successfully.' });
  };

  listSuppliers = async (req: AuthenticatedRequest, res: Response) => {
    const search = req.query.search ? String(req.query.search) : undefined;
    res.json(await this.b2bService.getSuppliers(search));
  };

  getSupplier = async (req: AuthenticatedRequest, res: Response) => {
    res.json(await this.b2bService.getSupplierById(req.params.id));
  };

  createSupplier = async (req: AuthenticatedRequest, res: Response) => {
    const payload = validateCreateSupplier(req.body);
    const created = await this.b2bService.createSupplier(payload);
    res.status(201).json(created);
  };

  updateSupplier = async (req: AuthenticatedRequest, res: Response) => {
    const payload = validateUpdateSupplier(req.body);
    const updated = await this.b2bService.updateSupplier(req.params.id, payload);
    res.json(updated);
  };

  deleteSupplier = async (req: AuthenticatedRequest, res: Response) => {
    await this.b2bService.deleteSupplier(req.params.id);
    res.json({ success: true, message: 'Supplier deleted successfully.' });
  };

  previewImport = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      throw new ValidationError('Please upload an Excel workbook (.xlsx, .xls) or CSV file (.csv).');
    }
    if (!validateDocumentContent(req.file.buffer, req.file.originalname)) {
      throw new ValidationError(`Invalid or corrupted spreadsheet content for "${req.file.originalname}".`);
    }
    const preview = await this.b2bService.previewImport(req.file.buffer, req.file.originalname);
    res.json(preview);
  };

  commitImport = async (req: AuthenticatedRequest, res: Response) => {
    const payload = validateCommitB2bImport(req.body);
    const result = await this.b2bService.commitImport(
      { fileName: payload.fileName || 'Imported_Workbook.xlsx', fileSizeBytes: payload.fileSizeBytes },
      payload.previewData as unknown as B2bImportPreview,
      payload.mode,
      req.user!.id
    );
    res.json(result);
  };

  listBatches = async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await this.b2bService.getImportBatches());
  };

  exportExcel = async (req: AuthenticatedRequest, res: Response) => {
    const { reportType, periodKey, financialYear, supplierGstin } = req.query as Record<string, any>;
    const { buffer, filename } = await this.b2bService.exportExcel({
      reportType,
      periodKey,
      financialYear,
      supplierGstin,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  };
}
