/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { DocumentCategory, OcrJobStatus } from '../../../shared/contracts/index.ts';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import type { OcrService } from './ocr.service.ts';
import { validateApproveOcrPayload, validateEnqueueOcrPayload } from './ocr.validator.ts';

export class OcrController {
  constructor(private readonly service: OcrService) {}

  listJobs = async (req: AuthenticatedRequest, res: Response) => {
    const status = req.query.status ? (String(req.query.status) as OcrJobStatus) : undefined;
    const category = req.query.category ? (String(req.query.category) as DocumentCategory) : undefined;
    const result = await this.service.listJobs({ status, category });
    res.json(result);
  };

  getJob = async (req: AuthenticatedRequest, res: Response) => {
    const job = await this.service.getJobById(req.params.id);
    res.json(job);
  };

  enqueue = async (req: AuthenticatedRequest, res: Response) => {
    const input = validateEnqueueOcrPayload(req.body);
    const result = await this.service.enqueueJob(req.file, input);
    res.status(202).json(result);
  };

  retry = async (req: AuthenticatedRequest, res: Response) => {
    const job = await this.service.retryJob(req.params.id);
    res.json(job);
  };

  remove = async (req: AuthenticatedRequest, res: Response) => {
    const result = await this.service.deleteJob(req.params.id);
    res.json(result);
  };

  approve = async (req: AuthenticatedRequest, res: Response) => {
    const reviewedValues = validateApproveOcrPayload(req.body);
    const result = await this.service.approveJob(req.params.id, reviewedValues, req.user!.id);
    res.json(result);
  };
}
