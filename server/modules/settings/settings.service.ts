/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AppSettings } from '../../../shared/contracts/index.ts';
import type { ISettingsRepository } from './settings.repository.ts';

export class SettingsService {
  constructor(private readonly settingsRepo: ISettingsRepository) {}

  getSettings(): Promise<AppSettings> {
    return this.settingsRepo.getSettings();
  }

  updateSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
    return this.settingsRepo.updateSettings(updates);
  }

  clearAllOperationalData() {
    return this.settingsRepo.clearAllOperationalData();
  }

  reseedWithDefaults() {
    return this.settingsRepo.reseedWithDefaults();
  }
}
