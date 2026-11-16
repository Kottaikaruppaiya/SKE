/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from './db.ts';
import { extractDocumentData, mergeExtractedDocuments } from './extractor.ts';
import type { OcrJob } from '../src/types/index.ts';

// Configurable concurrency based on VPS CPU / RAM
const MAX_CONCURRENT_JOBS = Math.max(1, parseInt(process.env.OCR_CONCURRENCY || '2', 10));

export function getOcrStagingDir(): string {
  const storageRoot = process.env.STORAGE_ROOT ? path.resolve(process.env.STORAGE_ROOT) : path.resolve('storage');
  const stagingDir = path.resolve(storageRoot, 'staging');
  if (!fs.existsSync(stagingDir)) {
    fs.mkdirSync(stagingDir, { recursive: true });
  }
  return stagingDir;
}

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
      this.tick();
    }, intervalMs);
    // Unref timer so it doesn't block graceful shutdown in tests
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
    setImmediate(() => this.tick());
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
        while (this.activeJobsCount < MAX_CONCURRENT_JOBS) {
          // Database-level atomic job claiming with 60s lease
          const nextJob = db.claimNextOcrJob(this.workerId, 60000);
          if (!nextJob) break;

          this.activeJobsCount++;
          this.processJob(nextJob).finally(() => {
            this.activeJobsCount--;
            this.triggerProcessing();
          });
        }
      } while (this.needsReschedule && this.activeJobsCount < MAX_CONCURRENT_JOBS);
    } finally {
      this.isProcessing = false;
      if (this.needsReschedule && this.activeJobsCount < MAX_CONCURRENT_JOBS) {
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
      // Active lease renewal heartbeat: extends lease every 20s during long OCR processing
      heartbeatTimer = setInterval(() => {
        const renewed = db.renewOcrJobLease(job.id, this.workerId, 60000);
        if (!renewed) {
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'ocr_lease_renew_failed',
            workerId: this.workerId,
            jobId: job.id,
          }));
        }
      }, 20000);
      if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
      }

      // 1. Resolve file buffer via async filesystem I/O
      let buffer: Buffer | null = this.stagingBufferMap.get(job.id) || null;

      if (!buffer && job.documentId) {
        const doc = db.getDocumentById(job.documentId);
        if (doc && doc.storedPath) {
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

      // 2. Execute local OCR extraction
      const extraction = await extractDocumentData(buffer, job.category, job.originalFilename);
      const executionTimeMs = Date.now() - startTime;

      // Clean up in-memory buffer and staging file asynchronously
      this.stagingBufferMap.delete(job.id);
      const stagingFile = path.resolve(stagingDir, `${job.id}.bin`);
      try {
        await fsp.unlink(stagingFile);
      } catch {
        // Ignore if staging file wasn't written to disk
      }

      // Create draft preview
      const mergedDraft = mergeExtractedDocuments([extraction]);

      // 3. Atomically commit extraction results, verifying worker lease remains valid
      db.completeOcrJob(job.id, this.workerId, {
        executionTimeMs,
        ocrApplied: extraction.ocrApplied,
        ocrConfidence: extraction.ocrConfidence,
        ocrTextPreview: extraction.ocrTextPreview,
        extractionMethod: extraction.extractionMethod,
        candidateFields: extraction.fields,
        candidateDraft: mergedDraft,
      });

      // Persist linked document record metadata if present
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
      const errorMsg = err?.message || 'Local OCR extraction failed.';
      db.failOcrJob(job.id, this.workerId, errorMsg, executionTimeMs);
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
      maxConcurrency: MAX_CONCURRENT_JOBS,
    };
  }
}

export const ocrWorker = new OcrQueueWorker();
export { OcrQueueWorker };
