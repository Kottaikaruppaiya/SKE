/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type {
  BrcRecord,
  DocumentCategory,
  DocumentRecord,
  IncentiveRecord,
  Payment,
  ReviewStatus,
  Shipment,
} from '../../../shared/contracts/index.ts';
import { normalizeInvoiceKey } from '../../../shared/utils/invoiceNormalizer.ts';
import { computeStatutoryBrcDeadline } from '../../domain/calculations/brc.calc.ts';
import { deriveIncentiveStatus } from '../../domain/calculations/incentive.calc.ts';
import {
  calculateFobValueInr,
  computePaymentAllocationBalances,
  deriveShipmentPaymentStatus,
} from '../../domain/calculations/shipment.calc.ts';
import { round2 } from '../../domain/calculations/money.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors/AppError.ts';
import { hydrateShipmentDto } from '../../infrastructure/hydration.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';
import {
  bigIntToNumber,
  decimalToNumber,
  toDateOrUndefined,
  toIsoDate,
  toIsoTimestamp,
} from '../../infrastructure/prismaMappers.ts';

export interface ShipmentFilter {
  financialYearId?: string;
  consigneeId?: string;
  paymentStatus?: string;
  reviewStatus?: string;
  search?: string;
  includeArchived?: boolean;
}

export interface CreateShipmentRepoInput {
  financialYearId: string;
  invoiceNumber: string;
  invoiceDate: string;
  consigneeId: string;
  portCode: string;
  packageCount?: number;
  invoiceValueUsd: number;
  shippingBillNumber: string;
  shippingBillDate: string;
  sbExchangeRate: number;
  fobValueInr: number;
  blNumber?: string;
  blDate?: string;
  vesselName?: string;
  remarks?: string;
  reviewStatus?: ReviewStatus;
  initialFircPaymentId?: string;
  initialFircAllocationAmount?: number;
  initialFircDocumentUploaded?: boolean;
  incentives?: {
    dbkClaimed?: number;
    rodtepClaimed?: number;
    rosctlClaimed?: number;
  };
  brc?: {
    uploadMode?: 'SINGLE' | 'MULTIPLE';
    statutoryDeadline?: string;
    remarks?: string;
  };
  actorUserId: string;
}

export interface CreateShipmentWithDocsInput {
  financialYearId: string;
  invoiceNumber: string;
  brcUploadMode: 'SINGLE' | 'MULTIPLE';
  remarks?: string;
  consigneeId?: string;
  consigneeName?: string;
  portCode: string;
  packageCount: number;
  invoiceDate: string;
  invoiceValueUsd: number;
  shippingBillNumber: string;
  shippingBillDate: string;
  sbExchangeRate: number;
  fobValueInr: number;
  blNumber?: string;
  blDate?: string;
  vesselName?: string;
  fircIrmNumber?: string;
  fircSenderRef?: string;
  fircCreditDate?: string;
  fircValueDate?: string;
  fircAmountUsd?: number;
  fircExchangeRate?: number;
  fircInrAmount?: number;
  fircBankName?: string;
  brcNumber?: string;
  brcIssueDate?: string;
  brcRealisationDate?: string;
  brcRealisedAmount?: number;
  statutoryDeadline?: string;
  dbkClaimed: number;
  rodtepClaimed: number;
  rosctlClaimed: number;
  hasFircEvidence: boolean;
  documentsToRegister: Array<{
    category: DocumentCategory;
    originalFilename: string;
    storedPath: string;
    mimeType: string;
    fileSizeBytes: number;
    extractedData?: Record<string, any>;
    reviewStatus?: ReviewStatus;
    ocrApplied?: boolean;
    ocrConfidence?: number;
    ocrTextPreview?: string;
    extractionMethod?: 'PDF_TEXT' | 'LOCAL_OCR';
  }>;
  actorUserId: string;
}

export interface IShipmentsRepository {
  findAll(filters?: ShipmentFilter): Promise<Shipment[]>;
  findById(id: string): Promise<Shipment | null>;
  findByNormalizedKey(normalizedKey: string, financialYearId: string): Promise<Shipment | null>;
  lookup(query: string, financialYearId?: string): Promise<Shipment[]>;
  create(input: CreateShipmentRepoInput): Promise<Shipment>;
  createWithDocumentsTransaction(input: CreateShipmentWithDocsInput): Promise<Shipment>;
  update(id: string, updates: Record<string, any>): Promise<Shipment>;
  archive(id: string, reason: string | undefined, actorUserId: string): Promise<Shipment>;
  restore(id: string, actorUserId: string): Promise<Shipment>;
  delete(id: string): Promise<{ success: boolean }>;
}

const PRISMA_SHIPMENT_INCLUDE = {
  consignee: true,
  financialYear: true,
  allocations: { include: { payment: true } },
  documents: { where: { isCurrent: true }, include: { uploadedByUser: true } },
  incentives: true,
  brcRecord: true,
} as const;

function mapPrismaShipment(row: any, userNamesMap?: Map<string, string>): Shipment {
  const base: Shipment = {
    id: row.id,
    financialYearId: row.financialYearId,
    invoiceNumber: row.invoiceNumber,
    normalizedInvoiceKey: row.normalizedInvoiceKey,
    invoiceDate: toIsoDate(row.invoiceDate),
    consigneeId: row.consigneeId,
    portCode: row.portCode,
    packageCount: row.packageCount ?? 0,
    invoiceValueUsd: decimalToNumber(row.invoiceValueUsd),
    shippingBillNumber: row.shippingBillNumber,
    shippingBillDate: toIsoDate(row.shippingBillDate),
    sbExchangeRate: decimalToNumber(row.sbExchangeRate),
    fobValueInr: decimalToNumber(row.fobValueInr),
    blNumber: row.blNumber || undefined,
    blDate: toDateOrUndefined(row.blDate),
    vesselName: row.vesselName || undefined,
    paymentStatus: row.paymentStatus,
    reviewStatus: row.reviewStatus,
    remarks: row.remarks || undefined,
    isArchived: Boolean(row.isArchived),
    archivedAt: row.archivedAt ? toIsoTimestamp(row.archivedAt) : undefined,
    archivedBy: row.archivedBy || undefined,
    archivedReason: row.archivedReason || undefined,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };

  const allocations = (row.allocations || []).map((a: any) => ({
    id: a.id,
    paymentId: a.paymentId,
    shipmentId: a.shipmentId,
    allocatedAmountUsd: decimalToNumber(a.allocatedAmountUsd),
    notes: a.notes || undefined,
    allocatedAt: toIsoTimestamp(a.allocatedAt),
    allocatedByUserId: a.allocatedByUserId,
    allocatedByName: userNamesMap?.get(a.allocatedByUserId) || undefined,
    paymentIrm: a.payment?.irmNumber,
    exchangeRate: a.payment?.exchangeRate ? decimalToNumber(a.payment.exchangeRate) : null,
  }));

  const documents: DocumentRecord[] = (row.documents || []).map((d: any) => ({
    id: d.id,
    shipmentId: d.shipmentId || undefined,
    paymentId: d.paymentId || undefined,
    category: d.category,
    originalFilename: d.originalFilename,
    storedPath: d.storedPath,
    mimeType: d.mimeType,
    fileSizeBytes: bigIntToNumber(d.fileSizeBytes),
    version: d.version,
    isCurrent: d.isCurrent,
    reviewStatus: d.reviewStatus,
    ocrApplied: d.ocrApplied,
    ocrConfidence: d.ocrConfidence ?? undefined,
    ocrTextPreview: d.ocrTextPreview || undefined,
    extractionMethod: d.extractionMethod || undefined,
    extractedFieldsJson: d.extractedFieldsJson || undefined,
    extractedData: d.extractedData || undefined,
    uploadedByUserId: d.uploadedByUserId,
    uploadedByName: d.uploadedByUser?.name,
    createdAt: toIsoTimestamp(d.createdAt),
    updatedAt: toIsoTimestamp(d.updatedAt),
  }));

  const incentives: IncentiveRecord[] = (row.incentives || []).map((i: any) => ({
    id: i.id,
    shipmentId: i.shipmentId,
    type: i.type,
    claimedAmount: decimalToNumber(i.claimedAmount),
    status: i.status,
    receivedAmount: decimalToNumber(i.receivedAmount),
    receivedDate: toDateOrUndefined(i.receivedDate),
    scrollNumber: i.scrollNumber || undefined,
    remarks: i.remarks || undefined,
    createdAt: toIsoTimestamp(i.createdAt),
    updatedAt: toIsoTimestamp(i.updatedAt),
  }));

  const brcRecord: BrcRecord | undefined = row.brcRecord
    ? {
        id: row.brcRecord.id,
        shipmentId: row.brcRecord.shipmentId,
        brcNumber: row.brcRecord.brcNumber || undefined,
        issueDate: toDateOrUndefined(row.brcRecord.issueDate),
        realisationDate: toDateOrUndefined(row.brcRecord.realisationDate),
        realisedAmount:
          row.brcRecord.realisedAmount !== null && row.brcRecord.realisedAmount !== undefined
            ? decimalToNumber(row.brcRecord.realisedAmount)
            : undefined,
        realisedCurrency: row.brcRecord.realisedCurrency || undefined,
        uploadMode: row.brcRecord.uploadMode,
        statutoryDeadline: toDateOrUndefined(row.brcRecord.statutoryDeadline),
        status: row.brcRecord.status,
        remarks: row.brcRecord.remarks || undefined,
        createdAt: toIsoTimestamp(row.brcRecord.createdAt),
        updatedAt: toIsoTimestamp(row.brcRecord.updatedAt),
      }
    : undefined;

  return hydrateShipmentDto({
    shipment: base,
    consigneeName: row.consignee?.name,
    financialYearLabel: row.financialYear?.label,
    allocations,
    documents,
    incentives,
    brcRecord,
  });
}

