/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import type { DocumentCategory, DocumentRecord, ReviewStatus } from '../../../shared/contracts/index.ts';
import { getStorageRoot } from '../../config/storage.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors/AppError.ts';
import { extractDocumentData, mergeExtractedDocuments } from '../../extractor.ts';
import { validateDocumentContent } from '../../middleware/upload.ts';
import type { IMastersRepository } from '../masters/masters.repository.ts';
import type { IShipmentsRepository } from '../shipments/shipments.repository.ts';
import type { DocumentFilter, IDocumentsRepository } from './documents.repository.ts';

export class DocumentsService {
  constructor(
    private readonly documentsRepo: IDocumentsRepository,
    private readonly shipmentsRepo: IShipmentsRepository,
    private readonly mastersRepo: IMastersRepository
  ) {}

  async list(filter?: DocumentFilter): Promise<DocumentRecord[]> {
    return this.documentsRepo.findAll(filter);
  }

  async getById(id: string): Promise<DocumentRecord | null> {
    return this.documentsRepo.findById(id);
  }

  async extractBatch(files: { [fieldname: string]: Express.Multer.File[] } | undefined) {
    if (!files || Object.keys(files).length === 0) {
      throw new ValidationError('No files provided for extraction.');
    }

    const fileSpecs: { file?: Express.Multer.File; category: DocumentCategory; key: string }[] = [
      { file: files?.invoiceDoc?.[0], category: 'COMMERCIAL_INVOICE', key: 'invoiceDoc' },
      { file: files?.shippingBillDoc?.[0], category: 'SHIPPING_BILL', key: 'shippingBillDoc' },
      { file: files?.blDoc?.[0], category: 'BILL_OF_LADING', key: 'blDoc' },
      { file: files?.brcDoc1?.[0], category: 'BRC_COPY_1', key: 'brcDoc1' },
      { file: files?.brcDoc2?.[0], category: 'BRC_COPY_2', key: 'brcDoc2' },
      { file: files?.fircDoc?.[0], category: 'FIRC_PAYMENT', key: 'fircDoc' },
      { file: files?.additionalDoc?.[0], category: 'ADDITIONAL_DOC', key: 'additionalDoc' },
    ];

    for (const spec of fileSpecs) {
      if (spec.file && !validateDocumentContent(spec.file.buffer, spec.file.originalname)) {
        throw new ValidationError(`Invalid or corrupted file signature for "${spec.file.originalname}".`);
      }
    }

    const extractionResults: any[] = [];
    const extractionsByKey: Record<string, any> = {};

    for (const spec of fileSpecs) {
      if (!spec.file) continue;
      try {
        const ext = await extractDocumentData(spec.file.buffer, spec.category, spec.file.originalname);
        extractionResults.push(ext);
        extractionsByKey[spec.key] = ext;
      } catch (err: any) {
        console.warn(`Extraction error for ${spec.category}:`, err?.message || err);
      }
    }

    const mergedDraft = mergeExtractedDocuments(extractionResults);
    return {
      success: true,
      totalFilesParsed: extractionResults.length,
      mergedDraft,
      extractions: extractionsByKey,
      conflicts: mergedDraft.conflicts || [],
    };
  }

