/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import type { DocumentsService } from './documents.service.ts';
import { validateReviewStatusPayload } from './documents.validator.ts';

export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  list = async (req: AuthenticatedRequest, res: Response) => {
    const shipmentId = req.query.shipmentId ? String(req.query.shipmentId) : undefined;
    const paymentId = req.query.paymentId ? String(req.query.paymentId) : undefined;
    const docs = await this.service.list(shipmentId || paymentId ? { shipmentId, paymentId } : undefined);
    res.json(docs);
  };

  extractBatch = async (req: AuthenticatedRequest, res: Response) => {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const result = await this.service.extractBatch(files);
    res.json(result);
  };

  upload = async (req: AuthenticatedRequest, res: Response) => {
    const result = await this.service.upload(req.file, req.body || {}, req.user!.id);
    res.status(201).json(result);
  };

  download = async (req: AuthenticatedRequest, res: Response) => {
    const { absolutePath, document } = await this.service.resolveDownload(req.params.id);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(document.originalFilename)}"`);
    res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
    fs.createReadStream(absolutePath).pipe(res);
  };

  updateReviewStatus = async (req: AuthenticatedRequest, res: Response) => {
    const reviewStatus = validateReviewStatusPayload(req.body);
    const updated = await this.service.updateReviewStatus(req.params.id, reviewStatus);
    res.json(updated);
  };

  remove = async (req: AuthenticatedRequest, res: Response) => {
    const result = await this.service.delete(req.params.id);
    res.json(result);
  };
}
