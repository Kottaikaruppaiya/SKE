/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { getPrismaClient, isPostgresActive } from './config/database.ts';
import {
  createAuthenticateDownloadMiddleware,
  createAuthenticateMiddleware,
} from './middleware/authenticate.ts';
import { AuthController } from './modules/auth/auth.controller.ts';
import {
  JsonTokenRevocationRepository,
  PrismaTokenRevocationRepository,
} from './modules/auth/auth.repository.ts';
import { AuthService } from './modules/auth/auth.service.ts';
import { B2bGstController } from './modules/b2b-gst/b2bGst.controller.ts';
import { JsonB2bGstRepository, PrismaB2bGstRepository } from './modules/b2b-gst/b2bGst.repository.ts';
import { B2bGstService } from './modules/b2b-gst/b2bGst.service.ts';
import { BrcController } from './modules/brc/brc.controller.ts';
import { JsonBrcRepository, PrismaBrcRepository } from './modules/brc/brc.repository.ts';
import { BrcService } from './modules/brc/brc.service.ts';
import { DocumentsController } from './modules/documents/documents.controller.ts';
import {
  JsonDocumentsRepository,
  PrismaDocumentsRepository,
} from './modules/documents/documents.repository.ts';
import { DocumentsService } from './modules/documents/documents.service.ts';
import { GstEntriesController } from './modules/gst-entries/gstEntries.controller.ts';
import {
  JsonGstEntriesRepository,
  PrismaGstEntriesRepository,
} from './modules/gst-entries/gstEntries.repository.ts';
import { GstEntriesService } from './modules/gst-entries/gstEntries.service.ts';
import { IncentivesController } from './modules/incentives/incentives.controller.ts';
import {
  JsonIncentivesRepository,
  PrismaIncentivesRepository,
} from './modules/incentives/incentives.repository.ts';
import { IncentivesService } from './modules/incentives/incentives.service.ts';
import { MastersController } from './modules/masters/masters.controller.ts';
import { JsonMastersRepository, PrismaMastersRepository } from './modules/masters/masters.repository.ts';
import { MastersService } from './modules/masters/masters.service.ts';
import { OcrController } from './modules/ocr/ocr.controller.ts';
import { JsonOcrRepository, PrismaOcrRepository } from './modules/ocr/ocr.repository.ts';
import { OcrService } from './modules/ocr/ocr.service.ts';
import { OcrQueueWorkerService } from './modules/ocr/ocr.worker.ts';
import { PaymentsController } from './modules/payments/payments.controller.ts';
import { JsonPaymentsRepository, PrismaPaymentsRepository } from './modules/payments/payments.repository.ts';
import { PaymentsService } from './modules/payments/payments.service.ts';
import { ReportsController } from './modules/reports/reports.controller.ts';
import { ReportsService } from './modules/reports/reports.service.ts';
import { SettingsController } from './modules/settings/settings.controller.ts';
import { JsonSettingsRepository, PrismaSettingsRepository } from './modules/settings/settings.repository.ts';
import { SettingsService } from './modules/settings/settings.service.ts';
import { ShipmentsController } from './modules/shipments/shipments.controller.ts';
import {
  JsonShipmentsRepository,
  PrismaShipmentsRepository,
} from './modules/shipments/shipments.repository.ts';
import { ShipmentsService } from './modules/shipments/shipments.service.ts';
import { UsersController } from './modules/users/users.controller.ts';
import { JsonUsersRepository, PrismaUsersRepository } from './modules/users/users.repository.ts';
import { UsersService } from './modules/users/users.service.ts';

export interface AppContainer {
  mode: 'postgresql' | 'json-fallback';
  authController: AuthController;
  usersController: UsersController;
  mastersController: MastersController;
  shipmentsController: ShipmentsController;
  paymentsController: PaymentsController;
  documentsController: DocumentsController;
  ocrController: OcrController;
  ocrWorker: OcrQueueWorkerService;
  brcController: BrcController;
  incentivesController: IncentivesController;
  gstEntriesController: GstEntriesController;
  b2bGstController: B2bGstController;
  reportsController: ReportsController;
  settingsController: SettingsController;
  authenticate: RequestHandler;
  authenticateDownload: RequestHandler;
}

