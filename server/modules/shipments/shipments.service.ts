/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'fs';
import path from 'path';
import type { DocumentCategory, Shipment } from '../../../shared/contracts/index.ts';
import { normalizeInvoiceKey } from '../../../shared/utils/invoiceNormalizer.ts';
import { getStorageRoot } from '../../config/storage.ts';
import { calculateFobValueInr } from '../../domain/calculations/shipment.calc.ts';
import { NotFoundError, ValidationError } from '../../domain/errors/AppError.ts';
import { extractDocumentData } from '../../extractor.ts';
import { validateDocumentContent } from '../../middleware/upload.ts';
import type { IMastersRepository } from '../masters/masters.repository.ts';
import type { IShipmentsRepository, ShipmentFilter } from './shipments.repository.ts';

export interface UploadedDocFields {
  invoiceDoc?: Express.Multer.File[];
  shippingBillDoc?: Express.Multer.File[];
  blDoc?: Express.Multer.File[];
  brcDoc1?: Express.Multer.File[];
  brcDoc2?: Express.Multer.File[];
  fircDoc?: Express.Multer.File[];
  additionalDoc?: Express.Multer.File[];
}

export class ShipmentsService {
  constructor(
    private readonly shipmentsRepo: IShipmentsRepository,
    private readonly mastersRepo: IMastersRepository
  ) {}

  async listShipments(filters?: ShipmentFilter): Promise<Shipment[]> {
    return this.shipmentsRepo.findAll(filters);
  }

  async getShipmentById(id: string): Promise<Shipment> {
    const shipment = await this.shipmentsRepo.findById(id);
    if (!shipment) throw new NotFoundError('Shipment not found.');
    return shipment;
  }

  async lookupShipments(query: string, financialYearId?: string) {
    const q = query.trim();
    if (!q) return { normalizedQueryKey: '', matches: [] };
    const normalizedQueryKey = normalizeInvoiceKey(q);
    const matches = await this.shipmentsRepo.lookup(q, financialYearId);
    return { normalizedQueryKey, matches };
  }

  async checkInvoiceUnique(invoiceNumber: string, financialYearId?: string) {
    const clean = invoiceNumber.trim();
    const fyId = financialYearId?.trim() || (await this.mastersRepo.findCurrentFinancialYear()).id;
    if (!clean) {
      return { isUnique: true, normalizedKey: '', existingInvoiceNumber: null };
    }
    const normalizedKey = normalizeInvoiceKey(clean);
    const existing = await this.shipmentsRepo.findByNormalizedKey(normalizedKey, fyId);
    return {
      isUnique: !existing,
      normalizedKey,
      existingInvoiceNumber: existing ? existing.invoiceNumber : null,
    };
  }

  async createShipment(data: any, actorUserId: string): Promise<Shipment> {
    if (!data.initialFircPaymentId && !data.initialFircDocumentUploaded) {
      throw new ValidationError(
        'Mandatory Rule Violation: A valid FIRC/payment document or IRM reference must be linked before saving a shipment.'
      );
    }
    const fyId = data.financialYearId || (await this.mastersRepo.findCurrentFinancialYear()).id;
    const today = new Date().toISOString().split('T')[0];

    return this.shipmentsRepo.create({
      ...data,
      financialYearId: fyId,
      invoiceDate: data.invoiceDate || today,
      shippingBillDate: data.shippingBillDate || today,
      fobValueInr:
        data.fobValueInr ?? calculateFobValueInr(Number(data.invoiceValueUsd || 0), Number(data.sbExchangeRate || 84.5)),
      actorUserId,
    });
  }

