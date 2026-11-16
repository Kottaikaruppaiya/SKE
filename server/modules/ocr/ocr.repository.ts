/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type {
  DocumentCategory,
  OcrJob,
  OcrJobStatus,
  Payment,
  Shipment,
} from '../../../shared/contracts/index.ts';
import { normalizeInvoiceKey } from '../../../shared/utils/invoiceNormalizer.ts';
import { computeStatutoryBrcDeadline } from '../../domain/calculations/brc.calc.ts';
import {
  calculateFobValueInr,
  computePaymentAllocationBalances,
  deriveShipmentPaymentStatus,
} from '../../domain/calculations/shipment.calc.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors/AppError.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';
import {
  bigIntToNumber,
  decimalToNumber,
  toIsoTimestamp,
} from '../../infrastructure/prismaMappers.ts';
import type { IMastersRepository } from '../masters/masters.repository.ts';
import type { IPaymentsRepository } from '../payments/payments.repository.ts';
import type { IShipmentsRepository } from '../shipments/shipments.repository.ts';

export interface EnqueueOcrJobInput {
  originalFilename: string;
  fileSizeBytes: number;
  category: DocumentCategory;
  financialYearId?: string;
  documentId?: string;
}

export interface CompleteOcrJobInput {
  executionTimeMs: number;
  ocrApplied?: boolean;
  ocrConfidence?: number;
  ocrTextPreview?: string;
  extractionMethod?: 'PDF_TEXT' | 'LOCAL_OCR';
  candidateFields?: any;
  candidateDraft?: any;
}

export interface IOcrRepository {
  findAll(filters?: { status?: OcrJobStatus; category?: DocumentCategory }): Promise<OcrJob[]>;
  findById(id: string): Promise<OcrJob | null>;
  enqueue(input: EnqueueOcrJobInput): Promise<OcrJob>;
  update(id: string, updates: Partial<OcrJob>): Promise<OcrJob>;
  retry(id: string): Promise<OcrJob>;
  delete(id: string): Promise<{ success: boolean }>;
  claimNextJob(workerId: string, leaseDurationMs?: number): Promise<OcrJob | null>;
  renewLease(jobId: string, workerId: string, additionalMs?: number): Promise<boolean>;
  completeJob(jobId: string, workerId: string, result: CompleteOcrJobInput): Promise<OcrJob>;
  failJob(jobId: string, workerId: string, errorMsg: string, executionTimeMs?: number): Promise<OcrJob>;
  approveJob(
    jobId: string,
    reviewedValues: Record<string, any>,
    actorUserId: string
  ): Promise<{ shipment?: Shipment; payment?: Payment; job: OcrJob }>;
}