export class PrismaShipmentsRepository implements IShipmentsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll(filters?: ShipmentFilter): Promise<Shipment[]> {
    const where: any = {};
    if (!filters?.includeArchived) {
      where.isArchived = false;
    }
    if (filters?.financialYearId && filters.financialYearId !== 'ALL') {
      where.financialYearId = filters.financialYearId;
    }
    if (filters?.consigneeId) {
      where.consigneeId = filters.consigneeId;
    }
    if (filters?.paymentStatus) {
      where.paymentStatus = filters.paymentStatus;
    }
    if (filters?.reviewStatus) {
      where.reviewStatus = filters.reviewStatus;
    }
    if (filters?.search?.trim()) {
      const q = filters.search.trim();
      where.OR = [
        { invoiceNumber: { contains: q, mode: 'insensitive' } },
        { normalizedInvoiceKey: { contains: q, mode: 'insensitive' } },
        { shippingBillNumber: { contains: q, mode: 'insensitive' } },
        { blNumber: { contains: q, mode: 'insensitive' } },
        { portCode: { contains: q, mode: 'insensitive' } },
        { remarks: { contains: q, mode: 'insensitive' } },
        { consignee: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const rows = await this.prisma.shipment.findMany({
      where,
      include: PRISMA_SHIPMENT_INCLUDE,
      orderBy: { invoiceDate: 'desc' },
    });

    const users = await this.prisma.user.findMany({ select: { id: true, name: true } });
    const userNamesMap = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => mapPrismaShipment(r, userNamesMap));
  }

  async findById(id: string): Promise<Shipment | null> {
    const row = await this.prisma.shipment.findUnique({
      where: { id },
      include: PRISMA_SHIPMENT_INCLUDE,
    });
    if (!row) return null;
    const users = await this.prisma.user.findMany({ select: { id: true, name: true } });
    const userNamesMap = new Map(users.map((u) => [u.id, u.name]));
    return mapPrismaShipment(row, userNamesMap);
  }

  async findByNormalizedKey(normalizedKey: string, financialYearId: string): Promise<Shipment | null> {
    const row = await this.prisma.shipment.findUnique({
      where: {
        financialYearId_normalizedInvoiceKey: {
          financialYearId,
          normalizedInvoiceKey: normalizedKey,
        },
      },
      include: PRISMA_SHIPMENT_INCLUDE,
    });
    return row ? mapPrismaShipment(row) : null;
  }

  async lookup(query: string, financialYearId?: string): Promise<Shipment[]> {
    const q = query.trim();
    if (!q) return [];
    const normalized = normalizeInvoiceKey(q);
    const where: any = {
      isArchived: false,
      OR: [
        { normalizedInvoiceKey: normalized },
        { invoiceNumber: { contains: q, mode: 'insensitive' } },
        { shippingBillNumber: { contains: q } },
        { blNumber: { contains: q, mode: 'insensitive' } },
      ],
    };
    if (financialYearId && financialYearId !== 'ALL') {
      where.financialYearId = financialYearId;
    }
    const rows = await this.prisma.shipment.findMany({
      where,
      include: PRISMA_SHIPMENT_INCLUDE,
    });
    return rows.map((r) => mapPrismaShipment(r));
  }

  async create(input: CreateShipmentRepoInput): Promise<Shipment> {
    const normalizedKey = normalizeInvoiceKey(input.invoiceNumber);

    const createdId = await this.prisma.$transaction(async (tx) => {
      const duplicate = await tx.shipment.findUnique({
        where: {
          financialYearId_normalizedInvoiceKey: {
            financialYearId: input.financialYearId,
            normalizedInvoiceKey: normalizedKey,
          },
        },
      });
      if (duplicate) {
        throw new ConflictError(
          `Duplicate Invoice Identity: An invoice with key '${normalizedKey}' already exists in Financial Year '${input.financialYearId}'. (Existing: ${duplicate.invoiceNumber})`
        );
      }

      let resolvedConsigneeId = input.consigneeId;
      if (!resolvedConsigneeId) {
        const firstConsignee = await tx.consigneeMaster.findFirst();
        resolvedConsigneeId = firstConsignee?.id || '';
      }

      const settingRow = await tx.appSetting.findUnique({ where: { key: 'statutoryBrcDays' } });
      const statutoryDays = settingRow ? parseInt(settingRow.value, 10) || 270 : 270;
      const defaultDeadline = computeStatutoryBrcDeadline(input.shippingBillDate, statutoryDays);

      const fob = input.fobValueInr || calculateFobValueInr(input.invoiceValueUsd, input.sbExchangeRate);

      const created = await tx.shipment.create({
        data: {
          financialYearId: input.financialYearId,
          invoiceNumber: input.invoiceNumber.trim(),
          normalizedInvoiceKey: normalizedKey,
          invoiceDate: new Date(input.invoiceDate),
          consigneeId: resolvedConsigneeId,
          portCode: input.portCode.trim().toUpperCase(),
          packageCount: input.packageCount || 0,
          invoiceValueUsd: input.invoiceValueUsd,
          shippingBillNumber: input.shippingBillNumber.trim(),
          shippingBillDate: new Date(input.shippingBillDate),
          sbExchangeRate: input.sbExchangeRate,
          fobValueInr: fob,
          blNumber: input.blNumber?.trim() || null,
          blDate: input.blDate ? new Date(input.blDate) : null,
          vesselName: input.vesselName?.trim() || null,
          remarks: input.remarks?.trim() || null,
          paymentStatus: 'UNPAID',
          reviewStatus: input.reviewStatus || 'CONFIRMED',
        },
      });

      if (input.incentives) {
        const pairs: Array<{ type: 'DRAWBACK' | 'RODTEP' | 'ROSCTL'; val?: number }> = [
          { type: 'DRAWBACK', val: input.incentives.dbkClaimed },
          { type: 'RODTEP', val: input.incentives.rodtepClaimed },
          { type: 'ROSCTL', val: input.incentives.rosctlClaimed },
        ];
        for (const p of pairs) {
          if (p.val !== undefined && p.val >= 0) {
            await tx.incentiveRecord.create({
              data: {
                shipmentId: created.id,
                type: p.type,
                claimedAmount: Number(p.val),
                status: 'PENDING',
                receivedAmount: 0,
              },
            });
          }
        }
      }

      await tx.brcRecord.create({
        data: {
          shipmentId: created.id,
          uploadMode: input.brc?.uploadMode || 'SINGLE',
          statutoryDeadline: new Date(input.brc?.statutoryDeadline || defaultDeadline),
          status: 'PENDING',
          remarks: input.brc?.remarks || null,
        },
      });

      if (input.initialFircPaymentId) {
        const lockedPayments = await tx.$queryRaw<any[]>`
          SELECT id, "irmNumber", "verifiedAmount"
          FROM "Payment"
          WHERE id = ${input.initialFircPaymentId}
          FOR UPDATE
        `;
        const paymentRow = lockedPayments[0];
        if (!paymentRow) throw new NotFoundError('Payment record not found.');

        const allocAmount = Number(input.initialFircAllocationAmount || input.invoiceValueUsd);
        if (allocAmount <= 0) {
          throw new ValidationError('Allocation amount must be strictly greater than 0.');
        }

        const existingPaymentAllocs = await tx.paymentAllocation.findMany({
          where: { paymentId: paymentRow.id },
        });
        const { availableBalanceUsd } = computePaymentAllocationBalances(
          decimalToNumber(paymentRow.verifiedAmount),
          existingPaymentAllocs.map((a) => ({ allocatedAmountUsd: decimalToNumber(a.allocatedAmountUsd) }))
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
            notes: 'Initial allocation on shipment creation',
            allocatedByUserId: input.actorUserId,
          },
        });

        await tx.shipment.update({
          where: { id: created.id },
          data: {
            paymentStatus: deriveShipmentPaymentStatus(input.invoiceValueUsd, allocAmount),
          },
        });
      }

      return created.id;
    });

