/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/authorize.ts';
import type { SettingsService } from './settings.service.ts';
import { validateUpdateSettings } from './settings.validator.ts';

export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  getSettings = async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await this.settingsService.getSettings());
  };

  updateSettings = async (req: AuthenticatedRequest, res: Response) => {
    const updates = validateUpdateSettings(req.body);
    res.json(await this.settingsService.updateSettings(updates));
  };

  clearOperationalData = async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await this.settingsService.clearAllOperationalData());
  };

  reseedDefaults = async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await this.settingsService.reseedWithDefaults());
  };
}
