/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncentiveRecord } from '../../../shared/contracts/index.ts';
import type {
  CreateIncentiveInput,
  IIncentivesRepository,
  UpdateIncentiveInput,
} from './incentives.repository.ts';

export class IncentivesService {
  constructor(private readonly incentivesRepo: IIncentivesRepository) {}

  async create(input: CreateIncentiveInput): Promise<IncentiveRecord> {
    return this.incentivesRepo.create(input);
  }

  async update(id: string, updates: UpdateIncentiveInput): Promise<IncentiveRecord> {
    return this.incentivesRepo.update(id, updates);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    return this.incentivesRepo.delete(id);
  }
}
