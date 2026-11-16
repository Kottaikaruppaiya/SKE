/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { db } from './db.ts';
import { authenticate, requireRole, generateToken, generateDownloadTicket, authenticateDownload, type AuthenticatedRequest } from './auth.ts';
import { extractDocumentData, mergeExtractedDocuments } from './extractor.ts';
import { generateExportWorkbook, generateCsvExport, parseHistoricalExcelMigration, generateGstExcelExport } from './excel.ts';
import { previewB2bWorkbook, generateB2bExcelExport, generateB2bMonthlySummaryExcel } from './b2b_excel.ts';
import { normalizeInvoiceKey } from './normalizer.ts';
import { ocrWorker, getOcrStagingDir } from './ocr_worker.ts';
import type { DocumentCategory } from '../src/types/index.ts';

export const apiRouter = express.Router();

const asyncHandler =
  (fn: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<any> | any) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as AuthenticatedRequest, res, next)).catch(next);
  };

// Helper to resolve the configured STORAGE_ROOT dynamically with directory creation
export const getStorageDir = () => {
  const root = process.env.STORAGE_ROOT ? path.resolve(process.env.STORAGE_ROOT) : path.resolve('storage');
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
};

// Allowed upload MIME types and file extensions (Item 15: Validate upload MIME/content)
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
]);

const MAX_UPLOAD_SIZE_MB = parseInt(process.env.MAX_OCR_FILE_SIZE_MB || '50', 10);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isAllowedExt = ['.pdf', '.xlsx', '.xls', '.csv', '.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    if (ALLOWED_MIME_TYPES.has(file.mimetype.toLowerCase()) || isAllowedExt) {
      cb(null, true);
    } else {
      cb(new Error(`Security Policy: Uploaded file type "${file.mimetype || ext}" is not permitted. Only PDF, XLSX, CSV, and image documents are accepted.`));
    }
  },
});

// Helper to validate document content buffer (magic bytes)
export function validateDocumentContent(buffer: Buffer, filename?: string): boolean {
  if (!buffer || buffer.length === 0) return false;
  // PDF magic bytes: %PDF (0x25 0x50 0x44 0x46)
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return true;
  }
  // PNG: 0x89 0x50 0x4E 0x47
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return true;
  }
  // JPEG: 0xFF 0xD8 0xFF
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return true;
  }
  // WebP: RIFF ... WEBP
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return true;
  }
  // Excel / CSV: allow if extension is spreadsheet/csv or PK zip
  if (filename && /\.(xlsx|xls|csv)$/i.test(filename)) {
    return true;
  }
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return true;
  }
  return false;
}

// In-memory rate limiting / lockout store for login attempts (Item 7)
interface LoginAttempt {
  count: number;
  lockedUntil?: number;
}
const loginAttempts = new Map<string, LoginAttempt>();

// Clean up stale attempts periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, attempt] of loginAttempts.entries()) {
    if (attempt.lockedUntil && attempt.lockedUntil < now) {
      loginAttempts.delete(key);
    }
  }
}, 60000).unref();

// --- Auth Routes ---
apiRouter.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !email.trim()) return res.status(400).json({ error: 'Corporate email is required.' });
  if (!password) return res.status(400).json({ error: 'Password is required.' });

  const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
  const cleanEmail = email.trim().toLowerCase();
  const attemptKey = `${clientIp}_${cleanEmail}`;

  const currentAttempt = loginAttempts.get(attemptKey);
  const now = Date.now();
  if (currentAttempt && currentAttempt.lockedUntil && currentAttempt.lockedUntil > now) {
    const remainingMinutes = Math.ceil((currentAttempt.lockedUntil - now) / 60000);
    return res.status(429).json({
      error: `Account temporarily locked due to excessive failed attempts. Please retry in ${remainingMinutes} minute(s).`,
    });
  }

  const userWithHash = db.getUserByEmail(cleanEmail);
  if (!userWithHash || !userWithHash.isActive) {
    // Record failed attempt
    const attempt = currentAttempt || { count: 0 };
    attempt.count += 1;
    if (attempt.count >= 5) {
      attempt.lockedUntil = now + 15 * 60 * 1000; // 15 minute lockout
    }
    loginAttempts.set(attemptKey, attempt);
    return res.status(401).json({ error: 'Invalid credentials or inactive account.' });
  }

  // Strict production password verification against PBKDF2 hash
  if (!db.verifyPassword(password, (userWithHash as any).passwordHash)) {
    const attempt = currentAttempt || { count: 0 };
    attempt.count += 1;
    if (attempt.count >= 5) {
      attempt.lockedUntil = now + 15 * 60 * 1000;
      loginAttempts.set(attemptKey, attempt);
      return res.status(429).json({
        error: 'Account temporarily locked due to 5 consecutive failed attempts. Please retry after 15 minutes.',
      });
    }
    loginAttempts.set(attemptKey, attempt);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  // Reset rate limiting on successful authentication
  loginAttempts.delete(attemptKey);

  const { passwordHash, ...user } = userWithHash as any;
  const token = generateToken(user);

  res.json({ token, user, mustChangePassword: Boolean(user.mustChangePassword) });
});

