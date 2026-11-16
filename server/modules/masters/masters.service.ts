/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BankMaster, ConsigneeMaster, FinancialYear } from '../../../shared/contracts/index.ts';
import type { IMastersRepository } from './masters.repository.ts';

export class MastersService {
  constructor(private readonly mastersRepo: IMastersRepository) {}

  async listFinancialYears(): Promise<FinancialYear[]> {
    return this.mastersRepo.findFinancialYears();
  }

  async getCurrentFinancialYear(): Promise<FinancialYear> {
    return this.mastersRepo.findCurrentFinancialYear();
  }

  async listConsignees(): Promise<ConsigneeMaster[]> {
    return this.mastersRepo.findConsignees();
  }

  async createConsignee(data: Omit<ConsigneeMaster, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConsigneeMaster> {
    return this.mastersRepo.createConsignee(data);
  }

  async updateConsignee(id: string, updates: Partial<ConsigneeMaster>): Promise<ConsigneeMaster> {
    return this.mastersRepo.updateConsignee(id, updates);
  }

  async deleteConsignee(id: string): Promise<{ success: boolean }> {
    return this.mastersRepo.deleteConsignee(id);
  }

  async listBanks(): Promise<BankMaster[]> {
    return this.mastersRepo.findBanks();
  }

  async createBank(data: Omit<BankMaster, 'id' | 'createdAt' | 'updatedAt'>): Promise<BankMaster> {
    return this.mastersRepo.createBank(data);
  }

  async updateBank(id: string, updates: Partial<BankMaster>): Promise<BankMaster> {
    return this.mastersRepo.updateBank(id, updates);
  }

  async deleteBank(id: string): Promise<{ success: boolean }> {
    return this.mastersRepo.deleteBank(id);
  }
}
