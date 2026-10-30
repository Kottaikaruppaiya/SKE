/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { db } from './db.ts';
import { authenticate, requireRole, generateToken, AuthenticatedRequest } from './auth.ts';
import { extractDocumentData } from './extractor.ts';
import { generateExportWorkbook, parseHistoricalExcelMigration } from './excel.ts';
import { normalizeInvoiceKey } from './normalizer.ts';
import { DocumentCategory } from '../src/types/index.ts';

export const apiRouter = express.Router();

// Configure Multer for secure private file storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
});

// --- Auth Routes ---
apiRouter.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const userWithHash = db.getUserByEmail(email);
  if (!userWithHash || !userWithHash.isActive) {
    return res.status(401).json({ error: 'Invalid credentials or inactive account.' });
  }

  // Check password if provided, or allow demo login if matches standard demo pass
  if (password && !db.verifyPassword(password, (userWithHash as any).passwordHash)) {
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

apiRouter.post('/auth/switch-role', (req: AuthenticatedRequest, res) => {
  const { role } = req.body;
  if (!['SUPER_ADMIN', 'ADMIN', 'VIEWER'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  const user = db.getUsers().find((u) => u.role === role);
  if (!user) return res.status(404).json({ error: 'User for this role not found.' });

  const token = generateToken(user);
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
  if (!q) return res.json([]);

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
        consigneeId,
        portCode = 'INNSA1',
        packageCount,
        invoiceDate,
        invoiceValueUsd,
        shippingBillNumber,
        shippingBillDate,
        sbExchangeRate = 84.5,
        fobValueInr,
        blNumber,
        blDate,
        vesselName,
      } = req.body;

      if (!invoiceNumber || !invoiceNumber.trim()) {
        return res.status(400).json({ error: 'Invoice Number is required and must be unique.' });
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

      let extractedInvValue = invoiceValueUsd ? Number(invoiceValueUsd) : undefined;
      let extractedInvDate = invoiceDate || undefined;
      let extractedSbNo = shippingBillNumber || undefined;
      let extractedSbDate = shippingBillDate || undefined;
      let extractedExchangeRate = sbExchangeRate ? Number(sbExchangeRate) : 84.5;
      let extractedFobInr = fobValueInr ? Number(fobValueInr) : undefined;
      let extractedPackages = packageCount ? Number(packageCount) : undefined;

      const extractions: Record<string, any> = {};

      if (files?.invoiceDoc?.[0]) {
        try {
          const invExt = await extractDocumentData(
            files.invoiceDoc[0].buffer,
            'COMMERCIAL_INVOICE',
            files.invoiceDoc[0].originalname
          );
          extractions.invoiceDoc = invExt;
          if (invExt?.fields?.invoiceValueUsd?.value && !extractedInvValue) {
            extractedInvValue = Number(invExt.fields.invoiceValueUsd.value);
          }
          if (invExt?.fields?.invoiceDate?.value && !extractedInvDate) {
            extractedInvDate = String(invExt.fields.invoiceDate.value);
          }
          if (invExt?.fields?.packageCount?.value && !extractedPackages) {
            extractedPackages = Number(invExt.fields.packageCount.value);
          }
        } catch (e) {
          console.warn('Invoice extraction warning:', e);
        }
      }

      if (files?.shippingBillDoc?.[0]) {
        try {
          const sbExt = await extractDocumentData(
            files.shippingBillDoc[0].buffer,
            'SHIPPING_BILL',
            files.shippingBillDoc[0].originalname
          );
          extractions.shippingBillDoc = sbExt;
          if (sbExt?.fields?.shippingBillNumber?.value && !extractedSbNo) {
            extractedSbNo = String(sbExt.fields.shippingBillNumber.value);
          }
          if (sbExt?.fields?.shippingBillDate?.value && !extractedSbDate) {
            extractedSbDate = String(sbExt.fields.shippingBillDate.value);
          }
          if (sbExt?.fields?.sbExchangeRate?.value && !extractedExchangeRate) {
            extractedExchangeRate = Number(sbExt.fields.sbExchangeRate.value);
          }
          if (sbExt?.fields?.fobValueInr?.value && !extractedFobInr) {
            extractedFobInr = Number(sbExt.fields.fobValueInr.value);
          }
        } catch (e) {
          console.warn('SB extraction warning:', e);
        }
      }

      const invVal = Number(extractedInvValue || 0);
      const exRate = Number(extractedExchangeRate || 84.5);
      const fobVal = Number(extractedFobInr || Math.round(invVal * exRate * 100) / 100);

      const hasFircUploaded = Boolean(files?.fircDoc?.[0]);

      // Create shipment in DB
      const shipment = db.createShipment(
        {
          financialYearId,
          invoiceNumber: invoiceNumber.trim(),
          invoiceDate: extractedInvDate || new Date().toISOString().split('T')[0],
          consigneeId: consigneeId || undefined,
          portCode: portCode || 'INNSA1',
          packageCount: extractedPackages || 0,
          invoiceValueUsd: invVal,
          shippingBillNumber: extractedSbNo?.trim() || 'PENDING',
          shippingBillDate: extractedSbDate || new Date().toISOString().split('T')[0],
          sbExchangeRate: exRate,
          fobValueInr: fobVal,
          blNumber: blNumber?.trim() || undefined,
          blDate: blDate || undefined,
          vesselName: vesselName?.trim() || undefined,
          remarks: remarks?.trim() || undefined,
          initialFircDocumentUploaded: hasFircUploaded,
          brc: {
            uploadMode: (brcUploadMode === 'MULTIPLE' ? 'MULTIPLE' : 'SINGLE') as 'SINGLE' | 'MULTIPLE',
            remarks: remarks?.trim(),
          },
        },
        req.user!.id
      );

      const normalizedKey = shipment.normalizedInvoiceKey;
      const fyLabel = db.getFinancialYears().find((f) => f.id === financialYearId)?.label || '2026-27';

      // Directory path: storage/FY{year}/{normalized_key}
      const safeYearDir = path.resolve('storage', `FY${fyLabel}`);
      const safeInvoiceDir = path.resolve(safeYearDir, normalizedKey.replace(/[^A-Z0-9\-_]/gi, '_'));
      if (!fs.existsSync(safeInvoiceDir)) fs.mkdirSync(safeInvoiceDir, { recursive: true });

      // Save each uploaded file
      const fileSpecs: { file?: Express.Multer.File; category: DocumentCategory; extractionKey?: string }[] = [
        { file: files?.invoiceDoc?.[0], category: 'COMMERCIAL_INVOICE', extractionKey: 'invoiceDoc' },
        { file: files?.shippingBillDoc?.[0], category: 'SHIPPING_BILL', extractionKey: 'shippingBillDoc' },
        { file: files?.blDoc?.[0], category: 'BILL_OF_LADING' },
        { file: files?.brcDoc1?.[0], category: 'BRC_COPY_1' },
        { file: files?.brcDoc2?.[0], category: 'BRC_COPY_2' },
        { file: files?.fircDoc?.[0], category: 'FIRC_PAYMENT' },
        { file: files?.additionalDoc?.[0], category: 'ADDITIONAL_DOC' },
      ];

      for (const spec of fileSpecs) {
        if (!spec.file) continue;
        const safeFilename = `${spec.category.toLowerCase()}_${Date.now()}_${spec.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
        const storedPath = path.resolve(safeInvoiceDir, safeFilename);
        fs.writeFileSync(storedPath, spec.file.buffer);

        let ext = spec.extractionKey ? extractions[spec.extractionKey] : null;
        if (!ext && (spec.category === 'FIRC_PAYMENT' || spec.category === 'BILL_OF_LADING')) {
          try {
            ext = await extractDocumentData(spec.file.buffer, spec.category, spec.file.originalname);
          } catch (e) {
            // ignore
          }
        }

        db.registerDocument(
          {
            shipmentId: shipment.id,
            category: spec.category,
            originalFilename: spec.file.originalname,
            storedPath: path.relative(process.cwd(), storedPath),
            mimeType: spec.file.mimetype,
            fileSizeBytes: spec.file.size,
            extractedData: ext,
            reviewStatus: ext?.reviewStatus || 'EXTRACTED',
          },
          req.user!.id
        );
      }

      // Re-hydrate shipment to return with documents
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
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ error: 'Physical document file missing on server.' });
  }

  db.logAudit({
    userId: req.user!.id,
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

// --- Excel Import & Export ---
apiRouter.get('/excel/export', authenticate, (req, res) => {
  const fyId = req.query.financialYearId as string | undefined;
  const buffer = generateExportWorkbook(fyId);
  const fyLabel = fyId ? db.getFinancialYears().find((f) => f.id === fyId)?.label || 'All' : 'All';
  const filename = `SKE_Export_Realisation_Tracker_${fyLabel}_${new Date().toISOString().split('T')[0]}.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

apiRouter.post(
  '/excel/import',
  authenticate,
  requireRole(['SUPER_ADMIN', 'ADMIN']),
  upload.single('file'),
  (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an Excel workbook (.xlsx or .xlsm).' });
    }

    const fyId = req.body.financialYearId || db.getCurrentFinancialYear().id;
    try {
      const report = parseHistoricalExcelMigration(req.file.buffer, fyId, req.user!.id);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Error parsing Excel migration file.' });
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