apiRouter.post('/auth/change-password', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
  }

  const userWithHash = db.getUserByEmail(req.user!.email);
  if (!userWithHash) {
    return res.status(404).json({ error: 'User record not found.' });
  }

  // Verify current password unless user has mandatory mustChangePassword flag
  if (!userWithHash.mustChangePassword) {
    if (!currentPassword || !db.verifyPassword(currentPassword, (userWithHash as any).passwordHash)) {
      return res.status(401).json({ error: 'Current password verification failed.' });
    }
  }

  const updatedUser = db.updateUser(req.user!.id, { password: newPassword }, req.user!.id);
  const newToken = generateToken(updatedUser);

  res.json({
    success: true,
    message: 'Password changed successfully. All previous sessions have been invalidated.',
    token: newToken,
    user: updatedUser,
  });
});

apiRouter.get('/auth/download-ticket', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const fileId = req.query.fileId as string | undefined;
  const ticket = generateDownloadTicket(req.user!, fileId);
  res.json({ ticket });
});

apiRouter.post('/auth/logout', authenticate, (req: AuthenticatedRequest, res) => {
  if (req.token && req.user) {
    let expiresAt: string | undefined;
    try {
      const decoded = jwt.decode(req.token) as any;
      if (decoded && decoded.exp) {
        expiresAt = new Date(decoded.exp * 1000).toISOString();
      }
    } catch {}
    db.revokeToken(req.token, req.user.id, expiresAt);
  }
  res.json({ success: true, message: 'Session revoked and logged out successfully.' });
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
  const financialYearId = String(req.query.financialYearId || db.getCurrentFinancialYear().id).trim();

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
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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

    for (const spec of fileSpecs) {
      if (spec.file && !validateDocumentContent(spec.file.buffer, spec.file.originalname)) {
        return res.status(400).json({
          error: `Invalid or corrupted file signature for "${spec.file.originalname}".`,
        });
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

    res.json({
      success: true,
      totalFilesParsed: extractionResults.length,
      mergedDraft,
      extractions: extractionsByKey,
      conflicts: mergedDraft.conflicts || [],
    });
  })
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
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const {
      financialYearId = db.getCurrentFinancialYear().id,
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
        return res.status(400).json({
          error: `Invalid or corrupted file signature for "${spec.file.originalname}".`,
        });
      }
    }

    // Mandatory Rule: Require FIRC/payment linkage before saving a shipment
    const hasFircEvidence = Boolean(files?.fircDoc?.[0] || fircIrmNumber);
    if (!hasFircEvidence) {
      return res.status(400).json({
        error: 'Mandatory Rule Violation: A valid FIRC/payment document or IRM reference must be linked before saving a shipment.',
      });
    }

    // Mandatory Rule: BRC Mode validation
    if (brcUploadMode === 'SINGLE') {
      if (files?.brcDoc2?.[0]) {
        return res.status(400).json({
          error: 'Single BRC Mode accepts exactly one BRC document. BRC Copy 2 is not permitted in Single mode.',
        });
      }
    } else if (brcUploadMode === 'MULTIPLE') {
      if (!files?.brcDoc1?.[0] || !files?.brcDoc2?.[0]) {
        return res.status(400).json({
          error: 'Multiple BRC Mode requires exactly two BRC documents (both BRC Copy 1 and BRC Copy 2 must be uploaded).',
        });
      }
    }

    // Extract uploaded documents before entering transaction
    const extractions: Record<string, any> = {};
    for (const spec of fileSpecs) {
      if (!spec.file) continue;
      try {
        const ext = await extractDocumentData(spec.file.buffer, spec.category, spec.file.originalname);
        extractions[spec.key] = ext;
      } catch (e) {
        console.warn(`Extraction error for ${spec.category}:`, e);
      }
    }

    const writtenFilePaths: string[] = [];
    try {
      const fullShipment = await db.runInTransaction(async () => {
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

        // Match Bank
        const banks = db.getBanks();
        let resolvedBankId = banks[0]?.id;
        if (fircBankName) {
          const bankMatch = banks.find((b) => b.name.toLowerCase().includes(fircBankName.toLowerCase()));
          if (bankMatch) resolvedBankId = bankMatch.id;
        }

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

        // Handle FIRC payment creation & allocation transactionally
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

          const allocAmount = Math.min(fircAmt, invVal);
          if (allocAmount > 0) {
            db.allocatePayment(
              {
                paymentId: existingPayment.id,
                shipmentId: shipment.id,
                allocatedAmountUsd: allocAmount,
                notes: `Auto-allocated on shipment creation (${invoiceNumber.trim()})`,
              },
              req.user!.id
            );
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

        // Save uploaded files asynchronously
        const normalizedKey = shipment.normalizedInvoiceKey;
        const fyLabel = db.getFinancialYears().find((f) => f.id === financialYearId)?.label || db.getCurrentFinancialYear().label;
        const safeYearDir = path.resolve(getStorageDir(), `FY${fyLabel}`);
        const safeInvoiceDir = path.resolve(safeYearDir, normalizedKey.replace(/[^A-Z0-9\-_]/gi, '_'));
        await fsp.mkdir(safeInvoiceDir, { recursive: true });

        for (const spec of fileSpecs) {
          if (!spec.file) continue;
          const safeFilename = `${spec.category.toLowerCase()}_${Date.now()}_${spec.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
          const storedPath = path.resolve(safeInvoiceDir, safeFilename);
          await fsp.writeFile(storedPath, spec.file.buffer);
          writtenFilePaths.push(storedPath);

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

        return db.getShipmentById(shipment.id);
      });

      res.status(201).json(fullShipment);
    } catch (err: any) {
      // Clean up any written files on transaction rollback
      for (const fp of writtenFilePaths) {
        try {
          await fsp.unlink(fp);
        } catch {}
      }
      return res.status(400).json({ error: err.message || 'Failed to create shipment.' });
    }
  })
);

apiRouter.post(
  '/shipments',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { initialFircPaymentId, initialFircDocumentUploaded } = req.body || {};
    if (!initialFircPaymentId && !initialFircDocumentUploaded) {
      return res.status(400).json({
        error: 'Mandatory Rule Violation: A valid FIRC/payment document or IRM reference must be linked before saving a shipment.',
      });
    }
    try {
      const shipment = db.createShipment(req.body, req.user!.id);
      res.status(201).json(shipment);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create shipment.' });
    }
  })
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
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No document file provided for OCR queue.' });
    }
    if (!validateDocumentContent(req.file.buffer, req.file.originalname)) {
      return res.status(400).json({ error: `Invalid or corrupted file content for "${req.file.originalname}".` });
    }

    const category = (req.body.category || 'COMMERCIAL_INVOICE') as DocumentCategory;
    const financialYearId = req.body.financialYearId || db.getCurrentFinancialYear().id;

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

    // Save backup staging copy on disk asynchronously inside STORAGE_ROOT/staging
    try {
      const stagingDir = getOcrStagingDir();
      const stagingPath = path.resolve(stagingDir, `${job.id}.bin`);
      await fsp.writeFile(stagingPath, req.file.buffer);
    } catch {}

    // Trigger worker asynchronously
    ocrWorker.triggerProcessing();

    res.status(202).json({
      success: true,
      message: 'Document queued for background server-side OCR processing.',
      job,
    });
  })
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
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No document file uploaded.' });
    }
    if (!validateDocumentContent(req.file.buffer, req.file.originalname)) {
      return res.status(400).json({ error: `Invalid or corrupted file signature for "${req.file.originalname}".` });
    }

    const category = (req.body.category || 'COMMERCIAL_INVOICE') as DocumentCategory;
    const shipmentId = req.body.shipmentId || undefined;
    const paymentId = req.body.paymentId || undefined;
    const financialYear = req.body.financialYear || db.getCurrentFinancialYear().label;
    const invoiceKey = req.body.invoiceKey || (shipmentId ? db.getShipmentById(shipmentId)?.normalizedInvoiceKey : 'GENERAL');

    // Rule: BRC Single Mode vs Multiple Mode count check
    if (shipmentId && (category === 'BRC_COPY_1' || category === 'BRC_COPY_2')) {
      const shipment = db.getShipmentById(shipmentId);
      const brcRecord = shipment?.brcRecord;
      if (brcRecord && brcRecord.uploadMode === 'SINGLE' && category === 'BRC_COPY_2') {
        return res.status(400).json({
          error: 'Single BRC Mode is active for this shipment. Exactly one BRC copy is permitted. Switch to Multiple mode to attach Copy 2.',
        });
      }
    }

    // Server-side storage path per Section 7:
    // storage/FY{year}/{normalized_key}/{filename}
    const safeYearDir = path.resolve(getStorageDir(), `FY${financialYear}`);
    const safeInvoiceDir = path.resolve(safeYearDir, invoiceKey.replace(/[^A-Z0-9\-_]/gi, '_'));
    await fsp.mkdir(safeInvoiceDir, { recursive: true });

    const safeFilename = `${category.toLowerCase()}_${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const storedPath = path.resolve(safeInvoiceDir, safeFilename);

    await fsp.writeFile(storedPath, req.file.buffer);

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
  })
);

apiRouter.get('/documents/:id/download', authenticateDownload, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const doc = db.getDocumentById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const absolutePath = path.resolve(doc.storedPath);
  const storageRoot = getStorageDir();
  const assetsRoot = path.resolve('public/assets');

  // Path containment guard: prevent path traversal attacks
  if (!absolutePath.startsWith(storageRoot) && !absolutePath.startsWith(assetsRoot)) {
    return res.status(403).json({ error: 'Access denied: document path is outside permitted storage boundaries.' });
  }

  try {
    await fsp.access(absolutePath);
  } catch {
    return res.status(404).json({ error: 'Physical document file missing on server.' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.originalFilename)}"`);
  res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
  fs.createReadStream(absolutePath).pipe(res);
}));

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
apiRouter.get('/excel/export', authenticateDownload, asyncHandler((req, res) => {
  const fyId = req.query.financialYearId as string | undefined;
  const buffer = generateExportWorkbook(fyId);
  const fyLabel = fyId ? db.getFinancialYears().find((f) => f.id === fyId)?.label || 'All' : 'All';
  const filename = `SKE_Export_Realisation_Tracker_${fyLabel}_${new Date().toISOString().split('T')[0]}.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
}));

apiRouter.get('/excel/export-csv', authenticateDownload, asyncHandler((req, res) => {
  const sheet = String(req.query.sheet || 'Export Tracker');
  const fyId = req.query.financialYearId as string | undefined;
  const csvContent = generateCsvExport(sheet, fyId);
  const safeSheet = sheet.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const filename = `SKE_${safeSheet}_${new Date().toISOString().split('T')[0]}.csv`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csvContent);
}));

apiRouter.post(
  '/excel/import',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  upload.single('file'),
  asyncHandler((req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an Excel workbook (.xlsx or .xlsm) or CSV file (.csv).' });
    }
    if (!validateDocumentContent(req.file.buffer, req.file.originalname)) {
      return res.status(400).json({ error: `Invalid or corrupted spreadsheet content for "${req.file.originalname}".` });
    }

    const fyId = req.body.financialYearId || db.getCurrentFinancialYear().id;
    try {
      const report = parseHistoricalExcelMigration(req.file.buffer, fyId, req.user!.id);
      res.json(report);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Error parsing Excel/CSV migration file.' });
    }
  })
);

// --- GST Entries ---
apiRouter.get('/gst-entries', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const consigneeId = req.query.consigneeId ? String(req.query.consigneeId) : undefined;
  const result = req.query.result ? (String(req.query.result) as any) : undefined;
  const search = req.query.search ? String(req.query.search) : undefined;
  const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
  const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
  const page = req.query.page ? parseInt(String(req.query.page), 10) : undefined;
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
  const sortBy = req.query.sortBy ? (String(req.query.sortBy) as any) : undefined;
  const sortOrder = req.query.sortOrder ? (String(req.query.sortOrder) as any) : undefined;

  const resultData = db.getGstEntries({
    consigneeId,
    result,
    search,
    startDate,
    endDate,
    page,
    limit,
    sortBy,
    sortOrder,
  });

  res.json(resultData);
});

apiRouter.get('/gst-entries/summary', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const consigneeId = req.query.consigneeId ? String(req.query.consigneeId) : undefined;
  const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
  const endDate = req.query.endDate ? String(req.query.endDate) : undefined;

  const summary = db.getGstSummary({ consigneeId, startDate, endDate });
  res.json(summary);
});

apiRouter.get('/gst-entries/export', authenticateDownload, asyncHandler((req: AuthenticatedRequest, res: Response) => {
  const consigneeId = req.query.consigneeId ? String(req.query.consigneeId) : undefined;
  const result = req.query.result ? (String(req.query.result) as any) : undefined;
  const search = req.query.search ? String(req.query.search) : undefined;
  const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
  const endDate = req.query.endDate ? String(req.query.endDate) : undefined;

  const buffer = generateGstExcelExport({ consigneeId, result, search, startDate, endDate });
  const filename = `SKE_GST_Entries_${new Date().toISOString().split('T')[0]}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}));

apiRouter.get('/gst-entries/:id', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const entry = db.getGstEntryById(req.params.id);
  if (!entry) return res.status(404).json({ error: 'GST entry not found.' });
  res.json(entry);
});

apiRouter.post(
  '/gst-entries',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const { entryDate, consigneeId, igst, cgst, sgst, refundEligible, remarks } = req.body;
      const created = db.createGstEntry({
        entryDate,
        consigneeId,
        igst: Number(igst || 0),
        cgst: Number(cgst || 0),
        sgst: Number(sgst || 0),
        refundEligible: Number(refundEligible || 0),
        remarks,
      });
      res.status(201).json(created);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create GST entry.' });
    }
  }
);