function mapPrismaOcrJob(row: any): OcrJob {
  return {
    id: row.id,
    documentId: row.documentId || undefined,
    originalFilename: row.originalFilename,
    fileSizeBytes: bigIntToNumber(row.fileSizeBytes),
    category: row.category,
    financialYearId: row.financialYearId,
    status: row.status as OcrJobStatus,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lockedByWorkerId: row.lockedByWorkerId || undefined,
    lockedAt: row.lockedAt ? toIsoTimestamp(row.lockedAt) : undefined,
    leaseExpiresAt: row.leaseExpiresAt ? toIsoTimestamp(row.leaseExpiresAt) : undefined,
    executionTimeMs: row.executionTimeMs ?? undefined,
    ocrApplied: row.ocrApplied,
    ocrConfidence: row.ocrConfidence ?? undefined,
    ocrTextPreview: row.ocrTextPreview || undefined,
    extractionMethod: (row.extractionMethod as OcrJob['extractionMethod']) || undefined,
    candidateFields: (row.candidateFields as any) || undefined,
    candidateDraft: (row.candidateDraft as any) || undefined,
    error: row.error || undefined,
    targetShipmentId: row.targetShipmentId || undefined,
    targetPaymentId: row.targetPaymentId || undefined,
    approvedAt: row.approvedAt ? toIsoTimestamp(row.approvedAt) : undefined,
    approvedByUserId: row.approvedByUserId || undefined,
    approvedByName: row.approvedByName || undefined,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

export class PrismaOcrRepository implements IOcrRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly shipmentsRepo: IShipmentsRepository,
    private readonly paymentsRepo: IPaymentsRepository,
    private readonly mastersRepo: IMastersRepository
  ) {}

  async findAll(filters?: { status?: OcrJobStatus; category?: DocumentCategory }): Promise<OcrJob[]> {
    const where: Record<string, any> = {};
    if (filters?.status) where.status = filters.status;
    if (filters?.category) where.category = filters.category;

    const rows = await this.prisma.ocrJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(mapPrismaOcrJob);
  }

  async findById(id: string): Promise<OcrJob | null> {
    const row = await this.prisma.ocrJob.findUnique({ where: { id } });
    return row ? mapPrismaOcrJob(row) : null;
  }

  async enqueue(input: EnqueueOcrJobInput): Promise<OcrJob> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const existing = await this.prisma.ocrJob.findFirst({
      where: {
        status: { in: ['PENDING', 'PROCESSING'] },
        originalFilename: input.originalFilename,
        category: input.category,
        fileSizeBytes: BigInt(input.fileSizeBytes),
        createdAt: { gt: tenMinutesAgo },
      },
    });
    if (existing) {
      return mapPrismaOcrJob(existing);
    }

    const fyId = input.financialYearId || (await this.mastersRepo.findCurrentFinancialYear()).id;
    const created = await this.prisma.ocrJob.create({
      data: {
        documentId: input.documentId || null,
        originalFilename: input.originalFilename,
        fileSizeBytes: BigInt(input.fileSizeBytes),
        category: input.category,
        financialYearId: fyId,
        status: 'PENDING',
        attempts: 0,
        maxAttempts: 3,
      },
    });
    return mapPrismaOcrJob(created);
  }

  async update(id: string, updates: Partial<OcrJob>): Promise<OcrJob> {
    const existing = await this.prisma.ocrJob.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('OCR job not found.');

    const updated = await this.prisma.ocrJob.update({
      where: { id },
      data: {
        ...(updates.status !== undefined ? { status: updates.status } : {}),
        ...(updates.attempts !== undefined ? { attempts: updates.attempts } : {}),
        ...(updates.error !== undefined ? { error: updates.error || null } : {}),
        ...(updates.lockedByWorkerId !== undefined ? { lockedByWorkerId: updates.lockedByWorkerId || null } : {}),
        ...(updates.lockedAt !== undefined ? { lockedAt: updates.lockedAt ? new Date(updates.lockedAt) : null } : {}),
        ...(updates.leaseExpiresAt !== undefined
          ? { leaseExpiresAt: updates.leaseExpiresAt ? new Date(updates.leaseExpiresAt) : null }
          : {}),
      },
    });
    return mapPrismaOcrJob(updated);
  }

  async retry(id: string): Promise<OcrJob> {
    const existing = await this.prisma.ocrJob.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('OCR job not found.');

    const updated = await this.prisma.ocrJob.update({
      where: { id },
      data: {
        status: 'PENDING',
        error: null,
        attempts: 0,
        lockedByWorkerId: null,
        lockedAt: null,
        leaseExpiresAt: null,
      },
    });
    return mapPrismaOcrJob(updated);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    const existing = await this.prisma.ocrJob.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('OCR job not found.');
    await this.prisma.ocrJob.delete({ where: { id } });
    return { success: true };
  }

  async claimNextJob(workerId: string, leaseDurationMs = 60000): Promise<OcrJob | null> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM "OcrJob"
        WHERE attempts < "maxAttempts"
          AND (
            status = 'PENDING'
            OR (status = 'PROCESSING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${now}))
          )
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      const target = rows[0];
      if (!target) return null;

      const updated = await tx.ocrJob.update({
        where: { id: target.id },
        data: {
          status: 'PROCESSING',
          lockedByWorkerId: workerId,
          lockedAt: now,
          leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
          attempts: { increment: 1 },
        },
      });
      return mapPrismaOcrJob(updated);
    });
  }

  async renewLease(jobId: string, workerId: string, additionalMs = 60000): Promise<boolean> {
    const result = await this.prisma.ocrJob.updateMany({
      where: {
        id: jobId,
        status: 'PROCESSING',
        lockedByWorkerId: workerId,
      },
      data: {
        leaseExpiresAt: new Date(Date.now() + additionalMs),
      },
    });
    return result.count > 0;
  }

  async completeJob(jobId: string, workerId: string, result: CompleteOcrJobInput): Promise<OcrJob> {
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.ocrJob.findUnique({ where: { id: jobId } });
      if (!job) throw new NotFoundError('OCR job not found.');

      if (job.lockedByWorkerId && job.lockedByWorkerId !== workerId) {
        throw new ConflictError(
          `Lease violation: OCR job ${jobId} was reclaimed by worker ${job.lockedByWorkerId}; commit rejected.`
        );
      }
      if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() < Date.now()) {
        throw new ConflictError(
          `Lease expired: OCR job ${jobId} lease expired at ${job.leaseExpiresAt.toISOString()}; commit rejected.`
        );
      }

      const updated = await tx.ocrJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          lockedByWorkerId: null,
          leaseExpiresAt: null,
          executionTimeMs: result.executionTimeMs,
          ocrApplied: Boolean(result.ocrApplied),
          ocrConfidence: result.ocrConfidence ?? null,
          ocrTextPreview: result.ocrTextPreview || null,
          extractionMethod: result.extractionMethod || null,
          candidateFields: result.candidateFields || undefined,
          candidateDraft: result.candidateDraft || undefined,
          error: null,
        },
      });
      return mapPrismaOcrJob(updated);
    });
  }

  async failJob(jobId: string, _workerId: string, errorMsg: string, executionTimeMs?: number): Promise<OcrJob> {
    const job = await this.prisma.ocrJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundError('OCR job not found.');

    const isFinalFailure = job.attempts >= job.maxAttempts;
    const updated = await this.prisma.ocrJob.update({
      where: { id: jobId },
      data: {
        status: isFinalFailure ? 'FAILED' : 'PENDING',
        lockedByWorkerId: null,
        leaseExpiresAt: null,
        error: errorMsg,
        ...(executionTimeMs !== undefined ? { executionTimeMs } : {}),
      },
    });
    return mapPrismaOcrJob(updated);
  }

  async approveJob(
    jobId: string,
    reviewedValues: Record<string, any>,
    actorUserId: string
  ): Promise<{ shipment?: Shipment; payment?: Payment; job: OcrJob }> {
    const jobRow = await this.prisma.ocrJob.findUnique({ where: { id: jobId } });
    if (!jobRow) throw new NotFoundError('OCR job not found.');
    const job = mapPrismaOcrJob(jobRow);

    const actor = await this.prisma.user.findUnique({ where: { id: actorUserId }, select: { name: true } });

    let targetShipmentId: string | undefined;
    let targetPaymentId: string | undefined;

    if (
      job.category === 'COMMERCIAL_INVOICE' ||
      job.category === 'SHIPPING_BILL' ||
      job.category === 'BILL_OF_LADING' ||
      job.category === 'ADDITIONAL_DOC'
    ) {
      const invoiceNumber = String(reviewedValues.invoiceNumber || job.candidateDraft?.invoiceNumber || '').trim();
      if (!invoiceNumber) {
        throw new ValidationError('Invoice Number is required to commit approved shipment data.');
      }

      const fyId = job.financialYearId || (await this.mastersRepo.findCurrentFinancialYear()).id;
      const normalizedKey = normalizeInvoiceKey(invoiceNumber);

      targetShipmentId = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.shipment.findUnique({
          where: {
            financialYearId_normalizedInvoiceKey: {
              financialYearId: fyId,
              normalizedInvoiceKey: normalizedKey,
            },
          },
          include: { allocations: true },
        });

        if (existing) {
          const nextInvVal =
            reviewedValues.invoiceValueUsd !== undefined
              ? Number(reviewedValues.invoiceValueUsd)
              : decimalToNumber(existing.invoiceValueUsd);
          const nextRate =
            reviewedValues.sbExchangeRate !== undefined
              ? Number(reviewedValues.sbExchangeRate)
              : decimalToNumber(existing.sbExchangeRate);
          const nextFob =
            reviewedValues.fobValueInr !== undefined
              ? Number(reviewedValues.fobValueInr)
              : decimalToNumber(existing.fobValueInr);
          const totalPaid = existing.allocations.reduce(
            (sum, a) => sum + decimalToNumber(a.allocatedAmountUsd),
            0
          );

          await tx.shipment.update({
            where: { id: existing.id },
            data: {
              ...(reviewedValues.invoiceDate ? { invoiceDate: new Date(reviewedValues.invoiceDate) } : {}),
              invoiceValueUsd: nextInvVal,
              ...(reviewedValues.shippingBillNumber
                ? { shippingBillNumber: String(reviewedValues.shippingBillNumber).trim() }
                : {}),
              ...(reviewedValues.shippingBillDate ? { shippingBillDate: new Date(reviewedValues.shippingBillDate) } : {}),
              sbExchangeRate: nextRate,
              fobValueInr: nextFob,
              ...(reviewedValues.blNumber !== undefined ? { blNumber: reviewedValues.blNumber || null } : {}),
              ...(reviewedValues.blDate !== undefined
                ? { blDate: reviewedValues.blDate ? new Date(reviewedValues.blDate) : null }
                : {}),
              ...(reviewedValues.vesselName !== undefined ? { vesselName: reviewedValues.vesselName || null } : {}),
              ...(reviewedValues.packageCount !== undefined ? { packageCount: Number(reviewedValues.packageCount) } : {}),
              ...(reviewedValues.portCode ? { portCode: String(reviewedValues.portCode).trim().toUpperCase() } : {}),
              reviewStatus: 'CONFIRMED',
              paymentStatus: deriveShipmentPaymentStatus(nextInvVal, totalPaid),
            },
          });
          return existing.id;
        }

        let consigneeId = reviewedValues.consigneeId as string | undefined;
        if (!consigneeId && (reviewedValues.consigneeName || job.candidateDraft?.consigneeName)) {
          const cName = String(reviewedValues.consigneeName || job.candidateDraft?.consigneeName || '').trim();
          const found = await tx.consigneeMaster.findFirst({
            where: { name: { equals: cName, mode: 'insensitive' } },
          });
          if (found) {
            consigneeId = found.id;
          } else if (cName) {
            const createdConsignee = await tx.consigneeMaster.create({
              data: {
                name: cName,
                country: 'International',
                portOfDischarge: reviewedValues.portCode || 'LKCMB',
                paymentTerms: 'DA 90 DAYS',
                currency: 'USD',
                isActive: true,
              },
            });
            consigneeId = createdConsignee.id;
          }
        }
        if (!consigneeId) {
          const first = await tx.consigneeMaster.findFirst();
          consigneeId = first?.id || '';
        }

        const hasFirc = Boolean(reviewedValues.initialFircPaymentId || reviewedValues.initialFircDocumentUploaded);
        if (!hasFirc) {
          throw new ValidationError(
            'Mandatory Rule Violation: A valid FIRC/payment document or IRM reference must be linked before saving a shipment.'
          );
        }

        const invVal = Number(reviewedValues.invoiceValueUsd || 0);
        const sbRate = Number(reviewedValues.sbExchangeRate || 92.1);
        const fob = Number(reviewedValues.fobValueInr || 0) || calculateFobValueInr(invVal, sbRate);
        const sbDateStr = reviewedValues.shippingBillDate || new Date().toISOString().split('T')[0];

        const settingRow = await tx.appSetting.findUnique({ where: { key: 'statutoryBrcDays' } });
        const statutoryDays = settingRow ? parseInt(settingRow.value, 10) || 270 : 270;
        const deadline = computeStatutoryBrcDeadline(sbDateStr, statutoryDays);

        const created = await tx.shipment.create({
          data: {
            financialYearId: fyId,
            invoiceNumber,
            normalizedInvoiceKey: normalizedKey,
            invoiceDate: new Date(reviewedValues.invoiceDate || new Date().toISOString().split('T')[0]),
            consigneeId,
            portCode: String(reviewedValues.portCode || 'INMAA1').trim().toUpperCase(),
            packageCount: Number(reviewedValues.packageCount || 0),
            invoiceValueUsd: invVal,
            shippingBillNumber: String(reviewedValues.shippingBillNumber || 'PENDING').trim(),
            shippingBillDate: new Date(sbDateStr),
            sbExchangeRate: sbRate,
            fobValueInr: fob,
            blNumber: reviewedValues.blNumber || null,
            blDate: reviewedValues.blDate ? new Date(reviewedValues.blDate) : null,
            vesselName: reviewedValues.vesselName || null,
            remarks: reviewedValues.remarks || null,
            paymentStatus: 'UNPAID',
            reviewStatus: 'CONFIRMED',
          },
        });

        const incentiveDefs: Array<{ type: 'DRAWBACK' | 'RODTEP' | 'ROSCTL'; val: number }> = [
          { type: 'DRAWBACK', val: Number(reviewedValues.dbkClaimed || 0) },
          { type: 'RODTEP', val: Number(reviewedValues.rodtepClaimed || 0) },
          { type: 'ROSCTL', val: Number(reviewedValues.rosctlClaimed || 0) },
        ];
        for (const def of incentiveDefs) {
          await tx.incentiveRecord.create({
            data: {
              shipmentId: created.id,
              type: def.type,
              claimedAmount: def.val,
              status: 'PENDING',
              receivedAmount: 0,
            },
          });
        }

        await tx.brcRecord.create({
          data: {
            shipmentId: created.id,
            uploadMode: 'SINGLE',
            statutoryDeadline: new Date(deadline),
            status: 'PENDING',
          },
        });

        if (reviewedValues.initialFircPaymentId) {
          const lockedPayments = await tx.$queryRaw<any[]>`
            SELECT id, "irmNumber", "verifiedAmount"
            FROM "Payment"
            WHERE id = ${reviewedValues.initialFircPaymentId}
            FOR UPDATE
          `;
          const paymentRow = lockedPayments[0];
          if (!paymentRow) throw new NotFoundError('Payment record not found.');

          const allocAmount = Number(reviewedValues.initialFircAllocationAmount || invVal);
          const existingAllocs = await tx.paymentAllocation.findMany({ where: { paymentId: paymentRow.id } });
          const { availableBalanceUsd } = computePaymentAllocationBalances(
            decimalToNumber(paymentRow.verifiedAmount),
            existingAllocs.map((a) => ({ allocatedAmountUsd: decimalToNumber(a.allocatedAmountUsd) }))
          );
          if (allocAmount > availableBalanceUsd + 0.001) {
            throw new ValidationError(
              `Over-allocation rejected: Requested $${allocAmount.toFixed(2)} exceeds available payment balance of $${availableBalanceUsd.toFixed(2)} on FIRC ${paymentRow.irmNumber}.`
            );
          }

          await tx.paymentAllocation.create({
            data: {
              paymentId: paymentRow.id,
              shipmentId: created.id,
              allocatedAmountUsd: allocAmount,
              notes: 'Initial allocation on OCR approval',
              allocatedByUserId: actorUserId,
            },
          });
          await tx.shipment.update({
            where: { id: created.id },
            data: { paymentStatus: deriveShipmentPaymentStatus(invVal, allocAmount) },
          });
        }

        return created.id;
      });
    } else if (job.category === 'FIRC_PAYMENT') {
      const irmNumber = String(
        reviewedValues.irmNumber || job.candidateFields?.irmNumber?.value || ''
      )
        .trim()
        .toUpperCase();
      if (!irmNumber) {
        throw new ValidationError('Inward Remittance Number (IRM) is required to commit payment data.');
      }

      const existingPayment = await this.paymentsRepo.findByIrmNumber(irmNumber);
      if (existingPayment) {
        const updatedPayment = await this.paymentsRepo.update(existingPayment.id, {
          verifiedAmount:
            reviewedValues.verifiedAmount !== undefined
              ? Number(reviewedValues.verifiedAmount)
              : existingPayment.verifiedAmount,
          exchangeRate:
            reviewedValues.exchangeRate !== undefined
              ? Number(reviewedValues.exchangeRate)
              : existingPayment.exchangeRate,
          inrAmount:
            reviewedValues.inrAmount !== undefined ? Number(reviewedValues.inrAmount) : existingPayment.inrAmount,
          valueDate: reviewedValues.valueDate || existingPayment.valueDate,
          creditDate: reviewedValues.creditDate || existingPayment.creditDate,
        });
        targetPaymentId = updatedPayment.id;
      } else {
        const banks = await this.mastersRepo.findBanks();
        const createdPayment = await this.paymentsRepo.create({
          irmNumber,
          senderReference: reviewedValues.senderReference,
          currency: reviewedValues.currency || 'USD',
          verifiedAmount: Number(reviewedValues.verifiedAmount || 0),
          exchangeRate: Number(reviewedValues.exchangeRate || 93.28),
          inrAmount: Number(reviewedValues.inrAmount || 0),
          valueDate: reviewedValues.valueDate || new Date().toISOString().split('T')[0],
          creditDate: reviewedValues.creditDate || new Date().toISOString().split('T')[0],
          bankId: reviewedValues.bankId || banks[0]?.id || '',
          purposeCode: reviewedValues.purposeCode || 'P0103',
          remarks: reviewedValues.remarks,
        });
        targetPaymentId = createdPayment.id;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      if (job.documentId) {
        const doc = await tx.document.findUnique({ where: { id: job.documentId } });
        if (doc) {
          await tx.document.update({
            where: { id: doc.id },
            data: {
              ...(targetShipmentId && !doc.shipmentId ? { shipmentId: targetShipmentId } : {}),
              ...(targetPaymentId && !doc.paymentId ? { paymentId: targetPaymentId } : {}),
              reviewStatus: 'CONFIRMED',
            },
          });
        }
      }

      await tx.ocrJob.update({
        where: { id: jobId },
        data: {
          targetShipmentId: targetShipmentId || null,
          targetPaymentId: targetPaymentId || null,
          approvedAt: new Date(),
          approvedByUserId: actorUserId,
          approvedByName: actor?.name || 'Administrator',
        },
      });
    });

    const [updatedJob, shipment, payment] = await Promise.all([
      this.findById(jobId),
      targetShipmentId ? this.shipmentsRepo.findById(targetShipmentId) : Promise.resolve(null),
      targetPaymentId ? this.paymentsRepo.findById(targetPaymentId) : Promise.resolve(null),
    ]);

    return {
      shipment: shipment || undefined,
      payment: payment || undefined,
      job: updatedJob!,
    };
  }
}

