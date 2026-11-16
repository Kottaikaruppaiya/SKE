/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import type { UsersController } from './users.controller.ts';

export function createUsersRouter(
  controller: UsersController,
  authenticate: RequestHandler
): Router {
  const router = Router();
  router.use(authenticate, authorize(['SUPER_ADMIN']));

  router.get('/', asyncHandler(controller.list));
  router.post('/', asyncHandler(controller.create));
  router.put('/:id', asyncHandler(controller.update));
  router.delete('/:id', asyncHandler(controller.remove));

  return router;
}