apiRouter.put(
  '/gst-entries/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updateGstEntry(req.params.id, req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update GST entry.' });
    }
  }
);

apiRouter.delete(
  '/gst-entries/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    const success = db.deleteGstEntry(req.params.id);
    if (!success) return res.status(404).json({ error: 'GST entry not found or already deleted.' });
    res.json({ success: true, message: 'GST entry deleted successfully.' });
  }
);

// --- B2B GST Management Module Routes ---

apiRouter.get('/b2b/dashboard', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const financialYear = req.query.financialYear ? String(req.query.financialYear) : undefined;
  const metrics = db.getB2bDashboardMetrics(financialYear);
  res.json(metrics);
});

apiRouter.get('/b2b/monthly', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const financialYear = req.query.financialYear ? String(req.query.financialYear) : undefined;
  const summaries = db.getB2bMonthlySummaries(financialYear);
  res.json(summaries);
});

apiRouter.get('/b2b/monthly/:periodKey', authenticate, (req: AuthenticatedRequest, res: Response) => {
  try {
    const detail = db.getB2bMonthDetail(req.params.periodKey);
    res.json(detail);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to fetch month details.' });
  }
});

apiRouter.get('/b2b/invoices', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const {
    periodKey,
    financialYear,
    supplierGstin,
    invoiceType,
    reverseCharge,
    itcAvailability,
    search,
    page,
    limit,
    sortBy,
    sortOrder,
  } = req.query as any;

  const result = db.getB2bInvoices({
    periodKey,
    financialYear,
    supplierGstin,
    invoiceType,
    reverseCharge,
    itcAvailability,
    search,
    page: page ? parseInt(String(page), 10) : undefined,
    limit: limit !== undefined ? parseInt(String(limit), 10) : 50,
    sortBy,
    sortOrder,
  });

  res.json(result);
});