    const full = await this.findById(createdId);
    if (!full) throw new NotFoundError('Created shipment could not be loaded.');
    return full;
  }

  async createWithDocumentsTransaction(input: CreateShipmentWithDocsInput): Promise<Shipment> {
    const normalizedKey = normalizeInvoiceKey(input.invoiceNumber);

    const shipmentId = await this.prisma.$transaction(async (tx) => {
      const duplicate = await tx.shipment.findUnique({
        where: {
          financialYearId_normalizedInvoiceKey: {
            financialYearId: input.financialYearId,
            normalizedInvoiceKey: normalizedKey,
          },
        },
      });
      if (duplicate) {
        throw new ConflictError(
          `Duplicate Invoice Identity: An invoice with key '${normalizedKey}' already exists in Financial Year '${input.financialYearId}'.`
        );
      }

      // Match or create consignee
      let resolvedConsigneeId = input.consigneeId;
      if (!resolvedConsigneeId && input.consigneeName) {
        const found = await tx.consigneeMaster.findFirst({
          where: { name: { equals: input.consigneeName.trim(), mode: 'insensitive' } },
        });
        if (found) {
          resolvedConsigneeId = found.id;
        } else {
          const createdConsignee = await tx.consigneeMaster.create({
            data: {
              name: input.consigneeName.trim(),
              country: input.consigneeName.toLowerCase().includes('lanka') ? 'Sri Lanka' : 'International',
              portOfDischarge: 'LKCMB - Colombo',
              paymentTerms: 'FOB COLOMBO | DA 90 DAYS',
              currency: 'USD',
              isActive: true,
            },
          });
          resolvedConsigneeId = createdConsignee.id;
        }
      }
      if (!resolvedConsigneeId) {
        const first = await tx.consigneeMaster.findFirst();
        resolvedConsigneeId = first?.id;
      }
      if (!resolvedConsigneeId) {
        throw new ValidationError('Consignee is required.');
      }

      // Match bank
      const banks = await tx.bankMaster.findMany();
      let resolvedBankId = banks[0]?.id;
      if (input.fircBankName) {
        const bankMatch = banks.find((b) => b.name.toLowerCase().includes(input.fircBankName!.toLowerCase()));
        if (bankMatch) resolvedBankId = bankMatch.id;
      }

      const settingRow = await tx.appSetting.findUnique({ where: { key: 'statutoryBrcDays' } });
      const statutoryDays = settingRow ? parseInt(settingRow.value, 10) || 270 : 270;
      const defaultDeadline = computeStatutoryBrcDeadline(input.shippingBillDate, statutoryDays);

      const shipment = await tx.shipment.create({
        data: {
          financialYearId: input.financialYearId,
          invoiceNumber: input.invoiceNumber.trim(),
          normalizedInvoiceKey: normalizedKey,
          invoiceDate: new Date(input.invoiceDate),
          consigneeId: resolvedConsigneeId,
          portCode: input.portCode.trim().toUpperCase(),
          packageCount: input.packageCount,
          invoiceValueUsd: input.invoiceValueUsd,
          shippingBillNumber: input.shippingBillNumber.trim(),
          shippingBillDate: new Date(input.shippingBillDate),
          sbExchangeRate: input.sbExchangeRate,
          fobValueInr: input.fobValueInr,
          blNumber: input.blNumber?.trim() || null,
          blDate: input.blDate ? new Date(input.blDate) : null,
          vesselName: input.vesselName?.trim() || null,
          remarks: input.remarks?.trim() || null,
          paymentStatus: 'UNPAID',
          reviewStatus: 'CONFIRMED',
        },
      });

      const incentives: Array<{ type: 'DRAWBACK' | 'RODTEP' | 'ROSCTL'; val: number }> = [
        { type: 'DRAWBACK', val: input.dbkClaimed },
        { type: 'RODTEP', val: input.rodtepClaimed },
        { type: 'ROSCTL', val: input.rosctlClaimed },
      ];
      for (const inc of incentives) {
        await tx.incentiveRecord.create({
          data: {
            shipmentId: shipment.id,
            type: inc.type,
            claimedAmount: inc.val,
            status: 'PENDING',
            receivedAmount: 0,
          },
        });
      }

      await tx.brcRecord.create({
        data: {
          shipmentId: shipment.id,
          uploadMode: input.brcUploadMode,
          statutoryDeadline: new Date(input.statutoryDeadline || defaultDeadline),
          status: input.brcNumber ? 'REALISED' : 'PENDING',
          brcNumber: input.brcNumber?.trim() || null,
          issueDate: input.brcIssueDate ? new Date(input.brcIssueDate) : null,
          realisationDate: input.brcRealisationDate ? new Date(input.brcRealisationDate) : null,
          realisedAmount: input.brcNumber ? input.brcRealisedAmount ?? input.invoiceValueUsd : null,
          realisedCurrency: 'USD',
          remarks: input.remarks?.trim() || null,
        },
      });

      if (input.fircIrmNumber && resolvedBankId) {
        const cleanIrm = input.fircIrmNumber.trim().toUpperCase();
        let payment = await tx.payment.findUnique({ where: { irmNumber: cleanIrm } });
        const fircAmt = Number(input.fircAmountUsd || input.invoiceValueUsd);

        if (!payment) {
          payment = await tx.payment.create({
            data: {
              irmNumber: cleanIrm,
              senderReference: input.fircSenderRef || null,
              currency: 'USD',
              verifiedAmount: fircAmt,
              inrAmount: input.fircInrAmount ?? round2(fircAmt * (input.fircExchangeRate || 93.28)),
              exchangeRate: input.fircExchangeRate || 93.28,
              valueDate: new Date(input.fircValueDate || input.invoiceDate),
              creditDate: new Date(input.fircCreditDate || input.invoiceDate),
              fircIssueDate: new Date(input.fircCreditDate || input.invoiceDate),
              bankId: resolvedBankId,
              purposeCode: 'P0103',
              remarks: `Payment for invoice ${input.invoiceNumber.trim()}`,
            },
          });
        }

        const allocAmount = Math.min(fircAmt, input.invoiceValueUsd);
        if (allocAmount > 0) {
          await tx.paymentAllocation.create({
            data: {
              paymentId: payment.id,
              shipmentId: shipment.id,
              allocatedAmountUsd: allocAmount,
              notes: `Auto-allocated on shipment creation (${input.invoiceNumber.trim()})`,
              allocatedByUserId: input.actorUserId,
            },
          });

          await tx.shipment.update({
            where: { id: shipment.id },
            data: {
              paymentStatus: deriveShipmentPaymentStatus(input.invoiceValueUsd, allocAmount),
            },
          });
        }
      }

      for (const docSpec of input.documentsToRegister) {
        await tx.document.create({
          data: {
            shipmentId: shipment.id,
            category: docSpec.category,
            originalFilename: docSpec.originalFilename,
            storedPath: docSpec.storedPath,
            mimeType: docSpec.mimeType,
            fileSizeBytes: BigInt(docSpec.fileSizeBytes),
            version: 1,
            isCurrent: true,
            reviewStatus: docSpec.reviewStatus || 'CONFIRMED',
            ocrApplied: Boolean(docSpec.ocrApplied),
            ocrConfidence: docSpec.ocrConfidence ?? null,
            ocrTextPreview: docSpec.ocrTextPreview || null,
            extractionMethod: docSpec.extractionMethod || 'PDF_TEXT',
            extractedData: docSpec.extractedData || undefined,
            uploadedByUserId: input.actorUserId,
          },
        });
      }

      return shipment.id;
    });

    const full = await this.findById(shipmentId);
    if (!full) throw new NotFoundError('Created shipment could not be loaded.');
    return full;
  }

  async update(id: string, updates: Record<string, any>): Promise<Shipment> {
    await this.prisma.$transaction(async (tx) => {
      const shipment = await tx.shipment.findUnique({
        where: { id },
        include: { allocations: true, incentives: true, brcRecord: true },
      });
      if (!shipment) throw new NotFoundError('Shipment not found.');

      const dataToUpdate: Record<string, any> = {};
      if (updates.invoiceNumber && updates.invoiceNumber !== shipment.invoiceNumber) {
        const newKey = normalizeInvoiceKey(updates.invoiceNumber);
        const fyId = updates.financialYearId || shipment.financialYearId;
        const dup = await tx.shipment.findFirst({
          where: { id: { not: id }, financialYearId: fyId, normalizedInvoiceKey: newKey },
        });
        if (dup) throw new ConflictError(`Another shipment with key '${newKey}' exists in this Financial Year.`);
        dataToUpdate.invoiceNumber = String(updates.invoiceNumber).trim();
        dataToUpdate.normalizedInvoiceKey = newKey;
      }

      if (updates.consigneeId) dataToUpdate.consigneeId = updates.consigneeId;
      if (updates.consigneeName) {
        const match = await tx.consigneeMaster.findFirst({
          where: { name: { equals: String(updates.consigneeName).trim(), mode: 'insensitive' } },
        });
        if (match) dataToUpdate.consigneeId = match.id;
      }
      if (updates.financialYearId) dataToUpdate.financialYearId = updates.financialYearId;
      if (updates.invoiceDate) dataToUpdate.invoiceDate = new Date(updates.invoiceDate);
      if (updates.portCode) dataToUpdate.portCode = String(updates.portCode).trim().toUpperCase();
      if (updates.packageCount !== undefined) dataToUpdate.packageCount = Number(updates.packageCount);

      let nextInvoiceVal = decimalToNumber(shipment.invoiceValueUsd);
      if (updates.invoiceValueUsd !== undefined) {
        const newInvVal = Number(updates.invoiceValueUsd);
        if (newInvVal < 0) throw new ValidationError('Invoice Value cannot be negative.');
        const totalAllocated = shipment.allocations.reduce(
          (sum, a) => sum + decimalToNumber(a.allocatedAmountUsd),
          0
        );
        if (newInvVal < totalAllocated - 0.001) {
          throw new ValidationError(
            `Cannot reduce Invoice Value ($${newInvVal.toFixed(2)}) below already allocated payment amount ($${totalAllocated.toFixed(2)}) on Invoice ${shipment.invoiceNumber}. Please reverse excess payment allocations first.`
          );
        }
        nextInvoiceVal = newInvVal;
        dataToUpdate.invoiceValueUsd = newInvVal;
      }

      if (updates.shippingBillNumber) dataToUpdate.shippingBillNumber = String(updates.shippingBillNumber).trim();
      if (updates.shippingBillDate) dataToUpdate.shippingBillDate = new Date(updates.shippingBillDate);

      const nextRate =
        updates.sbExchangeRate !== undefined ? Number(updates.sbExchangeRate) : decimalToNumber(shipment.sbExchangeRate);
      if (updates.sbExchangeRate !== undefined) dataToUpdate.sbExchangeRate = nextRate;

      if (updates.fobValueInr !== undefined) {
        dataToUpdate.fobValueInr = Number(updates.fobValueInr);
      } else if (updates.invoiceValueUsd !== undefined || updates.sbExchangeRate !== undefined) {
        dataToUpdate.fobValueInr = calculateFobValueInr(nextInvoiceVal, nextRate);
      }

      if (updates.blNumber !== undefined) dataToUpdate.blNumber = updates.blNumber ? String(updates.blNumber).trim() : null;
      if (updates.blDate !== undefined) dataToUpdate.blDate = updates.blDate ? new Date(updates.blDate) : null;
      if (updates.vesselName !== undefined) {
        dataToUpdate.vesselName = updates.vesselName ? String(updates.vesselName).trim() : null;
      }
      if (updates.remarks !== undefined) dataToUpdate.remarks = updates.remarks ? String(updates.remarks).trim() : null;
      if (updates.reviewStatus) dataToUpdate.reviewStatus = updates.reviewStatus;

      const totalPaid = shipment.allocations.reduce((sum, a) => sum + decimalToNumber(a.allocatedAmountUsd), 0);
      dataToUpdate.paymentStatus = deriveShipmentPaymentStatus(nextInvoiceVal, totalPaid);

      await tx.shipment.update({ where: { id }, data: dataToUpdate });

      // Optional nested incentives updates
      const syncIncentive = async (
        type: 'DRAWBACK' | 'RODTEP' | 'ROSCTL',
        claimedVal?: number,
        receivedVal?: number,
        receivedDate?: string
      ) => {
        if (claimedVal === undefined && receivedVal === undefined && receivedDate === undefined) return;
        const existing = shipment.incentives.find((i) => i.type === type);
        const claimed = claimedVal !== undefined ? Number(claimedVal) : existing ? decimalToNumber(existing.claimedAmount) : 0;
        const received = receivedVal !== undefined ? Number(receivedVal) : existing ? decimalToNumber(existing.receivedAmount) : 0;
        const status = deriveIncentiveStatus(claimed, received);
        if (existing) {
          await tx.incentiveRecord.update({
            where: { id: existing.id },
            data: {
              claimedAmount: claimed,
              receivedAmount: received,
              status,
              ...(receivedDate !== undefined ? { receivedDate: receivedDate ? new Date(receivedDate) : null } : {}),
            },
          });
        } else {
          await tx.incentiveRecord.create({
            data: {
              shipmentId: id,
              type,
              claimedAmount: claimed,
              receivedAmount: received,
              status,
              receivedDate: receivedDate ? new Date(receivedDate) : null,
            },
          });
        }
      };

      await syncIncentive('DRAWBACK', updates.dbkClaimed, updates.dbkReceived, updates.dbkReceivedDate);
      await syncIncentive('RODTEP', updates.rodtepClaimed, updates.rodtepReceived);
      await syncIncentive('ROSCTL', updates.rosctlClaimed, updates.rosctlReceived);

      if (updates.brcNumber !== undefined || updates.brcDate !== undefined) {
        const existingBrc = shipment.brcRecord;
        const nextBrcNum = updates.brcNumber !== undefined ? updates.brcNumber || null : existingBrc?.brcNumber || null;
        const nextRealDate =
          updates.brcDate !== undefined ? (updates.brcDate ? new Date(updates.brcDate) : null) : existingBrc?.realisationDate || null;
        if (existingBrc) {
          await tx.brcRecord.update({
            where: { id: existingBrc.id },
            data: {
              brcNumber: nextBrcNum,
              realisationDate: nextRealDate,
              status: nextBrcNum ? 'REALISED' : existingBrc.status,
            },
          });
        } else {
          await tx.brcRecord.create({
            data: {
              shipmentId: id,
              uploadMode: 'SINGLE',
              brcNumber: nextBrcNum,
              realisationDate: nextRealDate,
              status: nextBrcNum ? 'REALISED' : 'PENDING',
            },
          });
        }
      }
    });

    const updated = await this.findById(id);
    if (!updated) throw new NotFoundError('Shipment not found.');
    return updated;
  }

  async archive(id: string, reason: string | undefined, actorUserId: string): Promise<Shipment> {
    const existing = await this.prisma.shipment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Shipment not found.');

    await this.prisma.shipment.update({
      where: { id },
      data: {
        isArchived: true,
        archivedAt: new Date(),
        archivedBy: actorUserId,
        archivedReason: reason?.trim() || 'Archived by administrator',
      },
    });
    const full = await this.findById(id);
    if (!full) throw new NotFoundError('Shipment not found.');
    return full;
  }

  async restore(id: string): Promise<Shipment> {
    const existing = await this.prisma.shipment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Shipment not found.');

    await this.prisma.shipment.update({
      where: { id },
      data: {
        isArchived: false,
        archivedAt: null,
        archivedBy: null,
        archivedReason: null,
      },
    });
    const full = await this.findById(id);
    if (!full) throw new NotFoundError('Shipment not found.');
    return full;
  }

  async delete(id: string): Promise<{ success: boolean }> {
    await this.prisma.$transaction(async (tx) => {
      const shipment = await tx.shipment.findUnique({
        where: { id },
        include: { allocations: true, incentives: true, brcRecord: true },
      });
      if (!shipment) throw new NotFoundError('Shipment not found.');

      if (shipment.allocations.length > 0) {
        const totalPaid = shipment.allocations.reduce(
          (sum, a) => sum + decimalToNumber(a.allocatedAmountUsd),
          0
        );
        throw new ConflictError(
          `Cannot delete shipment "${shipment.invoiceNumber}": It has active FIRC payment allocations totaling $${totalPaid.toFixed(2)} USD across ${shipment.allocations.length} payment(s). Please reverse all payment allocations first, or archive this shipment.`
        );
      }

      const receivedIncentives = shipment.incentives.filter((i) => decimalToNumber(i.receivedAmount) > 0);
      if (receivedIncentives.length > 0) {
        throw new ConflictError(
          `Cannot delete shipment "${shipment.invoiceNumber}": Incentive funds have already been credited for this shipment. Deletion is blocked to preserve statutory customs history. Please archive this shipment instead.`
        );
      }

      if (shipment.brcRecord && (shipment.brcRecord.status === 'REALISED' || Boolean(shipment.brcRecord.brcNumber))) {
        throw new ConflictError(
          `Cannot delete shipment "${shipment.invoiceNumber}": Bank Realisation Certificate (${shipment.brcRecord.brcNumber || 'eBRC'}) is marked REALISED. Deletion of realised export records is prohibited under DGFT regulations. Please archive this shipment instead.`
        );
      }

      await tx.shipment.delete({ where: { id } });
    });

    return { success: true };
  }
}