  async upload(
    file: Express.Multer.File | undefined,
    body: {
      category?: string;
      shipmentId?: string;
      paymentId?: string;
      financialYear?: string;
      invoiceKey?: string;
    },
    actorUserId: string
  ) {
    if (!file) {
      throw new ValidationError('No document file uploaded.');
    }
    if (!validateDocumentContent(file.buffer, file.originalname)) {
      throw new ValidationError(`Invalid or corrupted file signature for "${file.originalname}".`);
    }

    const category = (body.category || 'COMMERCIAL_INVOICE') as DocumentCategory;
    const shipmentId = body.shipmentId || undefined;
    const paymentId = body.paymentId || undefined;
    const currentFy = await this.mastersRepo.findCurrentFinancialYear();
    const financialYear = body.financialYear || currentFy.label;

    let invoiceKey = body.invoiceKey;
    if (shipmentId) {
      const shipment = await this.shipmentsRepo.findById(shipmentId);
      if (!invoiceKey) {
        invoiceKey = shipment?.normalizedInvoiceKey;
      }
      if ((category === 'BRC_COPY_1' || category === 'BRC_COPY_2') && shipment?.brcRecord) {
        if (shipment.brcRecord.uploadMode === 'SINGLE' && category === 'BRC_COPY_2') {
          throw new ValidationError(
            'Single BRC Mode is active for this shipment. Exactly one BRC copy is permitted. Switch to Multiple mode to attach Copy 2.'
          );
        }
      }
    }

    const safeYearDir = path.resolve(getStorageRoot(), `FY${financialYear}`);
    const safeInvoiceDir = path.resolve(
      safeYearDir,
      (invoiceKey || 'GENERAL').replace(/[^A-Z0-9\-_]/gi, '_')
    );
    await fsp.mkdir(safeInvoiceDir, { recursive: true });

    const safeFilename = `${category.toLowerCase()}_${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const storedPath = path.resolve(safeInvoiceDir, safeFilename);
    await fsp.writeFile(storedPath, file.buffer);

    let extraction: any = null;
    try {
      extraction = await extractDocumentData(file.buffer, category, file.originalname);
    } catch (err) {
      console.warn('Extraction error:', err);
    }

    const docRecord = await this.documentsRepo.register(
      {
        shipmentId,
        paymentId,
        category,
        originalFilename: file.originalname,
        storedPath: path.relative(process.cwd(), storedPath),
        mimeType: file.mimetype,
        fileSizeBytes: file.size,
        extractedData: extraction,
        reviewStatus: extraction?.reviewStatus || 'EXTRACTED',
        ocrApplied: extraction?.ocrApplied || false,
        ocrConfidence: extraction?.ocrConfidence,
        ocrTextPreview: extraction?.ocrTextPreview,
        extractionMethod: extraction?.extractionMethod || 'PDF_TEXT',
      },
      actorUserId
    );

    return { document: docRecord, extraction };
  }

  async resolveDownload(id: string): Promise<{ absolutePath: string; document: DocumentRecord }> {
    const doc = await this.documentsRepo.findById(id);
    if (!doc) {
      throw new NotFoundError('Document not found.');
    }

    const absolutePath = path.resolve(doc.storedPath);
    const storageRoot = getStorageRoot();
    const assetsRoot = path.resolve('public/assets');

    const storagePrefix = storageRoot.endsWith(path.sep) ? storageRoot : `${storageRoot}${path.sep}`;
    const assetsPrefix = assetsRoot.endsWith(path.sep) ? assetsRoot : `${assetsRoot}${path.sep}`;
    const inStorage = absolutePath === storageRoot || absolutePath.startsWith(storagePrefix);
    const inAssets = absolutePath === assetsRoot || absolutePath.startsWith(assetsPrefix);

    if (!inStorage && !inAssets) {
      throw new ForbiddenError('Access denied: document path is outside permitted storage boundaries.');
    }

    try {
      await fsp.access(absolutePath);
    } catch {
      throw new NotFoundError('Physical document file missing on server.');
    }

    return { absolutePath, document: doc };
  }

  async updateReviewStatus(id: string, status: ReviewStatus): Promise<DocumentRecord> {
    return this.documentsRepo.updateReviewStatus(id, status);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    const { deletedDocument } = await this.documentsRepo.delete(id);
    try {
      const fullPath = path.isAbsolute(deletedDocument.storedPath)
        ? deletedDocument.storedPath
        : path.resolve(deletedDocument.storedPath);
      if (fs.existsSync(fullPath)) {
        await fsp.unlink(fullPath);
      }
    } catch (e) {
      console.warn('Could not remove file on disk:', e);
    }
    return { success: true };
  }
}