apiRouter.get('/b2b/invoices/:id', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const invoice = db.getB2bInvoiceById(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'B2B Invoice not found.' });
  res.json(invoice);
});

apiRouter.post(
  '/b2b/invoices',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const created = db.createB2bInvoice(req.body, req.user!.id);
      res.status(201).json(created);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create B2B invoice.' });
    }
  }
);

apiRouter.put(
  '/b2b/invoices/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updateB2bInvoice(req.params.id, req.body, req.user!.id);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update B2B invoice.' });
    }
  }
);

apiRouter.delete(
  '/b2b/invoices/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    const success = db.deleteB2bInvoice(req.params.id);
    if (!success) return res.status(404).json({ error: 'B2B invoice not found or already deleted.' });
    res.json({ success: true, message: 'B2B invoice deleted successfully.' });
  }
);

apiRouter.get('/b2b/suppliers', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const search = req.query.search ? String(req.query.search) : undefined;
  const suppliers = db.getSuppliers(search);
  res.json(suppliers);
});

apiRouter.get('/b2b/suppliers/:id', authenticate, (req: AuthenticatedRequest, res: Response) => {
  const supplier = db.getSupplierById(req.params.id);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found.' });
  res.json(supplier);
});

apiRouter.post(
  '/b2b/suppliers',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const created = db.createSupplier(req.body);
      res.status(201).json(created);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to create supplier.' });
    }
  }
);

