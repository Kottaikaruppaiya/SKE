/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import { upload } from '../../middleware/upload.ts';
import type { ShipmentsController } from './shipments.controller.ts';

export function createShipmentsRouter(
  controller: ShipmentsController,
  authenticate: RequestHandler
): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  const shipmentUploadFields = upload.fields([
    { name: 'invoiceDoc', maxCount: 1 },
    { name: 'shippingBillDoc', maxCount: 1 },
    { name: 'blDoc', maxCount: 1 },
    { name: 'brcDoc1', maxCount: 1 },
    { name: 'brcDoc2', maxCount: 1 },
    { name: 'fircDoc', maxCount: 1 },
    { name: 'additionalDoc', maxCount: 1 },
  ]);

  router.get('/', authenticate, asyncHandler(controller.list));
  router.get('/lookup', authenticate, asyncHandler(controller.lookup));
  router.get('/check-unique', authenticate, asyncHandler(controller.checkUnique));
  router.post(
    '/create-with-documents',
    authenticate,
    canMutate,
    shipmentUploadFields,
    asyncHandler(controller.createWithDocuments)
  );
  router.post('/', authenticate, canMutate, asyncHandler(controller.create));
  router.get('/:id', authenticate, asyncHandler(controller.getById));
  router.put('/:id', authenticate, canMutate, asyncHandler(controller.update));
  router.delete('/:id', authenticate, canMutate, asyncHandler(controller.remove));
  router.post('/:id/archive', authenticate, canMutate, asyncHandler(controller.archive));
  router.post('/:id/restore', authenticate, canMutate, asyncHandler(controller.restore));

  return router;
}
