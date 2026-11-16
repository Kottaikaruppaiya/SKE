/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import type { BrcController } from './brc.controller.ts';

export function createBrcRouter(controller: BrcController, authenticate: RequestHandler): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  router.put('/:id', authenticate, canMutate, asyncHandler(controller.update));
  router.post('/:id/reset', authenticate, canMutate, asyncHandler(controller.reset));

  return router;
}
