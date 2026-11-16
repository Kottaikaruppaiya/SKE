/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import type { ShipmentsService, UploadedDocFields } from './shipments.service.ts';
import { validateCreateShipment, validateCreateWithDocumentsBody } from './shipments.validator.ts';

export class ShipmentsController {
  constructor(private readonly shipmentsService: ShipmentsService) {}

  list = async (req: AuthenticatedRequest, res: Response) => {
    const { financialYearId, consigneeId, paymentStatus, reviewStatus, search, includeArchived } = req.query as any;
    const list = await this.shipmentsService.listShipments({
      financialYearId,
      consigneeId,
      paymentStatus,
      reviewStatus,
      search,
      includeArchived: includeArchived === 'true',
    });
    res.json(list);
  };

  lookup = async (req: AuthenticatedRequest, res: Response) => {
    const q = String(req.query.q || '').trim();
    const fyId = req.query.financialYearId ? String(req.query.financialYearId) : undefined;
    const result = await this.shipmentsService.lookupShipments(q, fyId);
    res.json(result);
  };

  checkUnique = async (req: AuthenticatedRequest, res: Response) => {
    const invoiceNumber = String(req.query.invoiceNumber || '').trim();
    const financialYearId = req.query.financialYearId ? String(req.query.financialYearId) : undefined;
    const result = await this.shipmentsService.checkInvoiceUnique(invoiceNumber, financialYearId);
    res.json(result);
  };

  getById = async (req: AuthenticatedRequest, res: Response) => {
    const shipment = await this.shipmentsService.getShipmentById(req.params.id);
    res.json(shipment);
  };

  create = async (req: AuthenticatedRequest, res: Response) => {
    const data = validateCreateShipment(req.body);
    const created = await this.shipmentsService.createShipment(data, req.user!.id);
    res.status(201).json(created);
  };

  createWithDocuments = async (req: AuthenticatedRequest, res: Response) => {
    const validatedBody = validateCreateWithDocumentsBody(req.body || {});
    const files = req.files as UploadedDocFields | undefined;
    const created = await this.shipmentsService.createShipmentWithDocuments(validatedBody, files, req.user!.id);
    res.status(201).json(created);
  };

  update = async (req: AuthenticatedRequest, res: Response) => {
    const updated = await this.shipmentsService.updateShipment(req.params.id, req.body || {});
    res.json(updated);
  };

  remove = async (req: AuthenticatedRequest, res: Response) => {
    res.json(await this.shipmentsService.deleteShipment(req.params.id));
  };

  archive = async (req: AuthenticatedRequest, res: Response) => {
    const archived = await this.shipmentsService.archiveShipment(req.params.id, req.body?.reason, req.user!.id);
    res.json(archived);
  };

  restore = async (req: AuthenticatedRequest, res: Response) => {
    const restored = await this.shipmentsService.restoreShipment(req.params.id, req.user!.id);
    res.json(restored);
  };
}