export class JsonOcrRepository implements IOcrRepository {
  constructor(
    private readonly shipmentsRepo: IShipmentsRepository,
    private readonly paymentsRepo: IPaymentsRepository,
    private readonly mastersRepo: IMastersRepository
  ) {}

  async findAll(filters?: { status?: OcrJobStatus; category?: DocumentCategory }): Promise<OcrJob[]> {
    let list = jsonStore.getState().ocrJobs || [];
    if (filters?.status) list = list.filter((j) => j.status === filters.status);
    if (filters?.category) list = list.filter((j) => j.category === filters.category);
    return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async findById(id: string): Promise<OcrJob | null> {
    return (jsonStore.getState().ocrJobs || []).find((j) => j.id === id) || null;
  }

  async enqueue(input: EnqueueOcrJobInput): Promise<OcrJob> {
    const state = jsonStore.getState();
    if (!state.ocrJobs) state.ocrJobs = [];

    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const existing = state.ocrJobs.find(
      (j) =>
        (j.status === 'PENDING' || j.status === 'PROCESSING') &&
        j.originalFilename === input.originalFilename &&
        j.category === input.category &&
        j.fileSizeBytes === input.fileSizeBytes &&
        new Date(j.createdAt).getTime() > tenMinutesAgo
    );
    if (existing) return existing;

    const currentFy = await this.mastersRepo.findCurrentFinancialYear();
    const now = new Date().toISOString();
    const job: OcrJob = {
      id: crypto.randomUUID(),
      documentId: input.documentId,
      originalFilename: input.originalFilename,
      fileSizeBytes: input.fileSizeBytes,
      category: input.category,
      financialYearId: input.financialYearId || currentFy.id,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    };

    state.ocrJobs.unshift(job);
    jsonStore.save();
    return job;
  }

  async update(id: string, updates: Partial<OcrJob>): Promise<OcrJob> {
    const state = jsonStore.getState();
    const job = (state.ocrJobs || []).find((j) => j.id === id);
    if (!job) throw new NotFoundError('OCR job not found.');

    Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    jsonStore.save();
    return job;
  }

  async retry(id: string): Promise<OcrJob> {
    const state = jsonStore.getState();
    const job = (state.ocrJobs || []).find((j) => j.id === id);
    if (!job) throw new NotFoundError('OCR job not found.');

    job.status = 'PENDING';
    job.error = undefined;
    job.attempts = 0;
    job.lockedByWorkerId = undefined;
    job.lockedAt = undefined;
    job.leaseExpiresAt = undefined;
    job.updatedAt = new Date().toISOString();

    jsonStore.save();
    return job;
  }

  async delete(id: string): Promise<{ success: boolean }> {
    const state = jsonStore.getState();
    const idx = (state.ocrJobs || []).findIndex((j) => j.id === id);
    if (idx === -1) throw new NotFoundError('OCR job not found.');
    state.ocrJobs.splice(idx, 1);
    jsonStore.save();
    return { success: true };
  }

  async claimNextJob(workerId: string, leaseDurationMs = 60000): Promise<OcrJob | null> {
    const state = jsonStore.getState();
    if (!state.ocrJobs) state.ocrJobs = [];

    const now = Date.now();
    const eligibleIndex = state.ocrJobs.findIndex((j) => {
      if ((j.attempts || 0) >= (j.maxAttempts || 3)) return false;
      if (j.status === 'PENDING') return true;
      if (j.status === 'PROCESSING') {
        if (!j.leaseExpiresAt) return true;
        return new Date(j.leaseExpiresAt).getTime() < now;
      }
      return false;
    });

    if (eligibleIndex === -1) return null;

    const job = state.ocrJobs[eligibleIndex];
    job.status = 'PROCESSING';
    job.lockedByWorkerId = workerId;
    job.lockedAt = new Date(now).toISOString();
    job.leaseExpiresAt = new Date(now + leaseDurationMs).toISOString();
    job.attempts = (job.attempts || 0) + 1;
    job.updatedAt = new Date(now).toISOString();

    jsonStore.save();
    return { ...job };
  }

  async renewLease(jobId: string, workerId: string, additionalMs = 60000): Promise<boolean> {
    const job = (jsonStore.getState().ocrJobs || []).find((j) => j.id === jobId);
    if (!job || job.status !== 'PROCESSING' || job.lockedByWorkerId !== workerId) return false;

    job.leaseExpiresAt = new Date(Date.now() + additionalMs).toISOString();
    job.updatedAt = new Date().toISOString();
    jsonStore.save();
    return true;
  }

  async completeJob(jobId: string, workerId: string, result: CompleteOcrJobInput): Promise<OcrJob> {
    const job = (jsonStore.getState().ocrJobs || []).find((j) => j.id === jobId);
    if (!job) throw new NotFoundError('OCR job not found.');

    if (job.lockedByWorkerId && job.lockedByWorkerId !== workerId) {
      throw new ConflictError(
        `Lease violation: OCR job ${jobId} was reclaimed by worker ${job.lockedByWorkerId}; commit rejected.`
      );
    }
    if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() < Date.now()) {
      throw new ConflictError(
        `Lease expired: OCR job ${jobId} lease expired at ${job.leaseExpiresAt}; commit rejected.`
      );
    }

    job.status = 'COMPLETED';
    job.lockedByWorkerId = undefined;
    job.leaseExpiresAt = undefined;
    job.executionTimeMs = result.executionTimeMs;
    job.ocrApplied = result.ocrApplied;
    job.ocrConfidence = result.ocrConfidence;
    job.ocrTextPreview = result.ocrTextPreview;
    job.extractionMethod = result.extractionMethod;
    job.candidateFields = result.candidateFields;
    job.candidateDraft = result.candidateDraft;
    job.error = undefined;
    job.updatedAt = new Date().toISOString();

    jsonStore.save();
    return job;
  }

