/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response } from 'express';
import type { GstResult } from '../../../shared/contracts/index.ts';
import type { GstEntriesService } from './gstEntries.service.ts';
import { validateCreateGstEntry, validateUpdateGstEntry } from './gstEntries.validator.ts';

export class GstEntriesController {
  constructor(private readonly gstService: GstEntriesService) {}

  list = async (req: Request, res: Response) => {
    const data = await this.gstService.list({
      consigneeId: req.query.consigneeId ? String(req.query.consigneeId) : undefined,
      result: req.query.result ? (String(req.query.result) as GstResult) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
      startDate: req.query.startDate ? String(req.query.startDate) : undefined,
      endDate: req.query.endDate ? String(req.query.endDate) : undefined,
      page: req.query.page ? parseInt(String(req.query.page), 10) : undefined,
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
      sortBy: req.query.sortBy ? (String(req.query.sortBy) as any) : undefined,
      sortOrder: req.query.sortOrder ? (String(req.query.sortOrder) as any) : undefined,
    });
    res.json(data);
  };

  summary = async (req: Request, res: Response) => {
    const data = await this.gstService.getSummary({
      consigneeId: req.query.consigneeId ? String(req.query.consigneeId) : undefined,
      startDate: req.query.startDate ? String(req.query.startDate) : undefined,
      endDate: req.query.endDate ? String(req.query.endDate) : undefined,
    });
    res.json(data);
  };

  exportExcel = async (req: Request, res: Response) => {
    const buffer = await this.gstService.exportExcel({
      consigneeId: req.query.consigneeId ? String(req.query.consigneeId) : undefined,
      result: req.query.result ? (String(req.query.result) as GstResult) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
      startDate: req.query.startDate ? String(req.query.startDate) : undefined,
      endDate: req.query.endDate ? String(req.query.endDate) : undefined,
    });
    const filename = `SKE_GST_Entries_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  };

  getById = async (req: Request, res: Response) => {
    const entry = await this.gstService.getById(req.params.id);
    res.json(entry);
  };

  create = async (req: Request, res: Response) => {
    const payload = validateCreateGstEntry(req.body);
    const created = await this.gstService.create(payload);
    res.status(201).json(created);
  };

  update = async (req: Request, res: Response) => {
    const payload = validateUpdateGstEntry(req.body);
    const updated = await this.gstService.update(req.params.id, payload);
    res.json(updated);
  };

  remove = async (req: Request, res: Response) => {
    await this.gstService.delete(req.params.id);
    res.json({ success: true, message: 'GST entry deleted successfully.' });
  };
}
