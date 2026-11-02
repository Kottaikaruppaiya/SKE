/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { db } from './db.ts';
import { authenticate, requireRole, generateToken, type AuthenticatedRequest } from './auth.ts';
import { extractDocumentData, mergeExtractedDocuments } from './extractor.ts';
import { generateExportWorkbook, generateCsvExport, parseHistoricalExcelMigration } from './excel.ts';
import { normalizeInvoiceKey } from './normalizer.ts';
import { ocrWorker } from './ocr_worker.ts';
import type { DocumentCategory } from '../src/types/index.ts';

export const apiRouter = express.Router();

// Configure Multer for secure private file storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
});

// --- Auth Routes ---
apiRouter.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !email.trim()) return res.status(400).json({ error: 'Corporate email is required.' });
  if (!password) return res.status(400).json({ error: 'Password is required.' });

  const userWithHash = db.getUserByEmail(email.trim());
  if (!userWithHash || !userWithHash.isActive) {
    return res.status(401).json({ error: 'Invalid credentials or inactive account.' });
  }

  // Strict production password verification against PBKDF2 hash
  if (!db.verifyPassword(password, (userWithHash as any).passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const { passwordHash, ...user } = userWithHash as any;
  const token = generateToken(user);

  db.logAudit({
    userId: user.id,
    action: 'LOGIN',
    entityType: 'SECURITY',
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  res.json({ token, user });
});

apiRouter.get('/auth/me', authenticate, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

// --- Financial Years & Dashboard ---
apiRouter.get('/financial-years', authenticate, (req, res) => {
  res.json(db.getFinancialYears());
});

apiRouter.get('/dashboard', authenticate, (req, res) => {
  const fyId = req.query.financialYearId as string | undefined;
  const metrics = db.getDashboardMetrics(fyId);
  res.json(metrics);
});

// --- Shipments ---
apiRouter.get('/shipments', authenticate, (req, res) => {
  const { financialYearId, consigneeId, paymentStatus, reviewStatus, search } = req.query as any;
  const list = db.getShipments({
    financialYearId,
    consigneeId,
    paymentStatus,
    reviewStatus,
    search,
  });
  res.json(list);
});

apiRouter.get('/shipments/lookup', authenticate, (req, res) => {
  const q = String(req.query.q || '').trim();
  const fyId = req.query.financialYearId as string | undefined;
  if (!q) return res.json({ normalizedQueryKey: '', matches: [] });

  const normalized = normalizeInvoiceKey(q);
  const all = db.getShipments(fyId ? { financialYearId: fyId } : undefined);
  const matched = all.filter(
    (s) =>
      s.normalizedInvoiceKey === normalized ||
      s.invoiceNumber.toLowerCase().includes(q.toLowerCase()) ||
      s.shippingBillNumber.includes(q) ||
      (s.blNumber && s.blNumber.toLowerCase().includes(q.toLowerCase()))
  );
  res.json({ normalizedQueryKey: normalized, matches: matched });
});

apiRouter.get('/shipments/check-unique', authenticate, (req, res) => {
  const invoiceNumber = String(req.query.invoiceNumber || '').trim();
  const financialYearId = String(req.query.financialYearId || 'fy-2026-27').trim();

  if (!invoiceNumber) {
    return res.json({ isUnique: true, normalizedKey: '', existingInvoiceNumber: null });
  }

  const normalizedKey = normalizeInvoiceKey(invoiceNumber);
  const existing = db.getShipments({ financialYearId }).find((s) => s.normalizedInvoiceKey === normalizedKey);

  res.json({
    isUnique: !existing,
    normalizedKey,
    existingInvoiceNumber: existing ? existing.invoiceNumber : null,
  });
});

// --- Batch Extraction Endpoint (Up to 7 documents) ---
apiRouter.post(
  '/documents/extract-batch',
  authenticate,
  upload.fields([
    { name: 'invoiceDoc', maxCount: 1 },
    { name: 'shippingBillDoc', maxCount: 1 },
    { name: 'blDoc', maxCount: 1 },
    { name: 'brcDoc1', maxCount: 1 },
    { name: 'brcDoc2', maxCount: 1 },
    { name: 'fircDoc', maxCount: 1 },
    { name: 'additionalDoc', maxCount: 1 },
  ]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      if (!files || Object.keys(files).length === 0) {
        return res.status(400).json({ error: 'No files provided for extraction.' });
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

      res.json({
        success: true,
        totalFilesParsed: extractionResults.length,
        mergedDraft,
        extractions: extractionsByKey,
        conflicts: mergedDraft.conflicts || [],
      });
    } catch (err: any) {
      console.error('Error in extract-batch:', err);
      res.status(500).json({ error: err.message || 'Batch extraction failed.' });
    }
  }
);

apiRouter.post(
  '/shipments/create-with-documents',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  upload.fields([
    { name: 'invoiceDoc', maxCount: 1 },
    { name: 'shippingBillDoc', maxCount: 1 },
    { name: 'blDoc', maxCount: 1 },
    { name: 'brcDoc1', maxCount: 1 },
    { name: 'brcDoc2', maxCount: 1 },
    { name: 'fircDoc', maxCount: 1 },
    { name: 'additionalDoc', maxCount: 1 },
  ]),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        financialYearId = 'fy-2026-27',
        invoiceNumber,
        brcUploadMode = 'SINGLE',
        remarks = '',
        consigneeId: rawConsigneeId,
        consigneeName,
        portCode = 'INMAA1',
        packageCount,
        invoiceDate,
        invoiceValueUsd,
        shippingBillNumber,
        shippingBillDate,
        sbExchangeRate = 92.1,
        fobValueInr,
        blNumber,
        blDate,
        vesselName,
        // FIRC details
        fircIrmNumber,
        fircSenderRef,
        fircCreditDate,
        fircValueDate,
        fircAmountUsd,
        fircExchangeRate,
        fircInrAmount,
        fircBankName,
        // BRC details
        brcNumber,
        brcIssueDate,
        brcRealisationDate,
        brcRealisedAmount,
        statutoryDeadline,
        // Incentives
        dbkClaimed,
        rodtepClaimed,
        rosctlClaimed,
      } = req.body;

      if (!invoiceNumber || !invoiceNumber.trim()) {
        return res.status(400).json({ error: 'Invoice Number is required and must be unique.' });
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      const extractions: Record<string, any> = {};

      // Match or auto-create Consignee
      let resolvedConsigneeId = rawConsigneeId;
      const consignees = db.getConsignees();
      if (!resolvedConsigneeId && consigneeName) {
        const found = consignees.find((c) => c.name.toLowerCase() === consigneeName.trim().toLowerCase());
        if (found) {
          resolvedConsigneeId = found.id;
        } else {
          const created = db.createConsignee(
            {
              name: consigneeName.trim(),
              country: consigneeName.toLowerCase().includes('lanka') ? 'Sri Lanka' : 'International',
              portOfDischarge: 'LKCMB - Colombo',
              paymentTerms: 'FOB COLOMBO | DA 90 DAYS',
              currency: 'USD',
              isActive: true,
            },
            req.user!.id
          );
          resolvedConsigneeId = created.id;
        }
      }
      if (!resolvedConsigneeId) {
        resolvedConsigneeId = consignees[0]?.id;
      }

      // Match or auto-create Bank
      const banks = db.getBanks();
      let resolvedBankId = banks[0]?.id;
      if (fircBankName) {
        const bankMatch = banks.find((b) => b.name.toLowerCase().includes(fircBankName.toLowerCase()));
        if (bankMatch) resolvedBankId = bankMatch.id;
      }

      // Extract uploaded documents
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
        if (!spec.file) continue;
        try {
          const ext = await extractDocumentData(spec.file.buffer, spec.category, spec.file.originalname);
          extractions[spec.key] = ext;
        } catch (e) {
          console.warn(`Extraction error for ${spec.category}:`, e);
        }
      }

      // Extract/Fallback financial parameters
      const invVal = Number(invoiceValueUsd || extractions.invoiceDoc?.fields?.invoiceValueUsd?.value || 0);
      const exRate = Number(sbExchangeRate || extractions.shippingBillDoc?.fields?.sbExchangeRate?.value || 92.1);
      const fobVal = Number(fobValueInr || extractions.shippingBillDoc?.fields?.fobValueInr?.value || Math.round(invVal * exRate * 100) / 100);
      const invDate = invoiceDate || extractions.invoiceDoc?.fields?.invoiceDate?.value || new Date().toISOString().split('T')[0];
      const sbNo = shippingBillNumber || extractions.shippingBillDoc?.fields?.shippingBillNumber?.value || 'PENDING';
      const sbDate = shippingBillDate || extractions.shippingBillDoc?.fields?.shippingBillDate?.value || new Date().toISOString().split('T')[0];
      const pkgs = Number(packageCount || extractions.invoiceDoc?.fields?.packageCount?.value || 0);
      const resolvedBlNo = blNumber || extractions.blDoc?.fields?.blNumber?.value || undefined;
      const resolvedBlDate = blDate || extractions.blDoc?.fields?.blDate?.value || undefined;
      const resolvedVessel = vesselName || extractions.shippingBillDoc?.fields?.vesselName?.value || extractions.blDoc?.fields?.vesselName?.value || undefined;

      // Mandatory Rule: Require FIRC/payment linkage before saving a shipment
      const hasFircEvidence = Boolean(files?.fircDoc?.[0] || fircIrmNumber);
      if (!hasFircEvidence) {
        return res.status(400).json({
          error: 'Mandatory Rule Violation: A valid FIRC/payment document or IRM reference must be linked before saving a shipment.'
        });
      }

      // Mandatory Rule: BRC Mode validation
      if (brcUploadMode === 'SINGLE') {
        if (files?.brcDoc2?.[0]) {
          return res.status(400).json({
            error: 'Single BRC Mode accepts exactly one BRC document. BRC Copy 2 is not permitted in Single mode.'
          });
        }
      } else if (brcUploadMode === 'MULTIPLE') {
        if (!files?.brcDoc1?.[0] || !files?.brcDoc2?.[0]) {
          return res.status(400).json({
            error: 'Multiple BRC Mode requires exactly two BRC documents (both BRC Copy 1 and BRC Copy 2 must be uploaded).'
          });
        }
      }

      // Create shipment in DB
      const shipment = db.createShipment(
        {
          financialYearId,
          invoiceNumber: invoiceNumber.trim(),
          invoiceDate: String(invDate),
          consigneeId: resolvedConsigneeId,
          portCode: (portCode || 'INMAA1').trim().toUpperCase(),
          packageCount: pkgs,
          invoiceValueUsd: invVal,
          shippingBillNumber: String(sbNo).trim(),
          shippingBillDate: String(sbDate),
          sbExchangeRate: exRate,
          fobValueInr: fobVal,
          blNumber: resolvedBlNo ? String(resolvedBlNo).trim() : undefined,
          blDate: resolvedBlDate ? String(resolvedBlDate) : undefined,
          vesselName: resolvedVessel ? String(resolvedVessel).trim() : undefined,
          remarks: remarks?.trim() || undefined,
          initialFircDocumentUploaded: hasFircEvidence,
          incentives: {
            dbkClaimed: Number(dbkClaimed || extractions.shippingBillDoc?.fields?.dbkClaimed?.value || 0),
            rodtepClaimed: Number(rodtepClaimed || extractions.shippingBillDoc?.fields?.rodtepClaimed?.value || 0),
            rosctlClaimed: Number(rosctlClaimed || extractions.shippingBillDoc?.fields?.rosctlClaimed?.value || 0),
          },
          brc: {
            uploadMode: (brcUploadMode === 'MULTIPLE' ? 'MULTIPLE' : 'SINGLE') as 'SINGLE' | 'MULTIPLE',
            statutoryDeadline: statutoryDeadline || extractions.shippingBillDoc?.fields?.statutoryDeadline?.value || undefined,
            remarks: remarks?.trim(),
          },
        },
        req.user!.id
      );

      // Audit manual corrections vs extracted values
      const manualEdits: Record<string, { extracted: any; accepted: any }> = {};
      if (extractions.invoiceDoc?.fields?.invoiceValueUsd?.value !== undefined && Number(extractions.invoiceDoc.fields.invoiceValueUsd.value) !== invVal) {
        manualEdits['invoiceValueUsd'] = { extracted: extractions.invoiceDoc.fields.invoiceValueUsd.value, accepted: invVal };
      }
      if (extractions.shippingBillDoc?.fields?.fobValueInr?.value !== undefined && Number(extractions.shippingBillDoc.fields.fobValueInr.value) !== fobVal) {
        manualEdits['fobValueInr'] = { extracted: extractions.shippingBillDoc.fields.fobValueInr.value, accepted: fobVal };
      }
      if (Object.keys(manualEdits).length > 0) {
        db.logAudit({
          userId: req.user!.id,
          userName: req.user!.name,
          action: 'MANUAL_EXTRACTION_CORRECTION',
          entityType: 'SHIPMENT',
          entityId: shipment.id,
          newValues: manualEdits,
        });
      }

      // Handle FIRC payment creation & allocation
      const finalIrm = fircIrmNumber || extractions.fircDoc?.fields?.irmNumber?.value;
      if (finalIrm) {
        const cleanIrm = String(finalIrm).trim().toUpperCase();
        let existingPayment = db.getPayments().find((p) => p.irmNumber.toUpperCase() === cleanIrm);
        const fircAmt = Number(fircAmountUsd || extractions.fircDoc?.fields?.verifiedAmount?.value || invVal);

        if (!existingPayment) {
          existingPayment = db.createPayment(
            {
              irmNumber: cleanIrm,
              senderReference: fircSenderRef || extractions.fircDoc?.fields?.senderReference?.value || undefined,
              currency: 'USD',
              verifiedAmount: fircAmt,
              inrAmount: Number(fircInrAmount || extractions.fircDoc?.fields?.inrAmount?.value || Math.round(fircAmt * 93.28 * 100) / 100),
              exchangeRate: Number(fircExchangeRate || extractions.fircDoc?.fields?.exchangeRate?.value || 93.28),
              valueDate: fircValueDate || extractions.fircDoc?.fields?.valueDate?.value || String(invDate),
              creditDate: fircCreditDate || extractions.fircDoc?.fields?.creditDate?.value || String(invDate),
              fircIssueDate: fircCreditDate || extractions.fircDoc?.fields?.creditDate?.value || String(invDate),
              bankId: resolvedBankId,
              purposeCode: 'P0103',
              remarks: `Payment for invoice ${invoiceNumber.trim()}`,
            },
            req.user!.id
          );
        }

        // Allocate to this shipment
        const allocAmount = Math.min(fircAmt, invVal);
        if (allocAmount > 0) {
          try {
            db.allocatePayment(
              {
                paymentId: existingPayment.id,
                shipmentId: shipment.id,
                allocatedAmountUsd: allocAmount,
                notes: `Auto-allocated on shipment creation (${invoiceNumber.trim()})`,
              },
              req.user!.id
            );
          } catch (allocErr) {
            console.warn('Payment allocation warning on create:', allocErr);
          }
        }
      }

      // Handle BRC details
      const finalBrcNo = brcNumber || extractions.brcDoc1?.fields?.brcNumber?.value || extractions.brcDoc2?.fields?.brcNumber?.value;
      if (finalBrcNo) {
        db.updateBrcRecord(
          shipment.id,
          {
            brcNumber: String(finalBrcNo).trim(),
            issueDate: brcIssueDate || extractions.brcDoc1?.fields?.issueDate?.value || undefined,
            realisationDate: brcRealisationDate || extractions.brcDoc1?.fields?.realisationDate?.value || undefined,
            realisedAmount: Number(brcRealisedAmount || extractions.brcDoc1?.fields?.realisedAmount?.value || invVal),
            realisedCurrency: 'USD',
            status: 'REALISED',
          },
          req.user!.id
        );
      }

      // Save uploaded files to storage
      const normalizedKey = shipment.normalizedInvoiceKey;
      const fyLabel = db.getFinancialYears().find((f) => f.id === financialYearId)?.label || '2026-27';
      const safeYearDir = path.resolve('storage', `FY${fyLabel}`);
      const safeInvoiceDir = path.resolve(safeYearDir, normalizedKey.replace(/[^A-Z0-9\-_]/gi, '_'));
      if (!fs.existsSync(safeInvoiceDir)) fs.mkdirSync(safeInvoiceDir, { recursive: true });

      for (const spec of fileSpecs) {
        if (!spec.file) continue;
        const safeFilename = `${spec.category.toLowerCase()}_${Date.now()}_${spec.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
        const storedPath = path.resolve(safeInvoiceDir, safeFilename);
        fs.writeFileSync(storedPath, spec.file.buffer);

        const ext = extractions[spec.key];

        db.registerDocument(
          {
            shipmentId: shipment.id,
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
          },
          req.user!.id
        );
      }

      // Return fully hydrated shipment
      const fullShipment = db.getShipmentById(shipment.id);
      res.status(201).json(fullShipment);
    } catch (err: any) {
      console.error('Error in create-with-documents:', err);
      res.status(400).json({ error: err.message || 'Failed to create shipment.' });
    }
  }
);

apiRouter.post(
  '/shipments',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const shipment = db.createShipment(req.body, req.user!.id);
      res.status(201).json(shipment);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create shipment.' });
    }
  }
);

apiRouter.get('/shipments/:id', authenticate, (req, res) => {
  const item = db.getShipmentById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Shipment not found.' });
  res.json(item);
});

apiRouter.put(
  '/shipments/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updateShipment(req.params.id, req.body, req.user!.id);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update shipment.' });
    }
  }
);

apiRouter.delete(
  '/shipments/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = db.deleteShipment(req.params.id, req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete shipment.' });
    }
  }
);

apiRouter.post(
  '/shipments/:id/archive',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const archived = db.archiveShipment(req.params.id, req.body.reason, req.user!.id);
      res.json(archived);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to archive shipment.' });
    }
  }
);

apiRouter.post(
  '/shipments/:id/restore',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const restored = db.restoreShipment(req.params.id, req.user!.id);
      res.json(restored);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to restore shipment.' });
    }
  }
);

// --- Payments & Allocations ---
apiRouter.get('/payments', authenticate, (req, res) => {
  res.json(db.getPayments());
});

apiRouter.get('/payments/:id', authenticate, (req, res) => {
  const payment = db.getPaymentById(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Payment not found.' });
  res.json(payment);
});

apiRouter.post(
  '/payments',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const payment = db.createPayment(req.body, req.user!.id);
      res.status(201).json(payment);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create payment record.' });
    }
  }
);

apiRouter.put(
  '/payments/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updatePayment(req.params.id, req.body, req.user!.id);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update payment.' });
    }
  }
);

apiRouter.delete(
  '/payments/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = db.deletePayment(req.params.id, req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete payment.' });
    }
  }
);

apiRouter.post(
  '/allocations',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const allocation = db.allocatePayment(req.body, req.user!.id);
      res.status(201).json(allocation);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Allocation failed.' });
    }
  }
);

apiRouter.delete(
  '/allocations/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      db.deallocatePayment(req.params.id, req.user!.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Deallocation failed.' });
    }
  }
);

// --- Incentives & BRC ---
apiRouter.post(
  '/incentives',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const created = db.createIncentive(req.body, req.user!.id);
      res.status(201).json(created);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create incentive.' });
    }
  }
);

apiRouter.put(
  '/incentives/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updateIncentive(req.params.id, req.body, req.user!.id);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update incentive.' });
    }
  }
);

apiRouter.delete(
  '/incentives/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = db.deleteIncentive(req.params.id, req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete incentive.' });
    }
  }
);

apiRouter.put(
  '/brc/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updateBrcRecord(req.params.id, req.body, req.user!.id);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update BRC record.' });
    }
  }
);

apiRouter.post(
  '/brc/:id/reset',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const reset = db.resetBrcRecord(req.params.id, req.user!.id);
      res.json(reset);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to reset BRC record.' });
    }
  }
);

// --- Asynchronous OCR Job Queue & Staging Endpoints ---
apiRouter.get('/ocr/jobs', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const status = req.query.status as any;
  const category = req.query.category as any;
  const jobs = db.getOcrJobs({ status, category });
  res.json({
    jobs,
    concurrency: ocrWorker.getConcurrencyMetrics(),
  });
});

apiRouter.get('/ocr/jobs/:id', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const job = db.getOcrJobById(req.params.id);
  if (!job) return res.status(404).json({ error: 'OCR Job not found.' });
  res.json(job);
});

apiRouter.post(
  '/ocr/jobs',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  upload.single('file'),
  (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No document file provided for OCR queue.' });
    }

    const category = (req.body.category || 'COMMERCIAL_INVOICE') as DocumentCategory;
    const financialYearId = req.body.financialYearId || 'fy-2026-27';

    // Enqueue job without blocking Express request
    const job = db.enqueueOcrJob(
      {
        originalFilename: req.file.originalname,
        fileSizeBytes: req.file.size,
        category,
        financialYearId,
      },
      req.user!.id
    );

    // Register staging buffer for background worker
    ocrWorker.registerStagingBuffer(job.id, req.file.buffer);

    // Save backup staging copy on disk
    try {
      const stagingPath = path.resolve('storage/staging', `${job.id}.bin`);
      fs.writeFileSync(stagingPath, req.file.buffer);
    } catch {}

    // Trigger worker asynchronously
    ocrWorker.triggerProcessing();

    res.status(202).json({
      success: true,
      message: 'Document queued for background server-side OCR processing.',
      job,
    });
  }
);

apiRouter.post(
  '/ocr/jobs/:id/retry',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const job = db.retryOcrJob(req.params.id, req.user!.id);
      ocrWorker.triggerProcessing();
      res.json(job);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to retry job.' });
    }
  }
);

apiRouter.delete(
  '/ocr/jobs/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = db.deleteOcrJob(req.params.id, req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete job.' });
    }
  }
);

apiRouter.post(
  '/ocr/jobs/:id/approve',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const reviewedValues = req.body.reviewedValues || req.body;
      const result = db.approveOcrJob(req.params.id, reviewedValues, req.user!.id);
      res.json({
        success: true,
        message: 'Candidate OCR data approved and committed to ledger.',
        ...result,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to approve OCR data.' });
    }
  }
);

// --- Document Management & Local Extraction ---
apiRouter.get('/documents', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const shipmentId = req.query.shipmentId as string | undefined;
  const paymentId = req.query.paymentId as string | undefined;
  res.json(db.getDocuments(shipmentId || paymentId ? { shipmentId, paymentId } : undefined));
});

apiRouter.post(
  '/documents/upload',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  upload.single('file'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No document file uploaded.' });
    }

    const category = (req.body.category || 'COMMERCIAL_INVOICE') as DocumentCategory;
    const shipmentId = req.body.shipmentId || undefined;
    const paymentId = req.body.paymentId || undefined;
    const financialYear = req.body.financialYear || '2026-27';
    const invoiceKey = req.body.invoiceKey || (shipmentId ? db.getShipmentById(shipmentId)?.normalizedInvoiceKey : 'GENERAL');

    // Rule: BRC Single Mode vs Multiple Mode count check
    if (shipmentId && (category === 'BRC_COPY_1' || category === 'BRC_COPY_2')) {
      const shipment = db.getShipmentById(shipmentId);
      const brcRecord = shipment?.brcRecord;
      if (brcRecord) {
        const existingBrcDocs = db.getDocuments({ shipmentId }).filter((d) => d.isCurrent && (d.category === 'BRC_COPY_1' || d.category === 'BRC_COPY_2'));
        if (brcRecord.uploadMode === 'SINGLE' && category === 'BRC_COPY_2') {
          return res.status(400).json({
            error: 'Single BRC Mode is active for this shipment. Exactly one BRC copy is permitted. Switch to Multiple mode to attach Copy 2.',
          });
        }
      }
    }

    // Server-side storage path per Section 7:
    // storage/FY{year}/{normalized_key}/{filename}
    const safeYearDir = path.resolve('storage', `FY${financialYear}`);
    const safeInvoiceDir = path.resolve(safeYearDir, invoiceKey.replace(/[^A-Z0-9\-_]/gi, '_'));
    if (!fs.existsSync(safeInvoiceDir)) fs.mkdirSync(safeInvoiceDir, { recursive: true });

    const safeFilename = `${category.toLowerCase()}_${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const storedPath = path.resolve(safeInvoiceDir, safeFilename);

    fs.writeFileSync(storedPath, req.file.buffer);

    // Run local extraction using pdf-parse & rules (no external APIs!)
    let extraction: any = null;
    try {
      extraction = await extractDocumentData(req.file.buffer, category, req.file.originalname);
    } catch (err) {
      console.warn('Extraction error:', err);
    }

    const docRecord = db.registerDocument(
      {
        shipmentId,
        paymentId,
        category,
        originalFilename: req.file.originalname,
        storedPath: path.relative(process.cwd(), storedPath),
        mimeType: req.file.mimetype,
        fileSizeBytes: req.file.size,
        extractedData: extraction,
        reviewStatus: extraction?.reviewStatus || 'EXTRACTED',
      },
      req.user!.id
    );

    res.status(201).json({
      document: docRecord,
      extraction,
    });
  }
);

apiRouter.get('/documents/:id/download', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const doc = db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const absolutePath = path.resolve(doc.storedPath);
  const storageRoot = path.resolve('storage');
  const assetsRoot = path.resolve('public/assets');

  // Path containment guard: prevent path traversal attacks
  if (!absolutePath.startsWith(storageRoot) && !absolutePath.startsWith(assetsRoot)) {
    return res.status(403).json({ error: 'Access denied: document path is outside permitted storage boundaries.' });
  }

  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ error: 'Physical document file missing on server.' });
  }

  db.logAudit({
    userId: req.user!.id,
    userName: req.user!.name,
    action: 'DOWNLOAD',
    entityType: 'DOCUMENT',
    entityId: doc.id,
    newValues: { filename: doc.originalFilename, category: doc.category },
  });

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.originalFilename)}"`);
  res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
  fs.createReadStream(absolutePath).pipe(res);
});

