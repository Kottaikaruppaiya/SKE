/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrcRecord } from '../../../shared/contracts/index.ts';
import type { IBrcRepository, UpdateBrcInput } from './brc.repository.ts';

export class BrcService {
  constructor(private readonly brcRepo: IBrcRepository) {}

  async update(idOrShipmentId: string, updates: UpdateBrcInput): Promise<BrcRecord> {
    return this.brcRepo.update(idOrShipmentId, updates);
  }

  async reset(idOrShipmentId: string): Promise<BrcRecord> {
    return this.brcRepo.reset(idOrShipmentId);
  }
}