  async createShipmentWithDocuments(
    body: Record<string, any>,
    files: UploadedDocFields | undefined,
    actorUserId: string
  ): Promise<Shipment> {
    const invoiceNumber = String(body.invoiceNumber || '').trim();
    if (!invoiceNumber) {
      throw new ValidationError('Invoice Number is required and must be unique.');
    }

    const brcUploadMode: 'SINGLE' | 'MULTIPLE' = body.brcUploadMode === 'MULTIPLE' ? 'MULTIPLE' : 'SINGLE';

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

    const hasFircEvidence = Boolean(files?.fircDoc?.[0] || body.fircIrmNumber);
    if (!hasFircEvidence) {
      throw new ValidationError(
        'Mandatory Rule Violation: A valid FIRC/payment document or IRM reference must be linked before saving a shipment.'
      );
    }

    if (brcUploadMode === 'SINGLE' && files?.brcDoc2?.[0]) {
      throw new ValidationError(
        'Single BRC Mode accepts exactly one BRC document. BRC Copy 2 is not permitted in Single mode.'
      );
    }
    if (brcUploadMode === 'MULTIPLE' && (!files?.brcDoc1?.[0] || !files?.brcDoc2?.[0])) {
      throw new ValidationError(
        'Multiple BRC Mode requires exactly two BRC documents (both BRC Copy 1 and BRC Copy 2 must be uploaded).'
      );
    }

    // Run local OCR extraction before opening database transaction
    const extractions: Record<string, any> = {};
    for (const spec of fileSpecs) {
      if (!spec.file) continue;
      try {
        extractions[spec.key] = await extractDocumentData(spec.file.buffer, spec.category, spec.file.originalname);
      } catch (e) {
        console.warn(`Extraction error for ${spec.category}:`, e);
      }
    }

    const currentFy = await this.mastersRepo.findCurrentFinancialYear();
    const financialYearId = body.financialYearId || currentFy.id;
    const allFys = await this.mastersRepo.findFinancialYears();
    const fyLabel = allFys.find((f) => f.id === financialYearId)?.label || currentFy.label;

    const invVal = Number(body.invoiceValueUsd || extractions.invoiceDoc?.fields?.invoiceValueUsd?.value || 0);
    const exRate = Number(body.sbExchangeRate || extractions.shippingBillDoc?.fields?.sbExchangeRate?.value || 92.1);
    const fobVal = Number(
      body.fobValueInr ||
        extractions.shippingBillDoc?.fields?.fobValueInr?.value ||
        calculateFobValueInr(invVal, exRate)
    );
    const today = new Date().toISOString().split('T')[0];
    const invDate = body.invoiceDate || extractions.invoiceDoc?.fields?.invoiceDate?.value || today;
    const sbNo = body.shippingBillNumber || extractions.shippingBillDoc?.fields?.shippingBillNumber?.value || 'PENDING';
    const sbDate = body.shippingBillDate || extractions.shippingBillDoc?.fields?.shippingBillDate?.value || today;
    const pkgs = Number(body.packageCount || extractions.invoiceDoc?.fields?.packageCount?.value || 0);
    const resolvedBlNo = body.blNumber || extractions.blDoc?.fields?.blNumber?.value || undefined;
    const resolvedBlDate = body.blDate || extractions.blDoc?.fields?.blDate?.value || undefined;
    const resolvedVessel =
      body.vesselName ||
      extractions.shippingBillDoc?.fields?.vesselName?.value ||
      extractions.blDoc?.fields?.vesselName?.value ||
      undefined;

    const normalizedKey = normalizeInvoiceKey(invoiceNumber);
    const safeYearDir = path.resolve(getStorageRoot(), `FY${fyLabel}`);
    const safeInvoiceDir = path.resolve(safeYearDir, normalizedKey.replace(/[^A-Z0-9\-_]/gi, '_'));

    const writtenFilePaths: string[] = [];
    const documentsToRegister: any[] = [];

    try {
      const hasAnyFiles = fileSpecs.some((s) => Boolean(s.file));
      if (hasAnyFiles) {
        await fsp.mkdir(safeInvoiceDir, { recursive: true });
      }

      for (const spec of fileSpecs) {
        if (!spec.file) continue;
        const safeFilename = `${spec.category.toLowerCase()}_${Date.now()}_${spec.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
        const storedPath = path.resolve(safeInvoiceDir, safeFilename);
        await fsp.writeFile(storedPath, spec.file.buffer);
        writtenFilePaths.push(storedPath);

        const ext = extractions[spec.key];
        documentsToRegister.push({
          category: spec.category,
          originalFilename: spec.file.originalname,
          storedPath: path.relative(process.cwd(), storedPath),
          mimeType: spec.file.mimetype,
          fileSizeBytes: spec.file.size,
          extractedData: ext,
          reviewStatus: ext?.reviewStatus || 'CONFIRMED',
          ocrApplied: ext?.ocrApplied || false,
          ocrConfidence: ext?.ocrConfidence,
          ocrTextPreview: ext?.ocrTextPreview,
          extractionMethod: ext?.extractionMethod || 'PDF_TEXT',
        });
      }

      return await this.shipmentsRepo.createWithDocumentsTransaction({
        financialYearId,
        invoiceNumber,
        brcUploadMode,
        remarks: body.remarks?.trim() || undefined,
        consigneeId: body.consigneeId,
        consigneeName: body.consigneeName,
        portCode: (body.portCode || 'INMAA1').trim().toUpperCase(),
        packageCount: pkgs,
        invoiceDate: String(invDate),
        invoiceValueUsd: invVal,
        shippingBillNumber: String(sbNo).trim(),
        shippingBillDate: String(sbDate),
        sbExchangeRate: exRate,
        fobValueInr: fobVal,
        blNumber: resolvedBlNo ? String(resolvedBlNo).trim() : undefined,
        blDate: resolvedBlDate ? String(resolvedBlDate) : undefined,
        vesselName: resolvedVessel ? String(resolvedVessel).trim() : undefined,
        fircIrmNumber: body.fircIrmNumber || extractions.fircDoc?.fields?.irmNumber?.value,
        fircSenderRef: body.fircSenderRef || extractions.fircDoc?.fields?.senderReference?.value,
        fircCreditDate: body.fircCreditDate || extractions.fircDoc?.fields?.creditDate?.value,
        fircValueDate: body.fircValueDate || extractions.fircDoc?.fields?.valueDate?.value,
        fircAmountUsd: body.fircAmountUsd
          ? Number(body.fircAmountUsd)
          : extractions.fircDoc?.fields?.verifiedAmount?.value
            ? Number(extractions.fircDoc.fields.verifiedAmount.value)
            : undefined,
        fircExchangeRate: body.fircExchangeRate
          ? Number(body.fircExchangeRate)
          : extractions.fircDoc?.fields?.exchangeRate?.value
            ? Number(extractions.fircDoc.fields.exchangeRate.value)
            : undefined,
        fircInrAmount: body.fircInrAmount
          ? Number(body.fircInrAmount)
          : extractions.fircDoc?.fields?.inrAmount?.value
            ? Number(extractions.fircDoc.fields.inrAmount.value)
            : undefined,
        fircBankName: body.fircBankName,
        brcNumber:
          body.brcNumber ||
          extractions.brcDoc1?.fields?.brcNumber?.value ||
          extractions.brcDoc2?.fields?.brcNumber?.value,
        brcIssueDate: body.brcIssueDate || extractions.brcDoc1?.fields?.issueDate?.value,
        brcRealisationDate: body.brcRealisationDate || extractions.brcDoc1?.fields?.realisationDate?.value,
        brcRealisedAmount: body.brcRealisedAmount
          ? Number(body.brcRealisedAmount)
          : extractions.brcDoc1?.fields?.realisedAmount?.value
            ? Number(extractions.brcDoc1.fields.realisedAmount.value)
            : undefined,
        statutoryDeadline: body.statutoryDeadline || extractions.shippingBillDoc?.fields?.statutoryDeadline?.value,
        dbkClaimed: Number(body.dbkClaimed || extractions.shippingBillDoc?.fields?.dbkClaimed?.value || 0),
        rodtepClaimed: Number(body.rodtepClaimed || extractions.shippingBillDoc?.fields?.rodtepClaimed?.value || 0),
        rosctlClaimed: Number(body.rosctlClaimed || extractions.shippingBillDoc?.fields?.rosctlClaimed?.value || 0),
        hasFircEvidence,
        documentsToRegister,
        actorUserId,
      });
    } catch (err) {
      for (const fp of writtenFilePaths) {
        try {
          await fsp.unlink(fp);
        } catch {
          // ignore cleanup failure
        }
      }
      throw err;
    }
  }

  async updateShipment(id: string, updates: Record<string, any>): Promise<Shipment> {
    return this.shipmentsRepo.update(id, updates);
  }

  async deleteShipment(id: string): Promise<{ success: boolean }> {
    return this.shipmentsRepo.delete(id);
  }

  async archiveShipment(id: string, reason: string | undefined, actorUserId: string): Promise<Shipment> {
    return this.shipmentsRepo.archive(id, reason, actorUserId);
  }

  async restoreShipment(id: string, actorUserId: string): Promise<Shipment> {
    return this.shipmentsRepo.restore(id, actorUserId);
  }
}