apiRouter.put(
  '/b2b/suppliers/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const updated = db.updateSupplier(req.params.id, req.body);
      res.json(updated);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update supplier.' });
    }
  }
);

apiRouter.delete(
  '/b2b/suppliers/:id',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const success = db.deleteSupplier(req.params.id);
      if (!success) return res.status(404).json({ error: 'Supplier not found.' });
      res.json({ success: true, message: 'Supplier deleted successfully.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to delete supplier.' });
    }
  }
);

apiRouter.post(
  '/b2b/import/preview',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  upload.single('file'),
  asyncHandler((req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an Excel workbook (.xlsx, .xls) or CSV file (.csv).' });
    }
    if (!validateDocumentContent(req.file.buffer, req.file.originalname)) {
      return res.status(400).json({ error: `Invalid or corrupted spreadsheet content for "${req.file.originalname}".` });
    }

    try {
      const existingInvoices = db.getB2bInvoices({ limit: 0 }).data;
      const existingSuppliers = db.getSuppliers();
      const preview = previewB2bWorkbook(req.file.buffer, req.file.originalname, existingInvoices, existingSuppliers);
      res.json(preview);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to parse B2B import file.' });
    }
  })
);

apiRouter.post(
  '/b2b/import/commit',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    const { previewData, mode, fileName, fileSizeBytes } = req.body;
    if (!previewData) {
      return res.status(400).json({ error: 'Preview data is required for commit.' });
    }
    const importMode = mode || 'SKIP_EXISTING';

    try {
      const result = db.commitB2bImport(
        { fileName: fileName || 'Imported_Workbook.xlsx', fileSizeBytes },
        previewData,
        importMode,
        req.user!.id
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to commit B2B import.' });
    }
  }
);

