/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import type { IncentivesService } from './incentives.service.ts';
import { validateCreateIncentivePayload, validateUpdateIncentivePayload } from './incentives.validator.ts';

export class IncentivesController {
  constructor(private readonly service: IncentivesService) {}

  create = async (req: AuthenticatedRequest, res: Response) => {
    const input = validateCreateIncentivePayload(req.body);
    const created = await this.service.create(input);
    res.status(201).json(created);
  };

  update = async (req: AuthenticatedRequest, res: Response) => {
    const updates = validateUpdateIncentivePayload(req.body);
    const updated = await this.service.update(req.params.id, updates);
    res.json(updated);
  };

  remove = async (req: AuthenticatedRequest, res: Response) => {
    const result = await this.service.delete(req.params.id);
    res.json(result);
  };
}
