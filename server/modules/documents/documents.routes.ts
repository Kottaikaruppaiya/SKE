/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import { upload } from '../../middleware/upload.ts';
import type { DocumentsController } from './documents.controller.ts';

export function createDocumentsRouter(
  controller: DocumentsController,
  authenticate: RequestHandler,
  authenticateDownload: RequestHandler
): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  const batchFields = upload.fields([
    { name: 'invoiceDoc', maxCount: 1 },
    { name: 'shippingBillDoc', maxCount: 1 },
    { name: 'blDoc', maxCount: 1 },
    { name: 'brcDoc1', maxCount: 1 },
    { name: 'brcDoc2', maxCount: 1 },
    { name: 'fircDoc', maxCount: 1 },
    { name: 'additionalDoc', maxCount: 1 },
  ]);

  router.get('/', authenticate, asyncHandler(controller.list));
  router.post('/extract-batch', authenticate, batchFields, asyncHandler(controller.extractBatch));
  router.post('/upload', authenticate, canMutate, upload.single('file'), asyncHandler(controller.upload));
  router.get('/:id/download', authenticateDownload, asyncHandler(controller.download));
  router.put('/:id/review', authenticate, canMutate, asyncHandler(controller.updateReviewStatus));
  router.delete('/:id', authenticate, canMutate, asyncHandler(controller.remove));

  return router;
}
