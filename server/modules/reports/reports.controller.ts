/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import { ValidationError } from '../../domain/errors/AppError.ts';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import { validateDocumentContent } from '../../middleware/upload.ts';
import type { ReportsService } from './reports.service.ts';

export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  dashboard = async (req: AuthenticatedRequest, res: Response) => {
    const fyId = req.query.financialYearId ? String(req.query.financialYearId) : undefined;
    res.json(await this.reportsService.getDashboardMetrics(fyId));
  };

  exportExcel = async (req: AuthenticatedRequest, res: Response) => {
    const fyId = req.query.financialYearId ? String(req.query.financialYearId) : undefined;
    const { buffer, filename } = await this.reportsService.exportWorkbook(fyId);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  };

  exportCsv = async (req: AuthenticatedRequest, res: Response) => {
    const sheet = String(req.query.sheet || 'Export Tracker');
    const fyId = req.query.financialYearId ? String(req.query.financialYearId) : undefined;
    const { csv, filename } = await this.reportsService.exportCsv(sheet, fyId);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csv);
  };

  importExcel = async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      throw new ValidationError('Please upload an Excel workbook (.xlsx or .xlsm) or CSV file (.csv).');
    }
    if (!validateDocumentContent(req.file.buffer, req.file.originalname)) {
      throw new ValidationError(`Invalid or corrupted spreadsheet content for "${req.file.originalname}".`);
    }
    const fyId = req.body?.financialYearId ? String(req.body.financialYearId) : undefined;
    const report = await this.reportsService.importHistoricalMigration(req.file.buffer, fyId, req.user!.id);
    res.json(report);
  };
}
