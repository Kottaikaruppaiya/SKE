/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import type { AppContainer } from '../container.ts';
import { asyncHandler } from '../middleware/errorHandler.ts';
import { createAuthRouter } from '../modules/auth/auth.routes.ts';
import { createB2bGstRouter } from '../modules/b2b-gst/b2bGst.routes.ts';
import { createBrcRouter } from '../modules/brc/brc.routes.ts';
import { createDocumentsRouter } from '../modules/documents/documents.routes.ts';
import { createGstEntriesRouter } from '../modules/gst-entries/gstEntries.routes.ts';
import { createIncentivesRouter } from '../modules/incentives/incentives.routes.ts';
import { createMastersRouter } from '../modules/masters/masters.routes.ts';
import { createOcrRouter } from '../modules/ocr/ocr.routes.ts';
import { createPaymentsRouter } from '../modules/payments/payments.routes.ts';
import { createExcelReportsRouter } from '../modules/reports/reports.routes.ts';
import { createSettingsRouter, createSystemRouter } from '../modules/settings/settings.routes.ts';
import { createShipmentsRouter } from '../modules/shipments/shipments.routes.ts';
import { createUsersRouter } from '../modules/users/users.routes.ts';

export function createApiRouter(container: AppContainer): Router {
  const router = Router();

  router.use('/auth', createAuthRouter(container.authController, container.authenticate));
  router.use('/', createMastersRouter(container.mastersController, container.authenticate));
  router.get('/dashboard', container.authenticate, asyncHandler(container.reportsController.dashboard));
  router.use('/shipments', createShipmentsRouter(container.shipmentsController, container.authenticate));
  router.use('/', createPaymentsRouter(container.paymentsController, container.authenticate));
  router.use(
    '/documents',
    createDocumentsRouter(container.documentsController, container.authenticate, container.authenticateDownload)
  );
  router.use('/ocr', createOcrRouter(container.ocrController, container.authenticate));
  router.use('/brc', createBrcRouter(container.brcController, container.authenticate));
  router.use('/incentives', createIncentivesRouter(container.incentivesController, container.authenticate));
  router.use(
    '/gst-entries',
    createGstEntriesRouter(container.gstEntriesController, container.authenticate, container.authenticateDownload)
  );
  router.use(
    '/b2b',
    createB2bGstRouter(container.b2bGstController, container.authenticate, container.authenticateDownload)
  );
  router.use(
    '/excel',
    createExcelReportsRouter(container.reportsController, container.authenticate, container.authenticateDownload)
  );
  router.use('/users', createUsersRouter(container.usersController, container.authenticate));
  router.use('/settings', createSettingsRouter(container.settingsController, container.authenticate));
  router.use('/system', createSystemRouter(container.settingsController, container.authenticate));

  return router;
}
