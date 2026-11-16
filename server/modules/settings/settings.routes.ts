/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import type { SettingsController } from './settings.controller.ts';

export function createSettingsRouter(controller: SettingsController, authenticate: RequestHandler): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  router.get('/', authenticate, asyncHandler(controller.getSettings));
  router.put('/', authenticate, canMutate, asyncHandler(controller.updateSettings));

  return router;
}

export function createSystemRouter(controller: SettingsController, authenticate: RequestHandler): Router {
  const router = Router();
  const superAdminOnly = authorize(['SUPER_ADMIN']);

  router.post('/clear-records', authenticate, superAdminOnly, asyncHandler(controller.clearOperationalData));
  router.post('/reseed', authenticate, superAdminOnly, asyncHandler(controller.reseedDefaults));

  return router;
}
