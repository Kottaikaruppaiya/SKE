/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import { upload } from '../../middleware/upload.ts';
import type { B2bGstController } from './b2bGst.controller.ts';

export function createB2bGstRouter(
  controller: B2bGstController,
  authenticate: RequestHandler,
  authenticateDownload: RequestHandler
): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  router.get('/dashboard', authenticate, asyncHandler(controller.dashboard));
  router.get('/monthly', authenticate, asyncHandler(controller.monthly));
  router.get('/monthly/:periodKey', authenticate, asyncHandler(controller.monthDetail));

  router.get('/invoices', authenticate, asyncHandler(controller.listInvoices));
  router.get('/invoices/:id', authenticate, asyncHandler(controller.getInvoice));
  router.post('/invoices', authenticate, canMutate, asyncHandler(controller.createInvoice));
  router.put('/invoices/:id', authenticate, canMutate, asyncHandler(controller.updateInvoice));
  router.delete('/invoices/:id', authenticate, canMutate, asyncHandler(controller.deleteInvoice));

  router.get('/suppliers', authenticate, asyncHandler(controller.listSuppliers));
  router.get('/suppliers/:id', authenticate, asyncHandler(controller.getSupplier));
  router.post('/suppliers', authenticate, canMutate, asyncHandler(controller.createSupplier));
  router.put('/suppliers/:id', authenticate, canMutate, asyncHandler(controller.updateSupplier));
  router.delete('/suppliers/:id', authenticate, canMutate, asyncHandler(controller.deleteSupplier));

  router.post('/import/preview', authenticate, canMutate, upload.single('file'), asyncHandler(controller.previewImport));
  router.post('/import/commit', authenticate, canMutate, asyncHandler(controller.commitImport));
  router.get('/import/batches', authenticate, asyncHandler(controller.listBatches));
  router.get('/export', authenticateDownload, asyncHandler(controller.exportExcel));

  return router;
}