apiRouter.put(
  '/documents/:id/review',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const doc = db.updateDocumentReviewStatus(req.params.id, req.body.reviewStatus, req.user!.id);
      res.json(doc);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update review status.' });
    }
  }
);

apiRouter.delete(
  '/documents/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = db.deleteDocument(req.params.id, req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete document.' });
    }
  }
);

// --- Masters: Consignees & Banks ---
apiRouter.get('/masters/consignees', authenticate, (req, res) => {
  res.json(db.getConsignees());
});

apiRouter.post(
  '/masters/consignees',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const created = db.createConsignee(req.body, req.user!.id);
      res.status(201).json(created);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

apiRouter.put(
  '/masters/consignees/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updateConsignee(req.params.id, req.body, req.user!.id);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

apiRouter.delete(
  '/masters/consignees/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = db.deleteConsignee(req.params.id, req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete consignee.' });
    }
  }
);

apiRouter.get('/masters/banks', authenticate, (req, res) => {
  res.json(db.getBanks());
});

apiRouter.post(
  '/masters/banks',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const created = db.createBank(req.body, req.user!.id);
      res.status(201).json(created);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

apiRouter.put(
  '/masters/banks/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updateBank(req.params.id, req.body, req.user!.id);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

apiRouter.delete(
  '/masters/banks/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = db.deleteBank(req.params.id, req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete bank.' });
    }
  }
);