  async failJob(jobId: string, _workerId: string, errorMsg: string, executionTimeMs?: number): Promise<OcrJob> {
    const job = (jsonStore.getState().ocrJobs || []).find((j) => j.id === jobId);
    if (!job) throw new NotFoundError('OCR job not found.');

    const maxAttempts = job.maxAttempts || 3;
    const isFinalFailure = (job.attempts || 0) >= maxAttempts;

    job.status = isFinalFailure ? 'FAILED' : 'PENDING';
    job.lockedByWorkerId = undefined;
    job.leaseExpiresAt = undefined;
    job.error = errorMsg;
    if (executionTimeMs !== undefined) job.executionTimeMs = executionTimeMs;
    job.updatedAt = new Date().toISOString();

    jsonStore.save();
    return job;
  }

  async approveJob(
    jobId: string,
    reviewedValues: Record<string, any>,
    actorUserId: string
  ): Promise<{ shipment?: Shipment; payment?: Payment; job: OcrJob }> {
    const state = jsonStore.getState();
    const job = (state.ocrJobs || []).find((j) => j.id === jobId);
    if (!job) throw new NotFoundError('OCR job not found.');

    const user = state.users.find((u) => u.id === actorUserId);
    let targetShipment: Shipment | undefined;
    let targetPayment: Payment | undefined;

    if (
      job.category === 'COMMERCIAL_INVOICE' ||
      job.category === 'SHIPPING_BILL' ||
      job.category === 'BILL_OF_LADING' ||
      job.category === 'ADDITIONAL_DOC'
    ) {
      const invoiceNumber = String(reviewedValues.invoiceNumber || job.candidateDraft?.invoiceNumber || '').trim();
      if (!invoiceNumber) {
        throw new ValidationError('Invoice Number is required to commit approved shipment data.');
      }

      const fyId = job.financialYearId || (await this.mastersRepo.findCurrentFinancialYear()).id;
      const normalizedKey = normalizeInvoiceKey(invoiceNumber);
      const existing = await this.shipmentsRepo.findByNormalizedKey(normalizedKey, fyId);

      if (existing) {
        targetShipment = await this.shipmentsRepo.update(existing.id, {
          invoiceDate: reviewedValues.invoiceDate || existing.invoiceDate,
          invoiceValueUsd:
            reviewedValues.invoiceValueUsd !== undefined
              ? Number(reviewedValues.invoiceValueUsd)
              : existing.invoiceValueUsd,
          shippingBillNumber: reviewedValues.shippingBillNumber || existing.shippingBillNumber,
          shippingBillDate: reviewedValues.shippingBillDate || existing.shippingBillDate,
          sbExchangeRate:
            reviewedValues.sbExchangeRate !== undefined
              ? Number(reviewedValues.sbExchangeRate)
              : existing.sbExchangeRate,
          fobValueInr:
            reviewedValues.fobValueInr !== undefined ? Number(reviewedValues.fobValueInr) : existing.fobValueInr,
          blNumber: reviewedValues.blNumber !== undefined ? reviewedValues.blNumber : existing.blNumber,
          blDate: reviewedValues.blDate !== undefined ? reviewedValues.blDate : existing.blDate,
          vesselName: reviewedValues.vesselName !== undefined ? reviewedValues.vesselName : existing.vesselName,
          packageCount:
            reviewedValues.packageCount !== undefined ? Number(reviewedValues.packageCount) : existing.packageCount,
          portCode: reviewedValues.portCode || existing.portCode,
          reviewStatus: 'CONFIRMED',
        });
      } else {
        let consigneeId = reviewedValues.consigneeId as string | undefined;
        if (!consigneeId && (reviewedValues.consigneeName || job.candidateDraft?.consigneeName)) {
          const cName = String(reviewedValues.consigneeName || job.candidateDraft?.consigneeName || '').trim();
          const found = await this.mastersRepo.findConsigneeByName(cName);
          if (found) {
            consigneeId = found.id;
          } else if (cName) {
            const created = await this.mastersRepo.createConsignee({
              name: cName,
              country: 'International',
              portOfDischarge: reviewedValues.portCode || 'LKCMB',
              paymentTerms: 'DA 90 DAYS',
              currency: 'USD',
              isActive: true,
            });
            consigneeId = created.id;
          }
        }
        if (!consigneeId) {
          const consignees = await this.mastersRepo.findConsignees();
          consigneeId = consignees[0]?.id || '';
        }

        const hasFirc = Boolean(reviewedValues.initialFircPaymentId || reviewedValues.initialFircDocumentUploaded);
        if (!hasFirc) {
          throw new ValidationError(
            'Mandatory Rule Violation: A valid FIRC/payment document or IRM reference must be linked before saving a shipment.'
          );
        }

        targetShipment = await this.shipmentsRepo.create({
          financialYearId: fyId,
          invoiceNumber,
          invoiceDate: reviewedValues.invoiceDate || new Date().toISOString().split('T')[0],
          consigneeId,
          portCode: reviewedValues.portCode || 'INMAA1',
          packageCount: Number(reviewedValues.packageCount || 0),
          invoiceValueUsd: Number(reviewedValues.invoiceValueUsd || 0),
          shippingBillNumber: reviewedValues.shippingBillNumber || 'PENDING',
          shippingBillDate: reviewedValues.shippingBillDate || new Date().toISOString().split('T')[0],
          sbExchangeRate: Number(reviewedValues.sbExchangeRate || 92.1),
          fobValueInr: Number(reviewedValues.fobValueInr || 0),
          blNumber: reviewedValues.blNumber,
          blDate: reviewedValues.blDate,
          vesselName: reviewedValues.vesselName,
          remarks: reviewedValues.remarks,
          reviewStatus: 'CONFIRMED',
          initialFircPaymentId: reviewedValues.initialFircPaymentId,
          initialFircDocumentUploaded: Boolean(
            reviewedValues.initialFircPaymentId || reviewedValues.initialFircDocumentUploaded
          ),
          incentives: {
            dbkClaimed: Number(reviewedValues.dbkClaimed || 0),
            rodtepClaimed: Number(reviewedValues.rodtepClaimed || 0),
            rosctlClaimed: Number(reviewedValues.rosctlClaimed || 0),
          },
          actorUserId,
        });
      }

      job.targetShipmentId = targetShipment.id;
    } else if (job.category === 'FIRC_PAYMENT') {
      const irmNumber = String(
        reviewedValues.irmNumber || job.candidateFields?.irmNumber?.value || ''
      )
        .trim()
        .toUpperCase();
      if (!irmNumber) {
        throw new ValidationError('Inward Remittance Number (IRM) is required to commit payment data.');
      }

      const existingPayment = await this.paymentsRepo.findByIrmNumber(irmNumber);
      if (existingPayment) {
        targetPayment = await this.paymentsRepo.update(existingPayment.id, {
          verifiedAmount:
            reviewedValues.verifiedAmount !== undefined
              ? Number(reviewedValues.verifiedAmount)
              : existingPayment.verifiedAmount,
          exchangeRate:
            reviewedValues.exchangeRate !== undefined
              ? Number(reviewedValues.exchangeRate)
              : existingPayment.exchangeRate,
          inrAmount:
            reviewedValues.inrAmount !== undefined ? Number(reviewedValues.inrAmount) : existingPayment.inrAmount,
          valueDate: reviewedValues.valueDate || existingPayment.valueDate,
          creditDate: reviewedValues.creditDate || existingPayment.creditDate,
        });
      } else {
        const banks = await this.mastersRepo.findBanks();
        targetPayment = await this.paymentsRepo.create({
          irmNumber,
          senderReference: reviewedValues.senderReference,
          currency: reviewedValues.currency || 'USD',
          verifiedAmount: Number(reviewedValues.verifiedAmount || 0),
          exchangeRate: Number(reviewedValues.exchangeRate || 93.28),
          inrAmount: Number(reviewedValues.inrAmount || 0),
          valueDate: reviewedValues.valueDate || new Date().toISOString().split('T')[0],
          creditDate: reviewedValues.creditDate || new Date().toISOString().split('T')[0],
          bankId: reviewedValues.bankId || banks[0]?.id || '',
          purposeCode: reviewedValues.purposeCode || 'P0103',
          remarks: reviewedValues.remarks,
        });
      }

      job.targetPaymentId = targetPayment.id;
    }

    if (job.documentId) {
      const doc = state.documents.find((d) => d.id === job.documentId);
      if (doc) {
        if (targetShipment && !doc.shipmentId) doc.shipmentId = targetShipment.id;
        if (targetPayment && !doc.paymentId) doc.paymentId = targetPayment.id;
        doc.reviewStatus = 'CONFIRMED';
        doc.updatedAt = new Date().toISOString();
      }
    }

    job.approvedAt = new Date().toISOString();
    job.approvedByUserId = actorUserId;
    job.approvedByName = user?.name || 'Administrator';
    job.updatedAt = new Date().toISOString();

    jsonStore.save();
    return { shipment: targetShipment, payment: targetPayment, job };
  }
}
