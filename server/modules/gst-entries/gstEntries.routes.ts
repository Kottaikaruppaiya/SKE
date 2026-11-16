/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import type { GstEntriesController } from './gstEntries.controller.ts';

export function createGstEntriesRouter(
  controller: GstEntriesController,
  authenticate: RequestHandler,
  authenticateDownload: RequestHandler
): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  router.get('/', authenticate, asyncHandler(controller.list));
  router.get('/summary', authenticate, asyncHandler(controller.summary));
  router.get('/export', authenticateDownload, asyncHandler(controller.exportExcel));
  router.get('/:id', authenticate, asyncHandler(controller.getById));
  router.post('/', authenticate, canMutate, asyncHandler(controller.create));
  router.put('/:id', authenticate, canMutate, asyncHandler(controller.update));
  router.delete('/:id', authenticate, canMutate, asyncHandler(controller.remove));

  return router;
}