export function createContainer(): AppContainer {
  const usePostgres = isPostgresActive();
  const prisma = usePostgres ? getPrismaClient() : null;

  // 1. Repositories (Dependency Inversion: swap Prisma/PostgreSQL vs JSON fallback cleanly)
  const usersRepo = prisma ? new PrismaUsersRepository(prisma) : new JsonUsersRepository();
  const tokenRepo = prisma ? new PrismaTokenRevocationRepository(prisma) : new JsonTokenRevocationRepository();
  const mastersRepo = prisma ? new PrismaMastersRepository(prisma) : new JsonMastersRepository();
  const shipmentsRepo = prisma ? new PrismaShipmentsRepository(prisma) : new JsonShipmentsRepository();
  const paymentsRepo = prisma ? new PrismaPaymentsRepository(prisma) : new JsonPaymentsRepository();
  const documentsRepo = prisma ? new PrismaDocumentsRepository(prisma) : new JsonDocumentsRepository();
  const ocrRepo = prisma
    ? new PrismaOcrRepository(prisma, shipmentsRepo, paymentsRepo, mastersRepo)
    : new JsonOcrRepository(shipmentsRepo, paymentsRepo, mastersRepo);
  const brcRepo = prisma ? new PrismaBrcRepository(prisma) : new JsonBrcRepository();
  const incentivesRepo = prisma ? new PrismaIncentivesRepository(prisma) : new JsonIncentivesRepository();
  const gstRepo = prisma ? new PrismaGstEntriesRepository(prisma) : new JsonGstEntriesRepository();
  const b2bRepo = prisma ? new PrismaB2bGstRepository(prisma) : new JsonB2bGstRepository();
  const settingsRepo = prisma ? new PrismaSettingsRepository(prisma) : new JsonSettingsRepository();

  // 2. Services & Background Workers
  const usersService = new UsersService(usersRepo, (userId) => tokenRepo.revokeAllForUser(userId));
  const authService = new AuthService(usersRepo, tokenRepo);
  const mastersService = new MastersService(mastersRepo);
  const shipmentsService = new ShipmentsService(shipmentsRepo, mastersRepo);
  const paymentsService = new PaymentsService(paymentsRepo);
  const documentsService = new DocumentsService(documentsRepo, shipmentsRepo, mastersRepo);
  const ocrWorker = new OcrQueueWorkerService(ocrRepo, documentsRepo);
  const ocrService = new OcrService(ocrRepo, mastersRepo, ocrWorker);
  const brcService = new BrcService(brcRepo);
  const incentivesService = new IncentivesService(incentivesRepo);
  const gstService = new GstEntriesService(gstRepo);
  const b2bService = new B2bGstService(b2bRepo, mastersRepo);
  const reportsService = new ReportsService(shipmentsRepo, mastersRepo, paymentsRepo, brcRepo, gstRepo);
  const settingsService = new SettingsService(settingsRepo);

  // 3. Auth Middlewares
  const authenticate = createAuthenticateMiddleware(authService);
  const authenticateDownload = createAuthenticateDownloadMiddleware(authService);

  // 4. Controllers
  return {
    mode: usePostgres ? 'postgresql' : 'json-fallback',
    authController: new AuthController(authService),
    usersController: new UsersController(usersService),
    mastersController: new MastersController(mastersService),
    shipmentsController: new ShipmentsController(shipmentsService),
    paymentsController: new PaymentsController(paymentsService),
    documentsController: new DocumentsController(documentsService),
    ocrController: new OcrController(ocrService),
    ocrWorker,
    brcController: new BrcController(brcService),
    incentivesController: new IncentivesController(incentivesService),
    gstEntriesController: new GstEntriesController(gstService),
    b2bGstController: new B2bGstController(b2bService),
    reportsController: new ReportsController(reportsService),
    settingsController: new SettingsController(settingsService),
    authenticate,
    authenticateDownload,
  };
}
