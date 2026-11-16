/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { OcrJob } from '../src/types/index.ts';
import { env } from './config/environment.ts';
import { getStagingDir } from './config/storage.ts';
import { db } from './db.ts';
import { extractDocumentData, mergeExtractedDocuments } from './extractor.ts';

export const getOcrStagingDir = getStagingDir;

class OcrQueueWorker {
  public readonly workerId: string;
  private activeJobsCount = 0;
  private isProcessing = false;
  private needsReschedule = false;
  private timer: NodeJS.Timeout | null = null;
  private stagingBufferMap = new Map<string, Buffer>();

  constructor(workerId?: string) {
    this.workerId = workerId || `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    this.startPolling();
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

    const maxConcurrent = Math.max(1, env.ocrConcurrency || 2);
    try {
      do {
        this.needsReschedule = false;
        while (this.activeJobsCount < maxConcurrent) {
          const nextJob = db.claimNextOcrJob(this.workerId, 60000);
          if (!nextJob) break;

          this.activeJobsCount++;
          void this.processJob(nextJob).finally(() => {
            this.activeJobsCount--;
            this.triggerProcessing();
          });
        }
      } while (this.needsReschedule && this.activeJobsCount < maxConcurrent);
    } finally {
      this.isProcessing = false;
      if (this.needsReschedule && this.activeJobsCount < maxConcurrent) {
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
    const stagingDir = getOcrStagingDir();

    try {
      heartbeatTimer = setInterval(() => {
        db.renewOcrJobLease(job.id, this.workerId, 60000);
      }, 20000);
      if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
      }

      let buffer: Buffer | null = this.stagingBufferMap.get(job.id) || null;
      if (!buffer && job.documentId) {
        const doc = db.getDocumentById(job.documentId);
        if (doc && doc.storedPath) {
          const absPath = path.isAbsolute(doc.storedPath) ? doc.storedPath : path.resolve(doc.storedPath);
          buffer = await this.readIfExists(absPath);
        }
      }
      if (!buffer) {
        buffer = await this.readIfExists(path.resolve(stagingDir, `${job.id}.bin`));
      }
      if (!buffer) {
        throw new Error(`Document binary could not be located in storage for OCR Job ${job.id}`);
      }

      const extraction = await extractDocumentData(buffer, job.category, job.originalFilename);
      const executionTimeMs = Date.now() - startTime;

      this.stagingBufferMap.delete(job.id);
      try {
        await fsp.unlink(path.resolve(stagingDir, `${job.id}.bin`));
      } catch {
        // Ignore missing staging file
      }

      const mergedDraft = mergeExtractedDocuments([extraction]);
      db.completeOcrJob(job.id, this.workerId, {
        executionTimeMs,
        ocrApplied: extraction.ocrApplied,
        ocrConfidence: extraction.ocrConfidence,
        ocrTextPreview: extraction.ocrTextPreview,
        extractionMethod: extraction.extractionMethod,
        candidateFields: extraction.fields,
        candidateDraft: mergedDraft,
      });

      if (job.documentId) {
        db.updateDocumentExtraction(job.documentId, {
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
      db.failOcrJob(job.id, this.workerId, err?.message || 'Local OCR extraction failed.', executionTimeMs);
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
      maxConcurrency: Math.max(1, env.ocrConcurrency || 2),
    };
  }
}

export const ocrWorker = new OcrQueueWorker();
export { OcrQueueWorker };