// --- Excel & CSV Import & Export ---
apiRouter.get('/excel/export', authenticate, (req, res) => {
  const fyId = req.query.financialYearId as string | undefined;
  const buffer = generateExportWorkbook(fyId);
  const fyLabel = fyId ? db.getFinancialYears().find((f) => f.id === fyId)?.label || 'All' : 'All';
  const filename = `SKE_Export_Realisation_Tracker_${fyLabel}_${new Date().toISOString().split('T')[0]}.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

apiRouter.get('/excel/export-csv', authenticate, (req, res) => {
  const sheet = String(req.query.sheet || 'Export Tracker');
  const fyId = req.query.financialYearId as string | undefined;
  const csvContent = generateCsvExport(sheet, fyId);
  const safeSheet = sheet.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const filename = `SKE_${safeSheet}_${new Date().toISOString().split('T')[0]}.csv`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csvContent);
});

apiRouter.post(
  '/excel/import',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  upload.single('file'),
  (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an Excel workbook (.xlsx or .xlsm) or CSV file (.csv).' });
    }

    const fyId = req.body.financialYearId || db.getCurrentFinancialYear().id;
    try {
      const report = parseHistoricalExcelMigration(req.file.buffer, fyId, req.user!.id);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Error parsing Excel/CSV migration file.' });
    }
  }
);

// --- Audit History ---
apiRouter.get('/audit', authenticate, (req, res) => {
  const limit = parseInt(String(req.query.limit || '100'), 10);
  res.json(db.getAuditLogs(limit));
});

// --- User Management (SUPER ADMIN ONLY) ---
apiRouter.get('/users', authenticate, requireRole(['SUPER_ADMIN']), (req, res) => {
  res.json(db.getUsers());
});

apiRouter.post(
  '/users',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    const { email, name, role, password } = req.body;
    if (!email || !name || !role || !password) {
      return res.status(400).json({ error: 'Email, name, role, and password are required.' });
    }

    try {
      const created = db.createUser(
        { email, name, role, isActive: true },
        password,
        req.user!.id
      );
      res.status(201).json(created);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

apiRouter.put(
  '/users/:id',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updateUser(req.params.id, req.body, req.user!.id);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

apiRouter.delete(
  '/users/:id',
  authenticate,
  requireRole(['SUPER_ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = db.deleteUser(req.params.id, req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

// --- Settings ---
apiRouter.get('/settings', authenticate, (req, res) => {
  res.json(db.getSettings());
});

apiRouter.put(
  '/settings',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updateSettings(req.body, req.user!.id);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

// --- Danger Zone / System Purge ---
apiRouter.post(
  '/system/clear-records',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = db.clearAllOperationalData(req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to clear operational records.' });
    }
  }
);

apiRouter.post(
  '/system/reseed',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = db.reseedWithDefaults(req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to reseed database.' });
    }
  }
);
