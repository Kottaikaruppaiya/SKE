/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import type { PaymentsService } from './payments.service.ts';
import { validateAllocatePayment, validateCreatePayment } from './payments.validator.ts';

export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  list = async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await this.paymentsService.listPayments());
  };

  getById = async (req: AuthenticatedRequest, res: Response) => {
    res.json(await this.paymentsService.getPaymentById(req.params.id));
  };

  create = async (req: AuthenticatedRequest, res: Response) => {
    const data = validateCreatePayment(req.body);
    const created = await this.paymentsService.createPayment(data);
    res.status(201).json(created);
  };

  update = async (req: AuthenticatedRequest, res: Response) => {
    const updated = await this.paymentsService.updatePayment(req.params.id, req.body || {});
    res.json(updated);
  };

  remove = async (req: AuthenticatedRequest, res: Response) => {
    res.json(await this.paymentsService.deletePayment(req.params.id));
  };

  allocate = async (req: AuthenticatedRequest, res: Response) => {
    const data = validateAllocatePayment(req.body);
    const allocation = await this.paymentsService.allocatePayment(data, req.user!.id);
    res.status(201).json(allocation);
  };

  deallocate = async (req: AuthenticatedRequest, res: Response) => {
    res.json(await this.paymentsService.deallocatePayment(req.params.id));
  };
}