export class JsonShipmentsRepository implements IShipmentsRepository {
  private hydrate(shipment: Shipment): Shipment {
    const state = jsonStore.getState();
    const allocations = state.allocations
      .filter((a) => a.shipmentId === shipment.id)
      .map((a) => {
        const payment = state.payments.find((p) => p.id === a.paymentId);
        return { ...a, paymentIrm: payment?.irmNumber, exchangeRate: payment?.exchangeRate ?? null };
      });
    const documents = state.documents.filter((d) => d.shipmentId === shipment.id && d.isCurrent);
    const incentives = state.incentives.filter((i) => i.shipmentId === shipment.id);
    const brcRecord = state.brcRecords.find((b) => b.shipmentId === shipment.id);
    const consignee = state.consignees.find((c) => c.id === shipment.consigneeId);
    const fy = state.financialYears.find((f) => f.id === shipment.financialYearId);

    return hydrateShipmentDto({
      shipment,
      consigneeName: consignee?.name,
      financialYearLabel: fy?.label,
      allocations,
      documents,
      incentives,
      brcRecord,
    });
  }

  async findAll(filters?: ShipmentFilter): Promise<Shipment[]> {
    const state = jsonStore.getState();
    let list = state.shipments;

    if (!filters?.includeArchived) {
      list = list.filter((s) => !s.isArchived);
    }
    if (filters?.financialYearId && filters.financialYearId !== 'ALL') {
      list = list.filter((s) => s.financialYearId === filters.financialYearId);
    }
    if (filters?.consigneeId) {
      list = list.filter((s) => s.consigneeId === filters.consigneeId);
    }
    if (filters?.paymentStatus) {
      list = list.filter((s) => s.paymentStatus === filters.paymentStatus);
    }
    if (filters?.reviewStatus) {
      list = list.filter((s) => s.reviewStatus === filters.reviewStatus);
    }
    if (filters?.search?.trim()) {
      const q = filters.search.toLowerCase().trim();
      list = list.filter((s) => {
        const consignee = state.consignees.find((c) => c.id === s.consigneeId);
        return (
          s.invoiceNumber.toLowerCase().includes(q) ||
          s.normalizedInvoiceKey.toLowerCase().includes(q) ||
          s.shippingBillNumber.includes(q) ||
          (s.blNumber && s.blNumber.toLowerCase().includes(q)) ||
          (s.portCode && s.portCode.toLowerCase().includes(q)) ||
          (consignee && consignee.name.toLowerCase().includes(q)) ||
          (s.remarks && s.remarks.toLowerCase().includes(q))
        );
      });
    }

    return list.map((s) => this.hydrate(s));
  }

