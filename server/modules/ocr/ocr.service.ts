/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'fs';
import path from 'path';
import type { DocumentCategory, OcrJob, OcrJobStatus } from '../../../shared/contracts/index.ts';
import { getStagingDir } from '../../config/storage.ts';
import { NotFoundError, ValidationError } from '../../domain/errors/AppError.ts';
import { validateDocumentContent } from '../../middleware/upload.ts';
import type { IMastersRepository } from '../masters/masters.repository.ts';
import type { IOcrRepository } from './ocr.repository.ts';
import type { OcrQueueWorkerService } from './ocr.worker.ts';

export class OcrService {
  constructor(
    private readonly ocrRepo: IOcrRepository,
    private readonly mastersRepo: IMastersRepository,
    private readonly worker: OcrQueueWorkerService
  ) {}

  async listJobs(filters?: { status?: OcrJobStatus; category?: DocumentCategory }) {
    const jobs = await this.ocrRepo.findAll(filters);
    return {
      jobs,
      concurrency: this.worker.getConcurrencyMetrics(),
    };
  }

  async getJobById(id: string): Promise<OcrJob> {
    const job = await this.ocrRepo.findById(id);
    if (!job) throw new NotFoundError('OCR Job not found.');
    return job;
  }

  async enqueueJob(
    file: Express.Multer.File | undefined,
    input: { category?: DocumentCategory; financialYearId?: string }
  ) {
    if (!file) {
      throw new ValidationError('No document file provided for OCR queue.');
    }
    if (!validateDocumentContent(file.buffer, file.originalname)) {
      throw new ValidationError(`Invalid or corrupted file content for "${file.originalname}".`);
    }

    const category = (input.category || 'COMMERCIAL_INVOICE') as DocumentCategory;
    const financialYearId = input.financialYearId || (await this.mastersRepo.findCurrentFinancialYear()).id;

    const job = await this.ocrRepo.enqueue({
      originalFilename: file.originalname,
      fileSizeBytes: file.size,
      category,
      financialYearId,
    });

    this.worker.registerStagingBuffer(job.id, file.buffer);
    try {
      const stagingPath = path.resolve(getStagingDir(), `${job.id}.bin`);
      await fsp.writeFile(stagingPath, file.buffer);
    } catch {
      // ignore staging backup error; in-memory buffer is already registered
    }

    this.worker.triggerProcessing();
    return {
      success: true,
      message: 'Document queued for background server-side OCR processing.',
      job,
    };
  }

  async retryJob(id: string): Promise<OcrJob> {
    const job = await this.ocrRepo.retry(id);
    this.worker.triggerProcessing();
    return job;
  }

  async deleteJob(id: string): Promise<{ success: boolean }> {
    return this.ocrRepo.delete(id);
  }

  async approveJob(id: string, reviewedValues: Record<string, any>, actorUserId: string) {
    const result = await this.ocrRepo.approveJob(id, reviewedValues, actorUserId);
    return {
      success: true,
      message: 'Candidate OCR data approved and committed to ledger.',
      ...result,
    };
  }
}
