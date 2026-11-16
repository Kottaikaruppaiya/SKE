/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import type { AuthController } from './auth.controller.ts';

export function createAuthRouter(
  controller: AuthController,
  authenticate: RequestHandler
): Router {
  const router = Router();

  router.post('/login', asyncHandler(controller.login));
  router.post('/change-password', authenticate, asyncHandler(controller.changePassword));
  router.get('/download-ticket', authenticate, asyncHandler(controller.getDownloadTicket));
  router.post('/logout', authenticate, asyncHandler(controller.logout));
  router.get('/me', authenticate, asyncHandler(controller.me));

  return router;
}
