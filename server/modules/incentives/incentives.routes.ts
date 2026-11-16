/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import type { IncentivesController } from './incentives.controller.ts';

export function createIncentivesRouter(controller: IncentivesController, authenticate: RequestHandler): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  router.post('/', authenticate, canMutate, asyncHandler(controller.create));
  router.put('/:id', authenticate, canMutate, asyncHandler(controller.update));
  router.delete('/:id', authenticate, canMutate, asyncHandler(controller.remove));

  return router;
}