  async findById(id: string): Promise<Shipment | null> {
    const shipment = jsonStore.getState().shipments.find((s) => s.id === id);
    return shipment ? this.hydrate(shipment) : null;
  }

  async findByNormalizedKey(normalizedKey: string, financialYearId: string): Promise<Shipment | null> {
    const shipment = jsonStore
      .getState()
      .shipments.find((s) => s.normalizedInvoiceKey === normalizedKey && s.financialYearId === financialYearId);
    return shipment ? this.hydrate(shipment) : null;
  }

  async lookup(query: string, financialYearId?: string): Promise<Shipment[]> {
    const q = query.trim();
    if (!q) return [];
    const normalized = normalizeInvoiceKey(q);
    const all = await this.findAll(financialYearId ? { financialYearId } : undefined);
    return all.filter(
      (s) =>
        s.normalizedInvoiceKey === normalized ||
        s.invoiceNumber.toLowerCase().includes(q.toLowerCase()) ||
        s.shippingBillNumber.includes(q) ||
        (s.blNumber && s.blNumber.toLowerCase().includes(q.toLowerCase()))
    );
  }

  async create(input: CreateShipmentRepoInput): Promise<Shipment> {
    return jsonStore.runInTransaction(() => {
      const state = jsonStore.getState();
      const normalizedKey = normalizeInvoiceKey(input.invoiceNumber);

      const duplicate = state.shipments.find(
        (s) => s.financialYearId === input.financialYearId && s.normalizedInvoiceKey === normalizedKey
      );
      if (duplicate) {
        throw new ConflictError(
          `Duplicate Invoice Identity: An invoice with key '${normalizedKey}' already exists in Financial Year '${input.financialYearId}'. (Existing: ${duplicate.invoiceNumber})`
        );
      }

      const now = new Date().toISOString();
      const shipmentId = crypto.randomUUID();
      const fob = input.fobValueInr || calculateFobValueInr(input.invoiceValueUsd, input.sbExchangeRate);

      const newShipment: Shipment = {
        id: shipmentId,
        financialYearId: input.financialYearId,
        invoiceNumber: input.invoiceNumber.trim(),
        normalizedInvoiceKey: normalizedKey,
        invoiceDate: input.invoiceDate || now.split('T')[0],
        consigneeId: input.consigneeId || state.consignees[0]?.id || '',
        portCode: (input.portCode || 'INNSA1').trim().toUpperCase(),
        packageCount: input.packageCount || 0,
        invoiceValueUsd: Number(input.invoiceValueUsd || 0),
        shippingBillNumber: (input.shippingBillNumber || 'PENDING').trim(),
        shippingBillDate: input.shippingBillDate || now.split('T')[0],
        sbExchangeRate: Number(input.sbExchangeRate || 84.5),
        fobValueInr: fob,
        blNumber: input.blNumber?.trim(),
        blDate: input.blDate,
        vesselName: input.vesselName?.trim(),
        remarks: input.remarks?.trim(),
        paymentStatus: 'UNPAID',
        reviewStatus: input.reviewStatus || 'CONFIRMED',
        createdAt: now,
        updatedAt: now,
      };
      state.shipments.push(newShipment);

      if (input.incentives) {
        const defs: Array<{ type: IncentiveRecord['type']; val?: number }> = [
          { type: 'DRAWBACK', val: input.incentives.dbkClaimed },
          { type: 'RODTEP', val: input.incentives.rodtepClaimed },
          { type: 'ROSCTL', val: input.incentives.rosctlClaimed },
        ];
        for (const def of defs) {
          if (def.val !== undefined && def.val >= 0) {
            state.incentives.push({
              id: crypto.randomUUID(),
              shipmentId,
              type: def.type,
              claimedAmount: Number(def.val),
              status: 'PENDING',
              receivedAmount: 0,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }

      const statutoryDays = state.settings.statutoryBrcDays || 270;
      const defaultDeadline = computeStatutoryBrcDeadline(newShipment.shippingBillDate, statutoryDays);
      state.brcRecords.push({
        id: crypto.randomUUID(),
        shipmentId,
        uploadMode: input.brc?.uploadMode || 'SINGLE',
        statutoryDeadline: input.brc?.statutoryDeadline || defaultDeadline,
        status: 'PENDING',
        remarks: input.brc?.remarks,
        createdAt: now,
        updatedAt: now,
      });

      if (input.initialFircPaymentId) {
        const payment = state.payments.find((p) => p.id === input.initialFircPaymentId);
        if (!payment) throw new NotFoundError('Payment record not found.');
        const allocAmount = Number(input.initialFircAllocationAmount || input.invoiceValueUsd);
        if (allocAmount <= 0) throw new ValidationError('Allocation amount must be strictly greater than 0.');

        const existingAllocs = state.allocations.filter((a) => a.paymentId === payment.id);
        const { availableBalanceUsd } = computePaymentAllocationBalances(
          Number(payment.verifiedAmount),
          existingAllocs
        );
        if (allocAmount > availableBalanceUsd + 0.001) {
          throw new ValidationError(
            `Over-allocation rejected: Requested $${allocAmount.toFixed(2)} exceeds available payment balance of $${availableBalanceUsd.toFixed(2)} on FIRC ${payment.irmNumber}.`
          );
        }

        const actor = state.users.find((u) => u.id === input.actorUserId);
        state.allocations.push({
          id: crypto.randomUUID(),
          paymentId: payment.id,
          shipmentId,
          allocatedAmountUsd: allocAmount,
          notes: 'Initial allocation on shipment creation',
          allocatedAt: now,
          allocatedByUserId: input.actorUserId,
          allocatedByName: actor?.name || 'Admin',
        });

        newShipment.paymentStatus = deriveShipmentPaymentStatus(newShipment.invoiceValueUsd, allocAmount);
      }

      return this.hydrate(newShipment);
    });
  }

  async createWithDocumentsTransaction(input: CreateShipmentWithDocsInput): Promise<Shipment> {
    return jsonStore.runInTransaction(async () => {
      const state = jsonStore.getState();
      const now = new Date().toISOString();

      let resolvedConsigneeId = input.consigneeId;
      if (!resolvedConsigneeId && input.consigneeName) {
        const found = state.consignees.find((c) => c.name.toLowerCase() === input.consigneeName!.trim().toLowerCase());
        if (found) {
          resolvedConsigneeId = found.id;
        } else {
          const created = {
            id: crypto.randomUUID(),
            name: input.consigneeName.trim(),
            country: input.consigneeName.toLowerCase().includes('lanka') ? 'Sri Lanka' : 'International',
            portOfDischarge: 'LKCMB - Colombo',
            paymentTerms: 'FOB COLOMBO | DA 90 DAYS',
            currency: 'USD',
            isActive: true,
            createdAt: now,
            updatedAt: now,
          };
          state.consignees.push(created);
          resolvedConsigneeId = created.id;
        }
      }
      if (!resolvedConsigneeId) {
        resolvedConsigneeId = state.consignees[0]?.id;
      }

      let resolvedBankId = state.banks[0]?.id;
      if (input.fircBankName) {
        const bankMatch = state.banks.find((b) => b.name.toLowerCase().includes(input.fircBankName!.toLowerCase()));
        if (bankMatch) resolvedBankId = bankMatch.id;
      }

      const normalizedKey = normalizeInvoiceKey(input.invoiceNumber);
      const duplicate = state.shipments.find(
        (s) => s.financialYearId === input.financialYearId && s.normalizedInvoiceKey === normalizedKey
      );
      if (duplicate) {
        throw new ConflictError(
          `Duplicate Invoice Identity: An invoice with key '${normalizedKey}' already exists in Financial Year '${input.financialYearId}'.`
        );
      }

      const shipmentId = crypto.randomUUID();
      const shipment: Shipment = {
        id: shipmentId,
        financialYearId: input.financialYearId,
        invoiceNumber: input.invoiceNumber.trim(),
        normalizedInvoiceKey: normalizedKey,
        invoiceDate: input.invoiceDate,
        consigneeId: resolvedConsigneeId || '',
        portCode: input.portCode.trim().toUpperCase(),
        packageCount: input.packageCount,
        invoiceValueUsd: input.invoiceValueUsd,
        shippingBillNumber: input.shippingBillNumber.trim(),
        shippingBillDate: input.shippingBillDate,
        sbExchangeRate: input.sbExchangeRate,
        fobValueInr: input.fobValueInr,
        blNumber: input.blNumber?.trim(),
        blDate: input.blDate,
        vesselName: input.vesselName?.trim(),
        remarks: input.remarks?.trim(),
        paymentStatus: 'UNPAID',
        reviewStatus: 'CONFIRMED',
        createdAt: now,
        updatedAt: now,
      };
      state.shipments.push(shipment);

      const incentivePairs: Array<{ type: IncentiveRecord['type']; val: number }> = [
        { type: 'DRAWBACK', val: input.dbkClaimed },
        { type: 'RODTEP', val: input.rodtepClaimed },
        { type: 'ROSCTL', val: input.rosctlClaimed },
      ];
      for (const pair of incentivePairs) {
        state.incentives.push({
          id: crypto.randomUUID(),
          shipmentId,
          type: pair.type,
          claimedAmount: pair.val,
          status: 'PENDING',
          receivedAmount: 0,
          createdAt: now,
          updatedAt: now,
        });
      }

      const statutoryDays = state.settings.statutoryBrcDays || 270;
      const defaultDeadline = computeStatutoryBrcDeadline(input.shippingBillDate, statutoryDays);
      state.brcRecords.push({
        id: crypto.randomUUID(),
        shipmentId,
        brcNumber: input.brcNumber?.trim(),
        issueDate: input.brcIssueDate,
        realisationDate: input.brcRealisationDate,
        realisedAmount: input.brcNumber ? input.brcRealisedAmount ?? input.invoiceValueUsd : undefined,
        realisedCurrency: 'USD',
        uploadMode: input.brcUploadMode,
        statutoryDeadline: input.statutoryDeadline || defaultDeadline,
        status: input.brcNumber ? 'REALISED' : 'PENDING',
        remarks: input.remarks?.trim(),
        createdAt: now,
        updatedAt: now,
      });

      if (input.fircIrmNumber && resolvedBankId) {
        const cleanIrm = input.fircIrmNumber.trim().toUpperCase();
        let payment: Payment | undefined = state.payments.find((p) => p.irmNumber.toUpperCase() === cleanIrm);
        const fircAmt = Number(input.fircAmountUsd || input.invoiceValueUsd);

        if (!payment) {
          payment = {
            id: crypto.randomUUID(),
            irmNumber: cleanIrm,
            senderReference: input.fircSenderRef,
            currency: 'USD',
            verifiedAmount: fircAmt,
            inrAmount: input.fircInrAmount ?? round2(fircAmt * (input.fircExchangeRate || 93.28)),
            exchangeRate: input.fircExchangeRate || 93.28,
            valueDate: input.fircValueDate || input.invoiceDate,
            creditDate: input.fircCreditDate || input.invoiceDate,
            fircIssueDate: input.fircCreditDate || input.invoiceDate,
            bankId: resolvedBankId,
            purposeCode: 'P0103',
            remarks: `Payment for invoice ${input.invoiceNumber.trim()}`,
            createdAt: now,
            updatedAt: now,
          };
          state.payments.push(payment);
        }

        const allocAmount = Math.min(fircAmt, input.invoiceValueUsd);
        if (allocAmount > 0) {
          const actor = state.users.find((u) => u.id === input.actorUserId);
          state.allocations.push({
            id: crypto.randomUUID(),
            paymentId: payment.id,
            shipmentId,
            allocatedAmountUsd: allocAmount,
            notes: `Auto-allocated on shipment creation (${input.invoiceNumber.trim()})`,
            allocatedAt: now,
            allocatedByUserId: input.actorUserId,
            allocatedByName: actor?.name || 'Admin',
          });
          shipment.paymentStatus = deriveShipmentPaymentStatus(input.invoiceValueUsd, allocAmount);
        }
      }

      const actor = state.users.find((u) => u.id === input.actorUserId);
      for (const docSpec of input.documentsToRegister) {
        state.documents.push({
          id: crypto.randomUUID(),
          shipmentId,
          category: docSpec.category,
          originalFilename: docSpec.originalFilename,
          storedPath: docSpec.storedPath,
          mimeType: docSpec.mimeType,
          fileSizeBytes: docSpec.fileSizeBytes,
          version: 1,
          isCurrent: true,
          reviewStatus: docSpec.reviewStatus || 'CONFIRMED',
          ocrApplied: docSpec.ocrApplied,
          ocrConfidence: docSpec.ocrConfidence,
          ocrTextPreview: docSpec.ocrTextPreview,
          extractionMethod: docSpec.extractionMethod || 'PDF_TEXT',
          extractedData: docSpec.extractedData,
          uploadedByUserId: input.actorUserId,
          uploadedByName: actor?.name || 'Admin',
          createdAt: now,
          updatedAt: now,
        });
      }

      return this.hydrate(shipment);
    });
  }

  async update(id: string, updates: Record<string, any>): Promise<Shipment> {
    const state = jsonStore.getState();
    const shipment = state.shipments.find((s) => s.id === id);
    if (!shipment) throw new NotFoundError('Shipment not found.');

    if (updates.invoiceNumber && updates.invoiceNumber !== shipment.invoiceNumber) {
      const newKey = normalizeInvoiceKey(updates.invoiceNumber);
      const fyId = updates.financialYearId || shipment.financialYearId;
      const dup = state.shipments.find(
        (s) => s.id !== id && s.financialYearId === fyId && s.normalizedInvoiceKey === newKey
      );
      if (dup) throw new ConflictError(`Another shipment with key '${newKey}' exists in this Financial Year.`);
      shipment.invoiceNumber = String(updates.invoiceNumber).trim();
      shipment.normalizedInvoiceKey = newKey;
    }

    if (updates.consigneeId) shipment.consigneeId = updates.consigneeId;
    if (updates.consigneeName) {
      const match = state.consignees.find(
        (c) => c.name.toLowerCase() === String(updates.consigneeName).trim().toLowerCase()
      );
      if (match) shipment.consigneeId = match.id;
    }
    if (updates.financialYearId) shipment.financialYearId = updates.financialYearId;
    if (updates.invoiceDate) shipment.invoiceDate = updates.invoiceDate;
    if (updates.portCode) shipment.portCode = String(updates.portCode).trim().toUpperCase();
    if (updates.packageCount !== undefined) shipment.packageCount = Number(updates.packageCount);
    if (updates.invoiceValueUsd !== undefined) {
      const newInvVal = Number(updates.invoiceValueUsd);
      if (newInvVal < 0) throw new ValidationError('Invoice Value cannot be negative.');
      const currentAllocs = state.allocations.filter((a) => a.shipmentId === id);
      const totalAllocated = currentAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      if (newInvVal < totalAllocated - 0.001) {
        throw new ValidationError(
          `Cannot reduce Invoice Value ($${newInvVal.toFixed(2)}) below already allocated payment amount ($${totalAllocated.toFixed(2)}) on Invoice ${shipment.invoiceNumber}. Please reverse excess payment allocations first.`
        );
      }
      shipment.invoiceValueUsd = newInvVal;
    }

    if (updates.shippingBillNumber) shipment.shippingBillNumber = String(updates.shippingBillNumber).trim();
    if (updates.shippingBillDate) shipment.shippingBillDate = updates.shippingBillDate;
    if (updates.sbExchangeRate !== undefined) shipment.sbExchangeRate = Number(updates.sbExchangeRate);
    if (updates.fobValueInr !== undefined) {
      shipment.fobValueInr = Number(updates.fobValueInr);
    } else if (updates.invoiceValueUsd !== undefined || updates.sbExchangeRate !== undefined) {
      shipment.fobValueInr = calculateFobValueInr(shipment.invoiceValueUsd, shipment.sbExchangeRate);
    }
    if (updates.blNumber !== undefined) shipment.blNumber = updates.blNumber ? String(updates.blNumber).trim() : undefined;
    if (updates.blDate !== undefined) shipment.blDate = updates.blDate || undefined;
    if (updates.vesselName !== undefined) {
      shipment.vesselName = updates.vesselName ? String(updates.vesselName).trim() : undefined;
    }
    if (updates.remarks !== undefined) shipment.remarks = updates.remarks ? String(updates.remarks).trim() : undefined;
    if (updates.reviewStatus) shipment.reviewStatus = updates.reviewStatus;

    const now = new Date().toISOString();
    const syncIncentive = (
      type: IncentiveRecord['type'],
      claimedVal?: number,
      receivedVal?: number,
      receivedDate?: string
    ) => {
      if (claimedVal === undefined && receivedVal === undefined && receivedDate === undefined) return;
      let inc = state.incentives.find((i) => i.shipmentId === id && i.type === type);
      if (!inc) {
        inc = {
          id: crypto.randomUUID(),
          shipmentId: id,
          type,
          claimedAmount: 0,
          receivedAmount: 0,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        };
        state.incentives.push(inc);
      }
      if (claimedVal !== undefined) inc.claimedAmount = Number(claimedVal);
      if (receivedVal !== undefined) inc.receivedAmount = Number(receivedVal);
      if (receivedDate !== undefined) inc.receivedDate = receivedDate || undefined;
      inc.status = deriveIncentiveStatus(inc.claimedAmount, inc.receivedAmount);
      inc.updatedAt = now;
    };

    syncIncentive('DRAWBACK', updates.dbkClaimed, updates.dbkReceived, updates.dbkReceivedDate);
    syncIncentive('RODTEP', updates.rodtepClaimed, updates.rodtepReceived);
    syncIncentive('ROSCTL', updates.rosctlClaimed, updates.rosctlReceived);

    if (updates.brcNumber !== undefined || updates.brcDate !== undefined) {
      let brc = state.brcRecords.find((b) => b.shipmentId === id);
      if (!brc) {
        brc = {
          id: crypto.randomUUID(),
          shipmentId: id,
          uploadMode: 'SINGLE',
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        };
        state.brcRecords.push(brc);
      }
      if (updates.brcNumber !== undefined) brc.brcNumber = updates.brcNumber || undefined;
      if (updates.brcDate !== undefined) brc.realisationDate = updates.brcDate || undefined;
      if (brc.brcNumber) brc.status = 'REALISED';
      brc.updatedAt = now;
    }

    const totalPaid = state.allocations
      .filter((a) => a.shipmentId === id)
      .reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
    shipment.paymentStatus = deriveShipmentPaymentStatus(shipment.invoiceValueUsd, totalPaid);
    shipment.updatedAt = now;

    jsonStore.save();
    return this.hydrate(shipment);
  }

  async archive(id: string, reason: string | undefined, actorUserId: string): Promise<Shipment> {
    const state = jsonStore.getState();
    const shipment = state.shipments.find((s) => s.id === id);
    if (!shipment) throw new NotFoundError('Shipment not found.');

    const now = new Date().toISOString();
    shipment.isArchived = true;
    shipment.archivedAt = now;
    shipment.archivedBy = actorUserId;
    shipment.archivedReason = reason?.trim() || 'Archived by administrator';
    shipment.updatedAt = now;

    jsonStore.save();
    return this.hydrate(shipment);
  }

  async restore(id: string): Promise<Shipment> {
    const state = jsonStore.getState();
    const shipment = state.shipments.find((s) => s.id === id);
    if (!shipment) throw new NotFoundError('Shipment not found.');

    shipment.isArchived = false;
    shipment.archivedAt = undefined;
    shipment.archivedBy = undefined;
    shipment.archivedReason = undefined;
    shipment.updatedAt = new Date().toISOString();

    jsonStore.save();
    return this.hydrate(shipment);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    const state = jsonStore.getState();
    const idx = state.shipments.findIndex((s) => s.id === id);
    if (idx === -1) throw new NotFoundError('Shipment not found.');

    const shipment = state.shipments[idx];
    const allocs = state.allocations.filter((a) => a.shipmentId === id);
    if (allocs.length > 0) {
      const totalPaid = allocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      throw new ConflictError(
        `Cannot delete shipment "${shipment.invoiceNumber}": It has active FIRC payment allocations totaling $${totalPaid.toFixed(2)} USD across ${allocs.length} payment(s). Please reverse all payment allocations first, or archive this shipment.`
      );
    }

    const receivedIncentives = state.incentives.filter((i) => i.shipmentId === id && Number(i.receivedAmount) > 0);
    if (receivedIncentives.length > 0) {
      throw new ConflictError(
        `Cannot delete shipment "${shipment.invoiceNumber}": Incentive funds have already been credited for this shipment. Deletion is blocked to preserve statutory customs history. Please archive this shipment instead.`
      );
    }

    const brc = state.brcRecords.find((b) => b.shipmentId === id);
    if (brc && (brc.status === 'REALISED' || Boolean(brc.brcNumber))) {
      throw new ConflictError(
        `Cannot delete shipment "${shipment.invoiceNumber}": Bank Realisation Certificate (${brc.brcNumber || 'eBRC'}) is marked REALISED. Deletion of realised export records is prohibited under DGFT regulations. Please archive this shipment instead.`
      );
    }

    state.shipments.splice(idx, 1);
    state.invoiceItems = state.invoiceItems.filter((i) => i.shipmentId !== id);
    state.incentives = state.incentives.filter((i) => i.shipmentId !== id);
    state.brcRecords = state.brcRecords.filter((b) => b.shipmentId !== id);
    state.documents = state.documents.filter((d) => d.shipmentId !== id);

    jsonStore.save();
    return { success: true };
  }
}
