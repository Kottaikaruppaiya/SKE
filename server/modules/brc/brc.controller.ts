/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import type { BrcService } from './brc.service.ts';
import { validateUpdateBrcPayload } from './brc.validator.ts';

export class BrcController {
  constructor(private readonly service: BrcService) {}

  update = async (req: AuthenticatedRequest, res: Response) => {
    const updates = validateUpdateBrcPayload(req.body);
    const updated = await this.service.update(req.params.id, updates);
    res.json(updated);
  };

  reset = async (req: AuthenticatedRequest, res: Response) => {
    const reset = await this.service.reset(req.params.id);
    res.json(reset);
  };
}
