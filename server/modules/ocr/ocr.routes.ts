/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import { upload } from '../../middleware/upload.ts';
import type { OcrController } from './ocr.controller.ts';

export function createOcrRouter(controller: OcrController, authenticate: RequestHandler): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  router.get('/jobs', authenticate, asyncHandler(controller.listJobs));
  router.get('/jobs/:id', authenticate, asyncHandler(controller.getJob));
  router.post('/jobs', authenticate, canMutate, upload.single('file'), asyncHandler(controller.enqueue));
  router.post('/jobs/:id/retry', authenticate, canMutate, asyncHandler(controller.retry));
  router.delete('/jobs/:id', authenticate, canMutate, asyncHandler(controller.remove));
  router.post('/jobs/:id/approve', authenticate, canMutate, asyncHandler(controller.approve));

  return router;
}
