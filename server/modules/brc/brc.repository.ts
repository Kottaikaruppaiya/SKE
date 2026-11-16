/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { BrcRecord, BrcStatus } from '../../../shared/contracts/index.ts';
import { isBrcOverdue } from '../../domain/calculations/brc.calc.ts';
import { NotFoundError } from '../../domain/errors/AppError.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';
import { decimalToNumber, toDateOrUndefined, toIsoTimestamp } from '../../infrastructure/prismaMappers.ts';

export interface UpdateBrcInput {
  brcNumber?: string;
  issueDate?: string;
  realisationDate?: string;
  realisedAmount?: number;
  realisedCurrency?: string;
  uploadMode?: 'SINGLE' | 'MULTIPLE';
  statutoryDeadline?: string;
  status?: BrcStatus;
  remarks?: string;
}

export interface IBrcRepository {
  update(idOrShipmentId: string, updates: UpdateBrcInput): Promise<BrcRecord>;
  reset(idOrShipmentId: string): Promise<BrcRecord>;
}

function mapPrismaBrc(row: any): BrcRecord {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    brcNumber: row.brcNumber || undefined,
    issueDate: toDateOrUndefined(row.issueDate),
    realisationDate: toDateOrUndefined(row.realisationDate),
    realisedAmount:
      row.realisedAmount !== null && row.realisedAmount !== undefined
        ? decimalToNumber(row.realisedAmount)
        : undefined,
    realisedCurrency: row.realisedCurrency || undefined,
    uploadMode: row.uploadMode,
    statutoryDeadline: toDateOrUndefined(row.statutoryDeadline),
    status: row.status,
    remarks: row.remarks || undefined,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

export class PrismaBrcRepository implements IBrcRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async update(idOrShipmentId: string, updates: UpdateBrcInput): Promise<BrcRecord> {
    const existing = await this.prisma.brcRecord.findFirst({
      where: {
        OR: [{ id: idOrShipmentId }, { shipmentId: idOrShipmentId }],
      },
    });

    if (!existing) {
      const deadline = updates.statutoryDeadline ? new Date(updates.statutoryDeadline) : null;
      const initialStatus: BrcStatus = updates.status || 'PENDING';
      const resolvedStatus = isBrcOverdue({
        status: initialStatus,
        statutoryDeadline: updates.statutoryDeadline,
      })
        ? 'OVERDUE'
        : initialStatus;

      const created = await this.prisma.brcRecord.create({
        data: {
          shipmentId: idOrShipmentId,
          brcNumber: updates.brcNumber?.trim() || null,
          issueDate: updates.issueDate ? new Date(updates.issueDate) : null,
          realisationDate: updates.realisationDate ? new Date(updates.realisationDate) : null,
          realisedAmount: updates.realisedAmount !== undefined ? Number(updates.realisedAmount) : null,
          realisedCurrency: updates.realisedCurrency || 'USD',
          uploadMode: updates.uploadMode || 'SINGLE',
          statutoryDeadline: deadline,
          status: resolvedStatus,
          remarks: updates.remarks || null,
        },
      });
      return mapPrismaBrc(created);
    }

    const nextStatus = updates.status ?? existing.status;
    const nextDeadlineStr =
      updates.statutoryDeadline !== undefined
        ? updates.statutoryDeadline
        : toDateOrUndefined(existing.statutoryDeadline);

    const finalStatus: BrcStatus = isBrcOverdue({
      status: nextStatus,
      statutoryDeadline: nextDeadlineStr,
      brcNumber: updates.brcNumber !== undefined ? updates.brcNumber : existing.brcNumber || undefined,
    })
      ? 'OVERDUE'
      : nextStatus;

    const updated = await this.prisma.brcRecord.update({
      where: { id: existing.id },
      data: {
        ...(updates.brcNumber !== undefined ? { brcNumber: updates.brcNumber?.trim() || null } : {}),
        ...(updates.issueDate !== undefined ? { issueDate: updates.issueDate ? new Date(updates.issueDate) : null } : {}),
        ...(updates.realisationDate !== undefined
          ? { realisationDate: updates.realisationDate ? new Date(updates.realisationDate) : null }
          : {}),
        ...(updates.realisedAmount !== undefined
          ? { realisedAmount: updates.realisedAmount !== null ? Number(updates.realisedAmount) : null }
          : {}),
        ...(updates.realisedCurrency !== undefined ? { realisedCurrency: updates.realisedCurrency || null } : {}),
        ...(updates.uploadMode !== undefined ? { uploadMode: updates.uploadMode } : {}),
        ...(updates.statutoryDeadline !== undefined
          ? { statutoryDeadline: updates.statutoryDeadline ? new Date(updates.statutoryDeadline) : null }
          : {}),
        ...(updates.remarks !== undefined ? { remarks: updates.remarks || null } : {}),
        status: finalStatus,
      },
    });
    return mapPrismaBrc(updated);
  }

  async reset(idOrShipmentId: string): Promise<BrcRecord> {
    const existing = await this.prisma.brcRecord.findFirst({
      where: {
        OR: [{ id: idOrShipmentId }, { shipmentId: idOrShipmentId }],
      },
    });
    if (!existing) throw new NotFoundError('BRC record not found.');

    const updated = await this.prisma.brcRecord.update({
      where: { id: existing.id },
      data: {
        brcNumber: null,
        issueDate: null,
        realisationDate: null,
        realisedAmount: null,
        status: 'PENDING',
        remarks: null,
      },
    });
    return mapPrismaBrc(updated);
  }
}

