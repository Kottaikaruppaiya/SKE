/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type {
  DocumentCategory,
  DocumentRecord,
  ExtractionMethod,
  ReviewStatus,
} from '../../../shared/contracts/index.ts';
import { NotFoundError } from '../../domain/errors/AppError.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';
import { bigIntToNumber, toIsoTimestamp } from '../../infrastructure/prismaMappers.ts';

export interface RegisterDocumentInput {
  shipmentId?: string;
  paymentId?: string;
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
  extractionMethod?: ExtractionMethod | string;
  extractedFieldsJson?: string;
}

export interface DocumentFilter {
  shipmentId?: string;
  paymentId?: string;
}

export type DocumentExtractionUpdate = Partial<
  Pick<
    DocumentRecord,
    'extractedData' | 'ocrApplied' | 'ocrConfidence' | 'ocrTextPreview' | 'extractionMethod' | 'reviewStatus'
  >
>;

export interface IDocumentsRepository {
  findAll(filter?: DocumentFilter): Promise<DocumentRecord[]>;
  findById(id: string): Promise<DocumentRecord | null>;
  register(input: RegisterDocumentInput, actorUserId: string): Promise<DocumentRecord>;
  updateReviewStatus(id: string, status: ReviewStatus): Promise<DocumentRecord>;
  updateExtraction(id: string, updates: DocumentExtractionUpdate): Promise<DocumentRecord | null>;
  delete(id: string): Promise<{ success: boolean; deletedDocument: DocumentRecord }>;
}

