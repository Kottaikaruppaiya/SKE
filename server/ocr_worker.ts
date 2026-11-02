/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { db } from './db.ts';
import { extractDocumentData, mergeExtractedDocuments } from './extractor.ts';
import type { OcrJob } from '../src/types/index.ts';

// Configurable concurrency based on VPS CPU / RAM
const MAX_CONCURRENT_JOBS = Math.max(1, parseInt(process.env.OCR_CONCURRENCY || '2', 10));
const STAGING_DIR = path.resolve('storage/staging');
if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });

class OcrQueueWorker {
  private activeJobsCount = 0;
  private isProcessing = false;
  private timer: NodeJS.Timeout | null = null;
  private stagingBufferMap = new Map<string, Buffer>();

  constructor() {
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
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.activeJobsCount < MAX_CONCURRENT_JOBS) {
        const pendingJobs = db.getOcrJobs({ status: 'PENDING' });
        if (pendingJobs.length === 0) break;

        const nextJob = pendingJobs[0];
        // Mark as processing immediately to prevent duplicate pick up
        db.updateOcrJob(nextJob.id, {
          status: 'PROCESSING',
          attempts: (nextJob.attempts || 0) + 1,
        });

        this.activeJobsCount++;
        this.processJob(nextJob).finally(() => {
          this.activeJobsCount--;
          this.triggerProcessing();
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  public async processJob(job: OcrJob): Promise<void> {
    const startTime = Date.now();
    try {
      // 1. Resolve file buffer
      let buffer: Buffer | null = this.stagingBufferMap.get(job.id) || null;

      if (!buffer && job.documentId) {
        const doc = db.getDocumentById(job.documentId);
        if (doc && doc.storedPath) {
          const absPath = path.isAbsolute(doc.storedPath) ? doc.storedPath : path.resolve(doc.storedPath);
          if (fs.existsSync(absPath)) {
            buffer = fs.readFileSync(absPath);
          }
        }
      }

      if (!buffer) {
        const stagingFile = path.resolve(STAGING_DIR, `${job.id}.bin`);
        if (fs.existsSync(stagingFile)) {
          buffer = fs.readFileSync(stagingFile);
        }
      }

      if (!buffer) {
        throw new Error(`Document binary could not be located in storage for OCR Job ${job.id}`);
      }

      // 2. Execute local OCR extraction
      const extraction = await extractDocumentData(buffer, job.category, job.originalFilename);
      const executionTimeMs = Date.now() - startTime;

      // Clean up in-memory buffer to keep VPS RAM low
      this.stagingBufferMap.delete(job.id);
      const stagingFile = path.resolve(STAGING_DIR, `${job.id}.bin`);
      if (fs.existsSync(stagingFile)) {
        try {
          fs.unlinkSync(stagingFile);
        } catch {}
      }

      // Create draft preview
      const mergedDraft = mergeExtractedDocuments([extraction]);

      // 3. Save extraction results separately in staging (never overwriting verified records)
      db.updateOcrJob(job.id, {
        status: 'COMPLETED',
        executionTimeMs,
        ocrApplied: extraction.ocrApplied,
        ocrConfidence: extraction.ocrConfidence,
        ocrTextPreview: extraction.ocrTextPreview,
        extractionMethod: extraction.extractionMethod,
        candidateFields: extraction.fields,
        candidateDraft: mergedDraft,
        error: undefined,
      });

      // Update linked document record if present
      if (job.documentId) {
        const doc = db.getDocumentById(job.documentId);
        if (doc) {
          doc.extractedData = extraction;
          doc.ocrApplied = extraction.ocrApplied;
          doc.ocrConfidence = extraction.ocrConfidence;
          doc.ocrTextPreview = extraction.ocrTextPreview;
          doc.extractionMethod = extraction.extractionMethod;
          doc.reviewStatus = extraction.reviewStatus;
          doc.updatedAt = new Date().toISOString();
        }
      }
    } catch (err: any) {
      const executionTimeMs = Date.now() - startTime;
      const errorMsg = err?.message || 'Local OCR extraction failed.';
      const maxAttempts = job.maxAttempts || 3;
      const currentAttempts = (job.attempts || 0);

      const isFinalFailure = currentAttempts >= maxAttempts;

      db.updateOcrJob(job.id, {
        status: isFinalFailure ? 'FAILED' : 'PENDING',
        error: errorMsg,
        executionTimeMs,
      });
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
