/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GstEntry, GstSummary } from '../../../shared/contracts/index.ts';
import { NotFoundError } from '../../domain/errors/AppError.ts';
import { buildGstWorkbookBuffer } from '../../excel.ts';
import type {
  CreateGstEntryInput,
  GstEntriesFilter,
  IGstEntriesRepository,
  UpdateGstEntryInput,
} from './gstEntries.repository.ts';

export class GstEntriesService {
  constructor(private readonly gstRepo: IGstEntriesRepository) {}

  async list(filters?: GstEntriesFilter): Promise<{ entries: GstEntry[]; total: number; summary: GstSummary }> {
    return this.gstRepo.findAll(filters);
  }

  async getSummary(filters?: { consigneeId?: string; startDate?: string; endDate?: string }): Promise<GstSummary> {
    return this.gstRepo.getSummary(filters);
  }

  async getById(id: string): Promise<GstEntry> {
    const entry = await this.gstRepo.findById(id);
    if (!entry) throw new NotFoundError('GST entry not found.');
    return entry;
  }

  async create(input: CreateGstEntryInput): Promise<GstEntry> {
    return this.gstRepo.create(input);
  }

  async update(id: string, updates: UpdateGstEntryInput): Promise<GstEntry> {
    return this.gstRepo.update(id, updates);
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.gstRepo.delete(id);
    if (!deleted) throw new NotFoundError('GST entry not found or already deleted.');
    return true;
  }

  async exportExcel(filters?: GstEntriesFilter): Promise<Buffer> {
    const { entries, summary } = await this.gstRepo.findAll({ ...filters, limit: 10000 });
    return buildGstWorkbookBuffer(entries, summary);
  }
}