apiRouter.get('/b2b/import/batches', authenticate, (req: AuthenticatedRequest, res: Response) => {
  res.json(db.getImportBatches());
});

apiRouter.get('/b2b/export', authenticateDownload, asyncHandler((req: AuthenticatedRequest, res: Response) => {
  const { reportType, periodKey, financialYear, supplierGstin } = req.query as any;

  if (reportType === 'monthly_summary') {
    const fy = financialYear || db.getCurrentFinancialYear().label;
    const summaries = db.getB2bMonthlySummaries(fy);
    const buffer = generateB2bMonthlySummaryExcel(summaries, fy);
    const filename = `SKE_B2B_Monthly_Summary_${fy}_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  }

  // Default: B2B Invoice Register
  const { data: invoices } = db.getB2bInvoices({
    periodKey: periodKey !== 'ALL' ? periodKey : undefined,
    financialYear: financialYear !== 'ALL' ? financialYear : undefined,
    supplierGstin: supplierGstin !== 'ALL' ? supplierGstin : undefined,
    limit: 0,
  });

  const title = periodKey && periodKey !== 'ALL' ? `B2B Invoices - ${periodKey}` : `B2B Invoices - Register`;
  const buffer = generateB2bExcelExport(invoices, title);
  const filename = `SKE_B2B_Register_${periodKey || financialYear || 'All'}_${new Date().toISOString().split('T')[0]}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}));

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

// --- Danger Zone / System Purge (SUPER ADMIN ONLY) ---
apiRouter.post(
  '/system/clear-records',
  authenticate,
  requireRole(['SUPER_ADMIN']),
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
  requireRole(['SUPER_ADMIN']),
  (req: AuthenticatedRequest, res: Response) => {
    const result = db.reseedWithDefaults(req.user!.id);
    res.json(result);
  }
);

// Centralized API Error Handler (Item 8 & Item 18: Sanitized responses + structured error logging)
apiRouter.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const requestId = (req as any).requestId;

  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Uploaded file exceeds maximum allowed size of ${MAX_UPLOAD_SIZE_MB}MB.`
        : `File upload error: ${err.message}`;
    return res.status(status).json({ error: message, requestId });
  }

  if (typeof err?.message === 'string' && err.message.startsWith('Security Policy:')) {
    return res.status(400).json({ error: err.message, requestId });
  }

  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      method: req.method,
      path: req.originalUrl,
      message: err?.message || 'Unhandled API error',
      timestamp: new Date().toISOString(),
    })
  );

  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
  const safeMessage = status < 500 && err?.message ? err.message : 'An unexpected server error occurred.';
  res.status(status).json({ error: safeMessage, requestId });
});

