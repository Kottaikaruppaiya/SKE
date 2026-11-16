/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PrismaClient } from '@prisma/client';
import type { GstEntry, GstResult, GstSummary } from '../../../shared/contracts/index.ts';
import { calculateGstEntryTotals, summarizeGstEntries } from '../../domain/calculations/gstEntry.calc.ts';
import { NotFoundError, ValidationError } from '../../domain/errors/AppError.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';
import { decimalToNumber, toIsoDate, toIsoTimestamp } from '../../infrastructure/prismaMappers.ts';

export interface GstEntriesFilter {
  consigneeId?: string;
  result?: GstResult;
  search?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
  sortBy?: 'entryDate' | 'consigneeName' | 'totalGst' | 'refundEligible' | 'difference';
  sortOrder?: 'asc' | 'desc';
}

export interface CreateGstEntryInput {
  entryDate: string;
  consigneeId: string;
  igst: number;
  cgst: number;
  sgst: number;
  refundEligible: number;
  remarks?: string;
}

export interface UpdateGstEntryInput {
  entryDate?: string;
  consigneeId?: string;
  igst?: number;
  cgst?: number;
  sgst?: number;
  refundEligible?: number;
  remarks?: string;
}

export interface IGstEntriesRepository {
  findAll(filters?: GstEntriesFilter): Promise<{ entries: GstEntry[]; total: number; summary: GstSummary }>;
  getSummary(filters?: { consigneeId?: string; startDate?: string; endDate?: string }): Promise<GstSummary>;
  findById(id: string): Promise<GstEntry | null>;
  create(input: CreateGstEntryInput): Promise<GstEntry>;
  update(id: string, updates: UpdateGstEntryInput): Promise<GstEntry>;
  delete(id: string): Promise<boolean>;
}