export class JsonBrcRepository implements IBrcRepository {
  async update(idOrShipmentId: string, updates: UpdateBrcInput): Promise<BrcRecord> {
    const state = jsonStore.getState();
    const now = new Date().toISOString();
    let item = state.brcRecords.find((b) => b.id === idOrShipmentId || b.shipmentId === idOrShipmentId);
    if (!item) {
      item = {
        id: crypto.randomUUID(),
        shipmentId: idOrShipmentId,
        uploadMode: updates.uploadMode || 'SINGLE',
        status: updates.status || 'PENDING',
        createdAt: now,
        updatedAt: now,
      };
      state.brcRecords.push(item);
    }

    if (updates.brcNumber !== undefined) item.brcNumber = updates.brcNumber?.trim();
    if (updates.issueDate !== undefined) item.issueDate = updates.issueDate;
    if (updates.realisationDate !== undefined) item.realisationDate = updates.realisationDate;
    if (updates.realisedAmount !== undefined) item.realisedAmount = Number(updates.realisedAmount);
    if (updates.realisedCurrency !== undefined) item.realisedCurrency = updates.realisedCurrency;
    if (updates.uploadMode !== undefined) item.uploadMode = updates.uploadMode;
    if (updates.statutoryDeadline !== undefined) item.statutoryDeadline = updates.statutoryDeadline;
    if (updates.status !== undefined) item.status = updates.status;
    if (updates.remarks !== undefined) item.remarks = updates.remarks;

    if (isBrcOverdue(item)) {
      item.status = 'OVERDUE';
    }

    item.updatedAt = now;
    jsonStore.save();
    return item;
  }

  async reset(idOrShipmentId: string): Promise<BrcRecord> {
    const state = jsonStore.getState();
    const item = state.brcRecords.find((b) => b.id === idOrShipmentId || b.shipmentId === idOrShipmentId);
    if (!item) throw new NotFoundError('BRC record not found.');

    item.brcNumber = undefined;
    item.issueDate = undefined;
    item.realisationDate = undefined;
    item.realisedAmount = undefined;
    item.status = 'PENDING';
    item.remarks = undefined;
    item.updatedAt = new Date().toISOString();

    jsonStore.save();
    return item;
  }
}