function mapPrismaDocument(row: any): DocumentRecord {
  return {
    id: row.id,
    shipmentId: row.shipmentId || undefined,
    paymentId: row.paymentId || undefined,
    category: row.category,
    originalFilename: row.originalFilename,
    storedPath: row.storedPath,
    mimeType: row.mimeType,
    fileSizeBytes: bigIntToNumber(row.fileSizeBytes),
    version: row.version,
    isCurrent: row.isCurrent,
    reviewStatus: row.reviewStatus,
    ocrApplied: row.ocrApplied,
    ocrConfidence: row.ocrConfidence ?? undefined,
    ocrTextPreview: row.ocrTextPreview || undefined,
    extractionMethod: row.extractionMethod || undefined,
    extractedFieldsJson: row.extractedFieldsJson || undefined,
    extractedData: row.extractedData || undefined,
    uploadedByUserId: row.uploadedByUserId,
    uploadedByName: row.uploadedByUser?.name,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

export class PrismaDocumentsRepository implements IDocumentsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll(filter?: DocumentFilter): Promise<DocumentRecord[]> {
    const where: Record<string, any> = {};
    if (filter?.shipmentId) where.shipmentId = filter.shipmentId;
    if (filter?.paymentId) where.paymentId = filter.paymentId;

    const rows = await this.prisma.document.findMany({
      where,
      include: { uploadedByUser: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(mapPrismaDocument);
  }

  async findById(id: string): Promise<DocumentRecord | null> {
    const row = await this.prisma.document.findUnique({
      where: { id },
      include: { uploadedByUser: { select: { name: true } } },
    });
    return row ? mapPrismaDocument(row) : null;
  }

  async register(input: RegisterDocumentInput, actorUserId: string): Promise<DocumentRecord> {
    const created = await this.prisma.$transaction(async (tx) => {
      const matchConditions: Array<Record<string, any>> = [];
      if (input.shipmentId) matchConditions.push({ shipmentId: input.shipmentId });
      if (input.paymentId) matchConditions.push({ paymentId: input.paymentId });

      let nextVersion = 1;
      if (matchConditions.length > 0) {
        const existing = await tx.document.findMany({
          where: {
            isCurrent: true,
            category: input.category,
            OR: matchConditions,
          },
          select: { id: true, version: true },
        });
        if (existing.length > 0) {
          nextVersion = Math.max(...existing.map((e) => e.version)) + 1;
          await tx.document.updateMany({
            where: { id: { in: existing.map((e) => e.id) } },
            data: { isCurrent: false },
          });
        }
      }

      return tx.document.create({
        data: {
          shipmentId: input.shipmentId || null,
          paymentId: input.paymentId || null,
          category: input.category,
          originalFilename: input.originalFilename,
          storedPath: input.storedPath,
          mimeType: input.mimeType,
          fileSizeBytes: BigInt(input.fileSizeBytes),
          version: nextVersion,
          isCurrent: true,
          reviewStatus: input.reviewStatus || 'EXTRACTED',
          ocrApplied: Boolean(input.ocrApplied),
          ocrConfidence: input.ocrConfidence ?? null,
          ocrTextPreview: input.ocrTextPreview || null,
          extractionMethod: input.extractionMethod || 'PDF_TEXT',
          extractedFieldsJson: input.extractedFieldsJson || null,
          extractedData: input.extractedData || undefined,
          uploadedByUserId: actorUserId,
        },
        include: { uploadedByUser: { select: { name: true } } },
      });
    });

    return mapPrismaDocument(created);
  }

  async updateReviewStatus(id: string, status: ReviewStatus): Promise<DocumentRecord> {
    const existing = await this.prisma.document.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Document not found.');

    const updated = await this.prisma.document.update({
      where: { id },
      data: { reviewStatus: status },
      include: { uploadedByUser: { select: { name: true } } },
    });
    return mapPrismaDocument(updated);
  }

  async updateExtraction(id: string, updates: DocumentExtractionUpdate): Promise<DocumentRecord | null> {
    const existing = await this.prisma.document.findUnique({ where: { id } });
    if (!existing) return null;

    const updated = await this.prisma.document.update({
      where: { id },
      data: {
        ...(updates.extractedData !== undefined ? { extractedData: updates.extractedData } : {}),
        ...(updates.ocrApplied !== undefined ? { ocrApplied: updates.ocrApplied } : {}),
        ...(updates.ocrConfidence !== undefined ? { ocrConfidence: updates.ocrConfidence } : {}),
        ...(updates.ocrTextPreview !== undefined ? { ocrTextPreview: updates.ocrTextPreview } : {}),
        ...(updates.extractionMethod !== undefined ? { extractionMethod: updates.extractionMethod } : {}),
        ...(updates.reviewStatus !== undefined ? { reviewStatus: updates.reviewStatus } : {}),
      },
      include: { uploadedByUser: { select: { name: true } } },
    });
    return mapPrismaDocument(updated);
  }

  async delete(id: string): Promise<{ success: boolean; deletedDocument: DocumentRecord }> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundError('Document not found.');

    await this.prisma.document.delete({ where: { id } });
    return { success: true, deletedDocument: existing };
  }
}

export class JsonDocumentsRepository implements IDocumentsRepository {
  async findAll(filter?: DocumentFilter): Promise<DocumentRecord[]> {
    let docs = jsonStore.getState().documents;
    if (filter?.shipmentId) docs = docs.filter((d) => d.shipmentId === filter.shipmentId);
    if (filter?.paymentId) docs = docs.filter((d) => d.paymentId === filter.paymentId);
    return docs;
  }

  async findById(id: string): Promise<DocumentRecord | null> {
    return jsonStore.getState().documents.find((d) => d.id === id) || null;
  }

  async register(input: RegisterDocumentInput, actorUserId: string): Promise<DocumentRecord> {
    const state = jsonStore.getState();
    const now = new Date().toISOString();

    const existing = state.documents.filter(
      (d) =>
        d.isCurrent &&
        d.category === input.category &&
        ((input.shipmentId && d.shipmentId === input.shipmentId) ||
          (input.paymentId && d.paymentId === input.paymentId))
    );

    let nextVersion = 1;
    for (const doc of existing) {
      doc.isCurrent = false;
      doc.updatedAt = now;
      if (doc.version >= nextVersion) nextVersion = doc.version + 1;
    }

    const user = state.users.find((u) => u.id === actorUserId);
    const newDoc: DocumentRecord = {
      id: crypto.randomUUID(),
      shipmentId: input.shipmentId,
      paymentId: input.paymentId,
      category: input.category,
      originalFilename: input.originalFilename,
      storedPath: input.storedPath,
      mimeType: input.mimeType,
      fileSizeBytes: input.fileSizeBytes,
      version: nextVersion,
      isCurrent: true,
      reviewStatus: input.reviewStatus || 'EXTRACTED',
      extractedData: input.extractedData,
      ocrApplied: input.ocrApplied,
      ocrConfidence: input.ocrConfidence,
      ocrTextPreview: input.ocrTextPreview,
      extractionMethod: input.extractionMethod as ExtractionMethod | undefined,
      extractedFieldsJson: input.extractedFieldsJson,
      uploadedByUserId: actorUserId,
      uploadedByName: user?.name || 'Admin',
      createdAt: now,
      updatedAt: now,
    };

    state.documents.push(newDoc);
    jsonStore.save();
    return newDoc;
  }

  async updateReviewStatus(id: string, status: ReviewStatus): Promise<DocumentRecord> {
    const state = jsonStore.getState();
    const doc = state.documents.find((d) => d.id === id);
    if (!doc) throw new NotFoundError('Document not found.');

    doc.reviewStatus = status;
    doc.updatedAt = new Date().toISOString();
    jsonStore.save();
    return doc;
  }

  async updateExtraction(id: string, updates: DocumentExtractionUpdate): Promise<DocumentRecord | null> {
    const state = jsonStore.getState();
    const doc = state.documents.find((d) => d.id === id);
    if (!doc) return null;

    Object.assign(doc, updates, { updatedAt: new Date().toISOString() });
    jsonStore.save();
    return doc;
  }

  async delete(id: string): Promise<{ success: boolean; deletedDocument: DocumentRecord }> {
    const state = jsonStore.getState();
    const idx = state.documents.findIndex((d) => d.id === id);
    if (idx === -1) throw new NotFoundError('Document not found.');

    const deletedDocument = state.documents[idx];
    state.documents.splice(idx, 1);
    jsonStore.save();
    return { success: true, deletedDocument };
  }
}
