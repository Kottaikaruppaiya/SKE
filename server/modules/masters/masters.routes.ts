/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import type { MastersController } from './masters.controller.ts';

export function createMastersRouter(
  controller: MastersController,
  authenticate: RequestHandler
): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  router.get('/financial-years', authenticate, asyncHandler(controller.listFinancialYears));

  router.get('/masters/consignees', authenticate, asyncHandler(controller.listConsignees));
  router.post('/masters/consignees', authenticate, canMutate, asyncHandler(controller.createConsignee));
  router.put('/masters/consignees/:id', authenticate, canMutate, asyncHandler(controller.updateConsignee));
  router.delete('/masters/consignees/:id', authenticate, canMutate, asyncHandler(controller.deleteConsignee));

  router.get('/masters/banks', authenticate, asyncHandler(controller.listBanks));
  router.post('/masters/banks', authenticate, canMutate, asyncHandler(controller.createBank));
  router.put('/masters/banks/:id', authenticate, canMutate, asyncHandler(controller.updateBank));
  router.delete('/masters/banks/:id', authenticate, canMutate, asyncHandler(controller.deleteBank));

  return router;
}
