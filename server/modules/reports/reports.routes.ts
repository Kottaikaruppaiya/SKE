/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, type RequestHandler } from 'express';
import { authorize } from '../../middleware/authorize.ts';
import { asyncHandler } from '../../middleware/errorHandler.ts';
import { upload } from '../../middleware/upload.ts';
import type { ReportsController } from './reports.controller.ts';

export function createExcelReportsRouter(
  controller: ReportsController,
  authenticate: RequestHandler,
  authenticateDownload: RequestHandler
): Router {
  const router = Router();
  const canMutate = authorize(['SUPER_ADMIN', 'ADMIN']);

  router.get('/export', authenticateDownload, asyncHandler(controller.exportExcel));
  router.get('/export-csv', authenticateDownload, asyncHandler(controller.exportCsv));
  router.post('/import', authenticate, canMutate, upload.single('file'), asyncHandler(controller.importExcel));

  return router;
}
