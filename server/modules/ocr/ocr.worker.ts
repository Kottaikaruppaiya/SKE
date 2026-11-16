/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import { promises as fsp } from 'fs';
import path from 'path';
import type { OcrJob } from '../../../shared/contracts/index.ts';
import { env } from '../../config/environment.ts';
import { getStagingDir } from '../../config/storage.ts';
import { extractDocumentData, mergeExtractedDocuments } from '../../extractor.ts';
import type { IDocumentsRepository } from '../documents/documents.repository.ts';
import type { IOcrRepository } from './ocr.repository.ts';

export class OcrQueueWorkerService {
  public readonly workerId: string;
  private activeJobsCount = 0;
  private isProcessing = false;
  private needsReschedule = false;
  private timer: NodeJS.Timeout | null = null;
  private stagingBufferMap = new Map<string, Buffer>();
  private readonly maxConcurrentJobs: number;

  constructor(
    private readonly ocrRepo: IOcrRepository,
    private readonly documentsRepo: IDocumentsRepository,
    workerId?: string
  ) {
    this.workerId = workerId || `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    this.maxConcurrentJobs = Math.max(1, env.ocrConcurrency || 2);
  }

  public registerStagingBuffer(jobId: string, buffer: Buffer) {
    this.stagingBufferMap.set(jobId, buffer);
  }

  public startPolling(intervalMs = 4000) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  public stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public triggerProcessing() {
    setImmediate(() => {
      void this.tick();
    });
  }

  public async tick() {
    if (this.isProcessing) {
      this.needsReschedule = true;
      return;
    }
    this.isProcessing = true;

    try {
      do {
        this.needsReschedule = false;
        while (this.activeJobsCount < this.maxConcurrentJobs) {
          const nextJob = await this.ocrRepo.claimNextJob(this.workerId, 60000);
          if (!nextJob) break;

          this.activeJobsCount++;
          void this.processJob(nextJob).finally(() => {
            this.activeJobsCount--;
            this.triggerProcessing();
          });
        }
      } while (this.needsReschedule && this.activeJobsCount < this.maxConcurrentJobs);
    } finally {
      this.isProcessing = false;
      if (this.needsReschedule && this.activeJobsCount < this.maxConcurrentJobs) {
        this.needsReschedule = false;
        this.triggerProcessing();
      }
    }
  }

  private async readIfExists(filePath: string): Promise<Buffer | null> {
    try {
      await fsp.access(filePath);
      return await fsp.readFile(filePath);
    } catch {
      return null;
    }
  }

  public async processJob(job: OcrJob): Promise<void> {
    const startTime = Date.now();
    let heartbeatTimer: NodeJS.Timeout | null = null;
    const stagingDir = getStagingDir();

    try {
      heartbeatTimer = setInterval(() => {
        void this.ocrRepo.renewLease(job.id, this.workerId, 60000).then((renewed) => {
          if (!renewed) {
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: 'ocr_lease_renew_failed',
                workerId: this.workerId,
                jobId: job.id,
              })
            );
          }
        });
      }, 20000);
      if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
      }

      let buffer: Buffer | null = this.stagingBufferMap.get(job.id) || null;

      if (!buffer && job.documentId) {
        const doc = await this.documentsRepo.findById(job.documentId);
        if (doc?.storedPath) {
          const absPath = path.isAbsolute(doc.storedPath) ? doc.storedPath : path.resolve(doc.storedPath);
          buffer = await this.readIfExists(absPath);
        }
      }

      if (!buffer) {
        const stagingFile = path.resolve(stagingDir, `${job.id}.bin`);
        buffer = await this.readIfExists(stagingFile);
      }

      if (!buffer) {
        throw new Error(`Document binary could not be located in storage for OCR Job ${job.id}`);
      }

      const extraction = await extractDocumentData(buffer, job.category, job.originalFilename);
      const executionTimeMs = Date.now() - startTime;

      this.stagingBufferMap.delete(job.id);
      const stagingFile = path.resolve(stagingDir, `${job.id}.bin`);
      try {
        await fsp.unlink(stagingFile);
      } catch {
        // ignore if missing
      }

      const mergedDraft = mergeExtractedDocuments([extraction]);
      await this.ocrRepo.completeJob(job.id, this.workerId, {
        executionTimeMs,
        ocrApplied: extraction.ocrApplied,
        ocrConfidence: extraction.ocrConfidence,
        ocrTextPreview: extraction.ocrTextPreview,
        extractionMethod: extraction.extractionMethod,
        candidateFields: extraction.fields,
        candidateDraft: mergedDraft,
      });

      if (job.documentId) {
        await this.documentsRepo.updateExtraction(job.documentId, {
          extractedData: extraction,
          ocrApplied: extraction.ocrApplied,
          ocrConfidence: extraction.ocrConfidence,
          ocrTextPreview: extraction.ocrTextPreview,
          extractionMethod: extraction.extractionMethod,
          reviewStatus: extraction.reviewStatus,
        });
      }
    } catch (err: any) {
      const executionTimeMs = Date.now() - startTime;
      const errorMsg = err?.message || 'Local OCR extraction failed.';
      await this.ocrRepo.failJob(job.id, this.workerId, errorMsg, executionTimeMs);
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  }

  public getConcurrencyMetrics() {
    return {
      activeJobs: this.activeJobsCount,
      maxConcurrency: this.maxConcurrentJobs,
    };
  }
}