function mapPrismaGstEntry(row: any): GstEntry {
  return {
    id: row.entryNumber || row.id,
    entryDate: toIsoDate(row.entryDate),
    consigneeId: row.consigneeId,
    consigneeName: row.consignee?.name || '',
    igst: decimalToNumber(row.igst),
    cgst: decimalToNumber(row.cgst),
    sgst: decimalToNumber(row.sgst),
    totalGst: decimalToNumber(row.totalGst),
    refundEligible: decimalToNumber(row.refundEligible),
    difference: decimalToNumber(row.difference),
    result: row.result,
    remarks: row.remarks || undefined,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

function filterSortAndPaginateGst(
  rawList: GstEntry[],
  filters?: GstEntriesFilter
): { entries: GstEntry[]; total: number; summary: GstSummary } {
  let list = [...rawList];

  if (filters?.consigneeId && filters.consigneeId !== 'ALL') {
    list = list.filter((e) => e.consigneeId === filters.consigneeId);
  }
  if (filters?.result && filters.result !== ('ALL' as any)) {
    list = list.filter((e) => e.result === filters.result);
  }
  if (filters?.startDate) {
    list = list.filter((e) => e.entryDate >= filters.startDate!);
  }
  if (filters?.endDate) {
    list = list.filter((e) => e.entryDate <= filters.endDate!);
  }
  if (filters?.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase();
    list = list.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.consigneeName.toLowerCase().includes(q) ||
        (e.remarks && e.remarks.toLowerCase().includes(q))
    );
  }

  const summary = summarizeGstEntries(list);

  const sortBy = filters?.sortBy || 'entryDate';
  const sortOrder = filters?.sortOrder || 'desc';
  list.sort((a, b) => {
    let cmp = 0;
    if (sortBy === 'entryDate') cmp = a.entryDate.localeCompare(b.entryDate);
    else if (sortBy === 'consigneeName') cmp = a.consigneeName.localeCompare(b.consigneeName);
    else if (sortBy === 'totalGst') cmp = a.totalGst - b.totalGst;
    else if (sortBy === 'refundEligible') cmp = a.refundEligible - b.refundEligible;
    else if (sortBy === 'difference') cmp = a.difference - b.difference;
    return sortOrder === 'desc' ? -cmp : cmp;
  });

  const total = list.length;
  const page = Math.max(1, filters?.page || 1);
  const limit = filters?.limit ? Math.max(1, filters.limit) : total || 1;
  const startIndex = (page - 1) * limit;
  const entries = list.slice(startIndex, startIndex + limit);

  return { entries, total, summary };
}

export class PrismaGstEntriesRepository implements IGstEntriesRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll(filters?: GstEntriesFilter): Promise<{ entries: GstEntry[]; total: number; summary: GstSummary }> {
    const where: any = {};
    if (filters?.consigneeId && filters.consigneeId !== 'ALL') {
      where.consigneeId = filters.consigneeId;
    }
    if (filters?.result && filters.result !== ('ALL' as any)) {
      where.result = filters.result;
    }
    if (filters?.startDate || filters?.endDate) {
      where.entryDate = {};
      if (filters.startDate) where.entryDate.gte = new Date(filters.startDate);
      if (filters.endDate) where.entryDate.lte = new Date(filters.endDate);
    }

    const rows = await this.prisma.gstEntry.findMany({
      where,
      include: { consignee: { select: { name: true } } },
    });

    return filterSortAndPaginateGst(rows.map(mapPrismaGstEntry), filters);
  }

  async getSummary(filters?: { consigneeId?: string; startDate?: string; endDate?: string }): Promise<GstSummary> {
    const { summary } = await this.findAll(filters);
    return summary;
  }

  async findById(id: string): Promise<GstEntry | null> {
    const row = await this.prisma.gstEntry.findFirst({
      where: { OR: [{ id }, { entryNumber: id }] },
      include: { consignee: { select: { name: true } } },
    });
    return row ? mapPrismaGstEntry(row) : null;
  }

  async create(input: CreateGstEntryInput): Promise<GstEntry> {
    if (!input.entryDate || Number.isNaN(new Date(input.entryDate).getTime())) {
      throw new ValidationError('Valid entry date is required.');
    }

    const consignee = await this.prisma.consigneeMaster.findUnique({ where: { id: input.consigneeId } });
    if (!consignee) {
      throw new ValidationError('Selected consignee does not exist in master records.');
    }

    const calc = calculateGstEntryTotals({
      igst: Number(input.igst || 0),
      cgst: Number(input.cgst || 0),
      sgst: Number(input.sgst || 0),
      refundEligible: Number(input.refundEligible || 0),
    });

    const year = new Date(input.entryDate).getFullYear();
    const prefix = `GST-${year}-`;
    const existingForYear = await this.prisma.gstEntry.findMany({
      where: { entryNumber: { startsWith: prefix } },
      select: { entryNumber: true },
    });
    const maxSeq = existingForYear.reduce((max, row) => {
      const seq = parseInt(row.entryNumber.slice(prefix.length), 10);
      return Number.isFinite(seq) && seq > max ? seq : max;
    }, 0);
    const entryNumber = `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;

    const created = await this.prisma.gstEntry.create({
      data: {
        id: entryNumber,
        entryNumber,
        entryDate: new Date(input.entryDate),
        consigneeId: consignee.id,
        igst: calc.igst,
        cgst: calc.cgst,
        sgst: calc.sgst,
        totalGst: calc.totalGst,
        refundEligible: calc.refundEligible,
        difference: calc.difference,
        result: calc.result,
        remarks: input.remarks?.trim() || null,
      },
      include: { consignee: { select: { name: true } } },
    });

    return mapPrismaGstEntry(created);
  }

  async update(id: string, updates: UpdateGstEntryInput): Promise<GstEntry> {
    const existing = await this.prisma.gstEntry.findFirst({
      where: { OR: [{ id }, { entryNumber: id }] },
    });
    if (!existing) throw new NotFoundError('GST entry not found.');

    if (updates.entryDate !== undefined && (!updates.entryDate || Number.isNaN(new Date(updates.entryDate).getTime()))) {
      throw new ValidationError('Valid entry date is required.');
    }

    let nextConsigneeId = existing.consigneeId;
    if (updates.consigneeId !== undefined) {
      const consignee = await this.prisma.consigneeMaster.findUnique({ where: { id: updates.consigneeId } });
      if (!consignee) throw new ValidationError('Selected consignee does not exist in master records.');
      nextConsigneeId = consignee.id;
    }

    const calc = calculateGstEntryTotals({
      igst: updates.igst !== undefined ? Number(updates.igst) : decimalToNumber(existing.igst),
      cgst: updates.cgst !== undefined ? Number(updates.cgst) : decimalToNumber(existing.cgst),
      sgst: updates.sgst !== undefined ? Number(updates.sgst) : decimalToNumber(existing.sgst),
      refundEligible:
        updates.refundEligible !== undefined
          ? Number(updates.refundEligible)
          : decimalToNumber(existing.refundEligible),
    });

    const updated = await this.prisma.gstEntry.update({
      where: { id: existing.id },
      data: {
        ...(updates.entryDate !== undefined ? { entryDate: new Date(updates.entryDate) } : {}),
        consigneeId: nextConsigneeId,
        igst: calc.igst,
        cgst: calc.cgst,
        sgst: calc.sgst,
        totalGst: calc.totalGst,
        refundEligible: calc.refundEligible,
        difference: calc.difference,
        result: calc.result,
        ...(updates.remarks !== undefined ? { remarks: updates.remarks?.trim() || null } : {}),
      },
      include: { consignee: { select: { name: true } } },
    });

    return mapPrismaGstEntry(updated);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.prisma.gstEntry.findFirst({
      where: { OR: [{ id }, { entryNumber: id }] },
      select: { id: true },
    });
    if (!existing) return false;
    await this.prisma.gstEntry.delete({ where: { id: existing.id } });
    return true;
  }
}

export class JsonGstEntriesRepository implements IGstEntriesRepository {
  async findAll(filters?: GstEntriesFilter): Promise<{ entries: GstEntry[]; total: number; summary: GstSummary }> {
    return filterSortAndPaginateGst(jsonStore.getState().gstEntries || [], filters);
  }

  async getSummary(filters?: { consigneeId?: string; startDate?: string; endDate?: string }): Promise<GstSummary> {
    const { summary } = await this.findAll(filters);
    return summary;
  }

  async findById(id: string): Promise<GstEntry | null> {
    return (jsonStore.getState().gstEntries || []).find((e) => e.id === id) || null;
  }

  async create(input: CreateGstEntryInput): Promise<GstEntry> {
    const state = jsonStore.getState();
    if (!input.entryDate || Number.isNaN(new Date(input.entryDate).getTime())) {
      throw new ValidationError('Valid entry date is required.');
    }

    const consignee = state.consignees.find((c) => c.id === input.consigneeId);
    if (!consignee) {
      throw new ValidationError('Selected consignee does not exist in master records.');
    }

    const calc = calculateGstEntryTotals({
      igst: Number(input.igst || 0),
      cgst: Number(input.cgst || 0),
      sgst: Number(input.sgst || 0),
      refundEligible: Number(input.refundEligible || 0),
    });

    const year = new Date(input.entryDate).getFullYear();
    const prefix = `GST-${year}-`;
    const maxSeq = (state.gstEntries || []).reduce((max, e) => {
      if (!e.id.startsWith(prefix)) return max;
      const seq = parseInt(e.id.slice(prefix.length), 10);
      return Number.isFinite(seq) && seq > max ? seq : max;
    }, 0);
    const readableId = `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
    const now = new Date().toISOString();

    const newEntry: GstEntry = {
      id: readableId,
      entryDate: input.entryDate,
      consigneeId: consignee.id,
      consigneeName: consignee.name,
      igst: calc.igst,
      cgst: calc.cgst,
      sgst: calc.sgst,
      totalGst: calc.totalGst,
      refundEligible: calc.refundEligible,
      difference: calc.difference,
      result: calc.result,
      remarks: input.remarks?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };

    state.gstEntries.unshift(newEntry);
    jsonStore.save();
    return newEntry;
  }

  async update(id: string, updates: UpdateGstEntryInput): Promise<GstEntry> {
    const state = jsonStore.getState();
    const entry = state.gstEntries.find((e) => e.id === id);
    if (!entry) throw new NotFoundError('GST entry not found.');

    if (updates.entryDate !== undefined) {
      if (!updates.entryDate || Number.isNaN(new Date(updates.entryDate).getTime())) {
        throw new ValidationError('Valid entry date is required.');
      }
      entry.entryDate = updates.entryDate;
    }

    if (updates.consigneeId !== undefined) {
      const consignee = state.consignees.find((c) => c.id === updates.consigneeId);
      if (!consignee) throw new ValidationError('Selected consignee does not exist in master records.');
      entry.consigneeId = consignee.id;
      entry.consigneeName = consignee.name;
    }

    const calc = calculateGstEntryTotals({
      igst: updates.igst !== undefined ? Number(updates.igst) : entry.igst,
      cgst: updates.cgst !== undefined ? Number(updates.cgst) : entry.cgst,
      sgst: updates.sgst !== undefined ? Number(updates.sgst) : entry.sgst,
      refundEligible: updates.refundEligible !== undefined ? Number(updates.refundEligible) : entry.refundEligible,
    });

    entry.igst = calc.igst;
    entry.cgst = calc.cgst;
    entry.sgst = calc.sgst;
    entry.totalGst = calc.totalGst;
    entry.refundEligible = calc.refundEligible;
    entry.difference = calc.difference;
    entry.result = calc.result;

    if (updates.remarks !== undefined) {
      entry.remarks = updates.remarks.trim() || undefined;
    }
    entry.updatedAt = new Date().toISOString();

    jsonStore.save();
    return entry;
  }

  async delete(id: string): Promise<boolean> {
    const state = jsonStore.getState();
    const idx = state.gstEntries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    state.gstEntries.splice(idx, 1);
    jsonStore.save();
    return true;
  }
}
