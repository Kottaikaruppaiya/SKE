/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import type { MastersService } from './masters.service.ts';
import {
  validateCreateBank,
  validateCreateConsignee,
  validateUpdateBank,
  validateUpdateConsignee,
} from './masters.validator.ts';

export class MastersController {
  constructor(private readonly mastersService: MastersService) {}

  listFinancialYears = async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await this.mastersService.listFinancialYears());
  };

  listConsignees = async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await this.mastersService.listConsignees());
  };

  createConsignee = async (req: AuthenticatedRequest, res: Response) => {
    const data = validateCreateConsignee(req.body);
    const created = await this.mastersService.createConsignee(data);
    res.status(201).json(created);
  };

  updateConsignee = async (req: AuthenticatedRequest, res: Response) => {
    const updates = validateUpdateConsignee(req.body);
    const updated = await this.mastersService.updateConsignee(req.params.id, updates);
    res.json(updated);
  };

  deleteConsignee = async (req: AuthenticatedRequest, res: Response) => {
    res.json(await this.mastersService.deleteConsignee(req.params.id));
  };

  listBanks = async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await this.mastersService.listBanks());
  };

  createBank = async (req: AuthenticatedRequest, res: Response) => {
    const data = validateCreateBank(req.body);
    const created = await this.mastersService.createBank(data);
    res.status(201).json(created);
  };

  updateBank = async (req: AuthenticatedRequest, res: Response) => {
    const updates = validateUpdateBank(req.body);
    const updated = await this.mastersService.updateBank(req.params.id, updates);
    res.json(updated);
  };

  deleteBank = async (req: AuthenticatedRequest, res: Response) => {
    res.json(await this.mastersService.deleteBank(req.params.id));
  };
}
