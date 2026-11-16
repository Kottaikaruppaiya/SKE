/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { IncentiveRecord, IncentiveStatus, IncentiveType } from '../../../shared/contracts/index.ts';
import { calculateIncentiveOutstanding, deriveIncentiveStatus } from '../../domain/calculations/incentive.calc.ts';
import { ConflictError, NotFoundError } from '../../domain/errors/AppError.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';
import { decimalToNumber, toDateOrUndefined, toIsoTimestamp } from '../../infrastructure/prismaMappers.ts';

export interface CreateIncentiveInput {
  shipmentId: string;
  type: IncentiveType;
  claimedAmount: number;
  receivedAmount?: number;
  receivedDate?: string;
  scrollNumber?: string;
  remarks?: string;
}

export interface UpdateIncentiveInput {
  claimedAmount?: number;
  receivedAmount?: number;
  receivedDate?: string;
  status?: IncentiveStatus;
  scrollNumber?: string;
  remarks?: string;
}

export interface IIncentivesRepository {
  create(input: CreateIncentiveInput): Promise<IncentiveRecord>;
  update(id: string, updates: UpdateIncentiveInput): Promise<IncentiveRecord>;
  delete(id: string): Promise<{ success: boolean }>;
}

function mapPrismaIncentive(row: any): IncentiveRecord {
  const claimedAmount = decimalToNumber(row.claimedAmount);
  const receivedAmount = decimalToNumber(row.receivedAmount);
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    type: row.type,
    claimedAmount,
    status: row.status,
    receivedAmount,
    receivedDate: toDateOrUndefined(row.receivedDate),
    scrollNumber: row.scrollNumber || undefined,
    remarks: row.remarks || undefined,
    outstandingBalance: calculateIncentiveOutstanding(claimedAmount, receivedAmount),
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

export class PrismaIncentivesRepository implements IIncentivesRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateIncentiveInput): Promise<IncentiveRecord> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: input.shipmentId } });
    if (!shipment) throw new NotFoundError('Shipment not found.');

    const claimed = Number(input.claimedAmount || 0);
    const received = Number(input.receivedAmount || 0);
    const status = deriveIncentiveStatus(claimed, received);

    const created = await this.prisma.incentiveRecord.create({
      data: {
        shipmentId: input.shipmentId,
        type: input.type,
        claimedAmount: claimed,
        receivedAmount: received,
        receivedDate: input.receivedDate ? new Date(input.receivedDate) : null,
        scrollNumber: input.scrollNumber?.trim() || null,
        remarks: input.remarks?.trim() || null,
        status,
      },
    });
    return mapPrismaIncentive(created);
  }

  async update(id: string, updates: UpdateIncentiveInput): Promise<IncentiveRecord> {
    const existing = await this.prisma.incentiveRecord.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Incentive record not found.');

    const nextClaimed =
      updates.claimedAmount !== undefined ? Number(updates.claimedAmount) : decimalToNumber(existing.claimedAmount);
    const nextReceived =
      updates.receivedAmount !== undefined ? Number(updates.receivedAmount) : decimalToNumber(existing.receivedAmount);
    const nextStatus = updates.status ?? deriveIncentiveStatus(nextClaimed, nextReceived);

    const updated = await this.prisma.incentiveRecord.update({
      where: { id },
      data: {
        claimedAmount: nextClaimed,
        receivedAmount: nextReceived,
        status: nextStatus,
        ...(updates.receivedDate !== undefined
          ? { receivedDate: updates.receivedDate ? new Date(updates.receivedDate) : null }
          : {}),
        ...(updates.scrollNumber !== undefined ? { scrollNumber: updates.scrollNumber || null } : {}),
        ...(updates.remarks !== undefined ? { remarks: updates.remarks || null } : {}),
      },
    });
    return mapPrismaIncentive(updated);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    const existing = await this.prisma.incentiveRecord.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Incentive record not found.');

    const received = decimalToNumber(existing.receivedAmount);
    if (received > 0) {
      throw new ConflictError(
        `Cannot delete incentive claim (${existing.type}): Funds of ₹${received.toLocaleString()} have already been credited. Deletion of received incentive funds is prohibited. Please adjust amounts or record a correction instead.`
      );
    }

    await this.prisma.incentiveRecord.delete({ where: { id } });
    return { success: true };
  }
}

export class JsonIncentivesRepository implements IIncentivesRepository {
  async create(input: CreateIncentiveInput): Promise<IncentiveRecord> {
    const state = jsonStore.getState();
    const shipment = state.shipments.find((s) => s.id === input.shipmentId);
    if (!shipment) throw new NotFoundError('Shipment not found.');

    const claimed = Number(input.claimedAmount || 0);
    const received = Number(input.receivedAmount || 0);
    const status = deriveIncentiveStatus(claimed, received);
    const now = new Date().toISOString();

    const record: IncentiveRecord = {
      id: crypto.randomUUID(),
      shipmentId: input.shipmentId,
      type: input.type,
      claimedAmount: claimed,
      receivedAmount: received,
      receivedDate: input.receivedDate,
      scrollNumber: input.scrollNumber?.trim(),
      remarks: input.remarks?.trim(),
      status,
      createdAt: now,
      updatedAt: now,
    };

    state.incentives.push(record);
    jsonStore.save();
    return {
      ...record,
      outstandingBalance: calculateIncentiveOutstanding(record.claimedAmount, record.receivedAmount),
    };
  }

  async update(id: string, updates: UpdateIncentiveInput): Promise<IncentiveRecord> {
    const state = jsonStore.getState();
    const item = state.incentives.find((i) => i.id === id);
    if (!item) throw new NotFoundError('Incentive record not found.');

    if (updates.claimedAmount !== undefined) item.claimedAmount = Number(updates.claimedAmount);
    if (updates.receivedAmount !== undefined) item.receivedAmount = Number(updates.receivedAmount);
    if (updates.receivedDate !== undefined) item.receivedDate = updates.receivedDate;
    if (updates.scrollNumber !== undefined) item.scrollNumber = updates.scrollNumber;
    if (updates.remarks !== undefined) item.remarks = updates.remarks;

    item.status = updates.status ?? deriveIncentiveStatus(item.claimedAmount, item.receivedAmount);
    item.updatedAt = new Date().toISOString();

    jsonStore.save();
    return {
      ...item,
      outstandingBalance: calculateIncentiveOutstanding(item.claimedAmount, item.receivedAmount),
    };
  }

  async delete(id: string): Promise<{ success: boolean }> {
    const state = jsonStore.getState();
    const idx = state.incentives.findIndex((i) => i.id === id);
    if (idx === -1) throw new NotFoundError('Incentive record not found.');

    const item = state.incentives[idx];
    if (Number(item.receivedAmount) > 0) {
      throw new ConflictError(
        `Cannot delete incentive claim (${item.type}): Funds of ₹${Number(item.receivedAmount).toLocaleString()} have already been credited. Deletion of received incentive funds is prohibited. Please adjust amounts or record a correction instead.`
      );
    }

    state.incentives.splice(idx, 1);
    jsonStore.save();
    return { success: true };
  }
}
