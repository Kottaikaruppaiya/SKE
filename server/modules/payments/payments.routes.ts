/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import type { PaymentsController } from './payments.controller.ts';

export function createPaymentsRouter(
  controller: PaymentsController,
  authenticate: RequestHandler
): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  router.get('/payments', authenticate, asyncHandler(controller.list));
  router.get('/payments/:id', authenticate, asyncHandler(controller.getById));
  router.post('/payments', authenticate, canMutate, asyncHandler(controller.create));
  router.put('/payments/:id', authenticate, canMutate, asyncHandler(controller.update));
  router.delete('/payments/:id', authenticate, canMutate, asyncHandler(controller.remove));

  router.post('/allocations', authenticate, canMutate, asyncHandler(controller.allocate));
  router.delete('/allocations/:id', authenticate, canMutate, asyncHandler(controller.deallocate));

  return router;
}
