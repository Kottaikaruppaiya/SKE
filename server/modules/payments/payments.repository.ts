/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { Payment, PaymentAllocation } from '../../../shared/contracts/index.ts';
import {
  computePaymentAllocationBalances,
  deriveShipmentPaymentStatus,
} from '../../domain/calculations/shipment.calc.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors/AppError.ts';
import { hydratePaymentDto } from '../../infrastructure/hydration.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';
import { bigIntToNumber, decimalToNumber, toDateOrUndefined, toIsoDate, toIsoTimestamp } from '../../infrastructure/prismaMappers.ts';

export interface CreatePaymentInput {
  irmNumber: string;
  senderReference?: string;
  currency?: string;
  verifiedAmount: number;
  inrAmount?: number;
  exchangeRate?: number;
  valueDate: string;
  creditDate: string;
  fircIssueDate?: string;
  bankId: string;
  purposeCode?: string;
  remarks?: string;
}

export interface AllocatePaymentInput {
  paymentId: string;
  shipmentId: string;
  allocatedAmountUsd: number;
  notes?: string;
}

export interface IPaymentsRepository {
  findAll(): Promise<Payment[]>;
  findById(id: string): Promise<Payment | null>;
  findByIrmNumber(irmNumber: string): Promise<Payment | null>;
  create(input: CreatePaymentInput): Promise<Payment>;
  update(id: string, updates: Partial<Payment>): Promise<Payment>;
  delete(id: string): Promise<{ success: boolean }>;
  allocate(input: AllocatePaymentInput, actorUserId: string): Promise<PaymentAllocation>;
  deallocate(allocationId: string): Promise<{ success: boolean }>;
}

const PRISMA_PAYMENT_INCLUDE = {
  bank: true,
  allocations: { include: { shipment: true } },
  documents: { where: { isCurrent: true }, include: { uploadedByUser: true } },
} as const;

function mapPrismaPayment(row: any, userNamesMap?: Map<string, string>): Payment {
  const base: Payment = {
    id: row.id,
    irmNumber: row.irmNumber,
    senderReference: row.senderReference || undefined,
    currency: row.currency,
    verifiedAmount: decimalToNumber(row.verifiedAmount),
    inrAmount: row.inrAmount !== null && row.inrAmount !== undefined ? decimalToNumber(row.inrAmount) : undefined,
    exchangeRate:
      row.exchangeRate !== null && row.exchangeRate !== undefined ? decimalToNumber(row.exchangeRate) : undefined,
    valueDate: toIsoDate(row.valueDate),
    creditDate: toIsoDate(row.creditDate),
    fircIssueDate: toDateOrUndefined(row.fircIssueDate),
    bankId: row.bankId,
    purposeCode: row.purposeCode || undefined,
    remarks: row.remarks || undefined,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };

  const allocations = (row.allocations || []).map((a: any) => ({
    id: a.id,
    paymentId: a.paymentId,
    shipmentId: a.shipmentId,
    allocatedAmountUsd: decimalToNumber(a.allocatedAmountUsd),
    notes: a.notes || undefined,
    allocatedAt: toIsoTimestamp(a.allocatedAt),
    allocatedByUserId: a.allocatedByUserId,
    allocatedByName: userNamesMap?.get(a.allocatedByUserId),
    shipmentInvoiceNo: a.shipment?.invoiceNumber,
  }));

  const documents = (row.documents || []).map((d: any) => ({
    id: d.id,
    shipmentId: d.shipmentId || undefined,
    paymentId: d.paymentId || undefined,
    category: d.category,
    originalFilename: d.originalFilename,
    storedPath: d.storedPath,
    mimeType: d.mimeType,
    fileSizeBytes: bigIntToNumber(d.fileSizeBytes),
    version: d.version,
    isCurrent: d.isCurrent,
    reviewStatus: d.reviewStatus,
    uploadedByUserId: d.uploadedByUserId,
    uploadedByName: d.uploadedByUser?.name,
    createdAt: toIsoTimestamp(d.createdAt),
    updatedAt: toIsoTimestamp(d.updatedAt),
  }));

  return hydratePaymentDto({
    payment: base,
    bankName: row.bank?.name,
    allocations,
    documents,
  });
}

export class PrismaPaymentsRepository implements IPaymentsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll(): Promise<Payment[]> {
    const [rows, users] = await Promise.all([
      this.prisma.payment.findMany({
        include: PRISMA_PAYMENT_INCLUDE,
        orderBy: { creditDate: 'desc' },
      }),
      this.prisma.user.findMany({ select: { id: true, name: true } }),
    ]);
    const userNamesMap = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => mapPrismaPayment(r, userNamesMap));
  }

  async findById(id: string): Promise<Payment | null> {
    const row = await this.prisma.payment.findUnique({
      where: { id },
      include: PRISMA_PAYMENT_INCLUDE,
    });
    if (!row) return null;
    const users = await this.prisma.user.findMany({ select: { id: true, name: true } });
    const userNamesMap = new Map(users.map((u) => [u.id, u.name]));
    return mapPrismaPayment(row, userNamesMap);
  }

  async findByIrmNumber(irmNumber: string): Promise<Payment | null> {
    const cleanIrm = irmNumber.trim().toUpperCase();
    const row = await this.prisma.payment.findUnique({
      where: { irmNumber: cleanIrm },
      include: PRISMA_PAYMENT_INCLUDE,
    });
    return row ? mapPrismaPayment(row) : null;
  }

  async create(input: CreatePaymentInput): Promise<Payment> {
    const cleanIrm = input.irmNumber.trim().toUpperCase();
    const existing = await this.prisma.payment.findUnique({ where: { irmNumber: cleanIrm } });
    if (existing) {
      throw new ConflictError(`Inward Remittance / IRM '${cleanIrm}' already exists in payments register.`);
    }

    const created = await this.prisma.payment.create({
      data: {
        irmNumber: cleanIrm,
        senderReference: input.senderReference?.trim() || null,
        currency: input.currency || 'USD',
        verifiedAmount: Number(input.verifiedAmount),
        inrAmount: input.inrAmount !== undefined ? Number(input.inrAmount) : null,
        exchangeRate: input.exchangeRate !== undefined ? Number(input.exchangeRate) : null,
        valueDate: new Date(input.valueDate),
        creditDate: new Date(input.creditDate),
        fircIssueDate: input.fircIssueDate ? new Date(input.fircIssueDate) : null,
        bankId: input.bankId,
        purposeCode: input.purposeCode || 'P0102',
        remarks: input.remarks?.trim() || null,
      },
      include: PRISMA_PAYMENT_INCLUDE,
    });
    return mapPrismaPayment(created);
  }

  async update(id: string, updates: Partial<Payment>): Promise<Payment> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id },
        include: { allocations: true },
      });
      if (!payment) throw new NotFoundError('Payment not found.');

      const dataToUpdate: Record<string, any> = {};
      if (updates.irmNumber && updates.irmNumber !== payment.irmNumber) {
        const cleanIrm = updates.irmNumber.trim().toUpperCase();
        const dup = await tx.payment.findFirst({ where: { id: { not: id }, irmNumber: cleanIrm } });
        if (dup) throw new ConflictError(`Inward Remittance / IRM '${cleanIrm}' already exists.`);
        dataToUpdate.irmNumber = cleanIrm;
      }

      if (updates.senderReference !== undefined) {
        dataToUpdate.senderReference = updates.senderReference?.trim() || null;
      }
      if (updates.verifiedAmount !== undefined) {
        const newAmt = Number(updates.verifiedAmount);
        if (newAmt <= 0) throw new ValidationError('Payment verified amount must be greater than zero.');
        const totalAllocated = payment.allocations.reduce(
          (sum, a) => sum + decimalToNumber(a.allocatedAmountUsd),
          0
        );
        if (newAmt < totalAllocated - 0.001) {
          throw new ValidationError(
            `Cannot reduce payment verified amount ($${newAmt.toFixed(2)}) below active allocations ($${totalAllocated.toFixed(2)} across ${payment.allocations.length} invoice(s)). Please reverse excess allocations first.`
          );
        }
        dataToUpdate.verifiedAmount = newAmt;
      }

      if (updates.exchangeRate !== undefined) dataToUpdate.exchangeRate = Number(updates.exchangeRate);
      if (updates.inrAmount !== undefined) dataToUpdate.inrAmount = Number(updates.inrAmount);
      if (updates.valueDate) dataToUpdate.valueDate = new Date(updates.valueDate);
      if (updates.creditDate) dataToUpdate.creditDate = new Date(updates.creditDate);
      if (updates.fircIssueDate !== undefined) {
        dataToUpdate.fircIssueDate = updates.fircIssueDate ? new Date(updates.fircIssueDate) : null;
      }
      if (updates.bankId) dataToUpdate.bankId = updates.bankId;
      if (updates.purposeCode !== undefined) dataToUpdate.purposeCode = updates.purposeCode;
      if (updates.remarks !== undefined) dataToUpdate.remarks = updates.remarks;

      await tx.payment.update({ where: { id }, data: dataToUpdate });
    });

    const full = await this.findById(id);
    if (!full) throw new NotFoundError('Payment not found.');
    return full;
  }

  async delete(id: string): Promise<{ success: boolean }> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id },
        include: { allocations: true },
      });
      if (!payment) throw new NotFoundError('Payment not found.');

      if (payment.allocations.length > 0) {
        const totalAllocated = payment.allocations.reduce(
          (sum, a) => sum + decimalToNumber(a.allocatedAmountUsd),
          0
        );
        throw new ConflictError(
          `Cannot delete FIRC payment "${payment.irmNumber}": It has ${payment.allocations.length} active allocation(s) totaling $${totalAllocated.toFixed(2)} USD. Please reverse all invoice allocations first before deleting this payment.`
        );
      }

      await tx.document.updateMany({ where: { paymentId: id }, data: { paymentId: null } });
      await tx.payment.delete({ where: { id } });
    });
    return { success: true };
  }

  async allocate(input: AllocatePaymentInput, actorUserId: string): Promise<PaymentAllocation> {
    const amount = Number(input.allocatedAmountUsd);
    if (amount <= 0) {
      throw new ValidationError('Allocation amount must be strictly greater than 0.');
    }

    return this.prisma.$transaction(async (tx) => {
      // Acquire row-level FOR UPDATE locks in PostgreSQL to eliminate double-allocation race conditions
      const lockedPayments = await tx.$queryRaw<any[]>`
        SELECT id, "irmNumber", "verifiedAmount"
        FROM "Payment"
        WHERE id = ${input.paymentId}
        FOR UPDATE
      `;
      const paymentRow = lockedPayments[0];
      if (!paymentRow) throw new NotFoundError('Payment record not found.');

      const lockedShipments = await tx.$queryRaw<any[]>`
        SELECT id, "invoiceNumber", "invoiceValueUsd"
        FROM "Shipment"
        WHERE id = ${input.shipmentId}
        FOR UPDATE
      `;
      const shipmentRow = lockedShipments[0];
      if (!shipmentRow) throw new NotFoundError('Shipment record not found.');

      const existingPaymentAllocs = await tx.paymentAllocation.findMany({
        where: { paymentId: input.paymentId },
      });
      const { availableBalanceUsd } = computePaymentAllocationBalances(
        decimalToNumber(paymentRow.verifiedAmount),
        existingPaymentAllocs.map((a) => ({ allocatedAmountUsd: decimalToNumber(a.allocatedAmountUsd) }))
      );

      if (amount > availableBalanceUsd + 0.001) {
        throw new ValidationError(
          `Over-allocation rejected: Requested $${amount.toFixed(2)} exceeds available payment balance of $${availableBalanceUsd.toFixed(2)} on FIRC ${paymentRow.irmNumber}.`
        );
      }

      const existingShipmentAllocs = await tx.paymentAllocation.findMany({
        where: { shipmentId: input.shipmentId },
      });
      const totalAllocatedToShipment = existingShipmentAllocs.reduce(
        (sum, a) => sum + decimalToNumber(a.allocatedAmountUsd),
        0
      );
      const invoiceValueUsd = decimalToNumber(shipmentRow.invoiceValueUsd);
      const invoiceBalanceDue = invoiceValueUsd - totalAllocatedToShipment;

      if (amount > invoiceBalanceDue + 0.001) {
        throw new ValidationError(
          `Over-allocation rejected: Requested $${amount.toFixed(2)} exceeds remaining invoice balance due of $${invoiceBalanceDue.toFixed(2)} on Invoice ${shipmentRow.invoiceNumber}.`
        );
      }

      const actor = await tx.user.findUnique({ where: { id: actorUserId }, select: { name: true } });

      const created = await tx.paymentAllocation.create({
        data: {
          paymentId: input.paymentId,
          shipmentId: input.shipmentId,
          allocatedAmountUsd: amount,
          notes: input.notes?.trim() || null,
          allocatedByUserId: actorUserId,
        },
      });

      const nextTotalPaid = totalAllocatedToShipment + amount;
      await tx.shipment.update({
        where: { id: input.shipmentId },
        data: { paymentStatus: deriveShipmentPaymentStatus(invoiceValueUsd, nextTotalPaid) },
      });

      return {
        id: created.id,
        paymentId: created.paymentId,
        shipmentId: created.shipmentId,
        allocatedAmountUsd: decimalToNumber(created.allocatedAmountUsd),
        notes: created.notes || undefined,
        allocatedAt: toIsoTimestamp(created.allocatedAt),
        allocatedByUserId: created.allocatedByUserId,
        allocatedByName: actor?.name || 'Admin',
      };
    });
  }

  async deallocate(allocationId: string): Promise<{ success: boolean }> {
    await this.prisma.$transaction(async (tx) => {
      const alloc = await tx.paymentAllocation.findUnique({ where: { id: allocationId } });
      if (!alloc) throw new NotFoundError('Allocation not found.');

      await tx.paymentAllocation.delete({ where: { id: allocationId } });

      const shipment = await tx.shipment.findUnique({
        where: { id: alloc.shipmentId },
        include: { allocations: true },
      });
      if (shipment) {
        const totalPaid = shipment.allocations.reduce(
          (sum, a) => sum + decimalToNumber(a.allocatedAmountUsd),
          0
        );
        await tx.shipment.update({
          where: { id: shipment.id },
          data: {
            paymentStatus: deriveShipmentPaymentStatus(decimalToNumber(shipment.invoiceValueUsd), totalPaid),
          },
        });
      }
    });
    return { success: true };
  }
}

export class JsonPaymentsRepository implements IPaymentsRepository {
  private hydrate(payment: Payment): Payment {
    const state = jsonStore.getState();
    const allocations = state.allocations
      .filter((a) => a.paymentId === payment.id)
      .map((a) => {
        const s = state.shipments.find((sh) => sh.id === a.shipmentId);
        return { ...a, shipmentInvoiceNo: s?.invoiceNumber };
      });
    const documents = state.documents.filter((d) => d.paymentId === payment.id && d.isCurrent);
    const bank = state.banks.find((b) => b.id === payment.bankId);

    return hydratePaymentDto({
      payment,
      bankName: bank?.name,
      allocations,
      documents,
    });
  }

  async findAll(): Promise<Payment[]> {
    return jsonStore.getState().payments.map((p) => this.hydrate(p));
  }

  async findById(id: string): Promise<Payment | null> {
    const payment = jsonStore.getState().payments.find((p) => p.id === id);
    return payment ? this.hydrate(payment) : null;
  }

  async findByIrmNumber(irmNumber: string): Promise<Payment | null> {
    const clean = irmNumber.trim().toUpperCase();
    const payment = jsonStore.getState().payments.find((p) => p.irmNumber.toUpperCase() === clean);
    return payment ? this.hydrate(payment) : null;
  }

  async create(input: CreatePaymentInput): Promise<Payment> {
    const state = jsonStore.getState();
    const cleanIrm = input.irmNumber.trim().toUpperCase();
    const existing = state.payments.find((p) => p.irmNumber.toUpperCase() === cleanIrm);
    if (existing) {
      throw new ConflictError(`Inward Remittance / IRM '${cleanIrm}' already exists in payments register.`);
    }

    const now = new Date().toISOString();
    const newPayment: Payment = {
      id: crypto.randomUUID(),
      irmNumber: cleanIrm,
      senderReference: input.senderReference?.trim(),
      currency: input.currency || 'USD',
      verifiedAmount: Number(input.verifiedAmount),
      inrAmount: input.inrAmount !== undefined ? Number(input.inrAmount) : undefined,
      exchangeRate: input.exchangeRate !== undefined ? Number(input.exchangeRate) : undefined,
      valueDate: input.valueDate,
      creditDate: input.creditDate,
      fircIssueDate: input.fircIssueDate,
      bankId: input.bankId,
      purposeCode: input.purposeCode || 'P0102',
      remarks: input.remarks?.trim(),
      createdAt: now,
      updatedAt: now,
    };

    state.payments.push(newPayment);
    jsonStore.save();
    return this.hydrate(newPayment);
  }

  async update(id: string, updates: Partial<Payment>): Promise<Payment> {
    const state = jsonStore.getState();
    const payment = state.payments.find((p) => p.id === id);
    if (!payment) throw new NotFoundError('Payment not found.');

    if (updates.irmNumber && updates.irmNumber !== payment.irmNumber) {
      const cleanIrm = updates.irmNumber.trim().toUpperCase();
      const dup = state.payments.find((p) => p.id !== id && p.irmNumber.toUpperCase() === cleanIrm);
      if (dup) throw new ConflictError(`Inward Remittance / IRM '${cleanIrm}' already exists.`);
      payment.irmNumber = cleanIrm;
    }

    if (updates.senderReference !== undefined) payment.senderReference = updates.senderReference?.trim();
    if (updates.verifiedAmount !== undefined) {
      const newAmt = Number(updates.verifiedAmount);
      if (newAmt <= 0) throw new ValidationError('Payment verified amount must be greater than zero.');
      const currentAllocs = state.allocations.filter((a) => a.paymentId === id);
      const totalAllocated = currentAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      if (newAmt < totalAllocated - 0.001) {
        throw new ValidationError(
          `Cannot reduce payment verified amount ($${newAmt.toFixed(2)}) below active allocations ($${totalAllocated.toFixed(2)} across ${currentAllocs.length} invoice(s)). Please reverse excess allocations first.`
        );
      }
      payment.verifiedAmount = newAmt;
    }
    if (updates.exchangeRate !== undefined) payment.exchangeRate = Number(updates.exchangeRate);
    if (updates.inrAmount !== undefined) payment.inrAmount = Number(updates.inrAmount);
    if (updates.valueDate) payment.valueDate = updates.valueDate;
    if (updates.creditDate) payment.creditDate = updates.creditDate;
    if (updates.fircIssueDate !== undefined) payment.fircIssueDate = updates.fircIssueDate;
    if (updates.bankId) payment.bankId = updates.bankId;
    if (updates.purposeCode !== undefined) payment.purposeCode = updates.purposeCode;
    if (updates.remarks !== undefined) payment.remarks = updates.remarks;

    payment.updatedAt = new Date().toISOString();
    jsonStore.save();
    return this.hydrate(payment);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    const state = jsonStore.getState();
    const idx = state.payments.findIndex((p) => p.id === id);
    if (idx === -1) throw new NotFoundError('Payment not found.');

    const payment = state.payments[idx];
    const paymentAllocs = state.allocations.filter((a) => a.paymentId === id);
    if (paymentAllocs.length > 0) {
      const totalAllocated = paymentAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      throw new ConflictError(
        `Cannot delete FIRC payment "${payment.irmNumber}": It has ${paymentAllocs.length} active allocation(s) totaling $${totalAllocated.toFixed(2)} USD. Please reverse all invoice allocations first before deleting this payment.`
      );
    }

    state.documents = state.documents.filter((d) => d.paymentId !== id);
    state.payments.splice(idx, 1);
    jsonStore.save();
    return { success: true };
  }

  async allocate(input: AllocatePaymentInput, actorUserId: string): Promise<PaymentAllocation> {
    const amount = Number(input.allocatedAmountUsd);
    if (amount <= 0) {
      throw new ValidationError('Allocation amount must be strictly greater than 0.');
    }

    const lockKey = `payment:${input.paymentId}`;
    if (!jsonStore.acquireLock(lockKey)) {
      throw new ConflictError('Concurrent payment transaction in progress. Please retry in a moment.');
    }

    try {
      const state = jsonStore.getState();
      const payment = state.payments.find((p) => p.id === input.paymentId);
      if (!payment) throw new NotFoundError('Payment record not found.');

      const shipment = state.shipments.find((s) => s.id === input.shipmentId);
      if (!shipment) throw new NotFoundError('Shipment record not found.');

      const existingPaymentAllocs = state.allocations.filter((a) => a.paymentId === input.paymentId);
      const { availableBalanceUsd } = computePaymentAllocationBalances(
        Number(payment.verifiedAmount),
        existingPaymentAllocs
      );

      if (amount > availableBalanceUsd + 0.001) {
        throw new ValidationError(
          `Over-allocation rejected: Requested $${amount.toFixed(2)} exceeds available payment balance of $${availableBalanceUsd.toFixed(2)} on FIRC ${payment.irmNumber}.`
        );
      }

      const existingShipmentAllocs = state.allocations.filter((a) => a.shipmentId === input.shipmentId);
      const totalAllocatedToShipment = existingShipmentAllocs.reduce(
        (sum, a) => sum + Number(a.allocatedAmountUsd),
        0
      );
      const invoiceBalanceDue = Number(shipment.invoiceValueUsd) - totalAllocatedToShipment;

      if (amount > invoiceBalanceDue + 0.001) {
        throw new ValidationError(
          `Over-allocation rejected: Requested $${amount.toFixed(2)} exceeds remaining invoice balance due of $${invoiceBalanceDue.toFixed(2)} on Invoice ${shipment.invoiceNumber}.`
        );
      }

      const user = state.users.find((u) => u.id === actorUserId);
      const now = new Date().toISOString();
      const allocation: PaymentAllocation = {
        id: crypto.randomUUID(),
        paymentId: input.paymentId,
        shipmentId: input.shipmentId,
        allocatedAmountUsd: amount,
        notes: input.notes?.trim(),
        allocatedAt: now,
        allocatedByUserId: actorUserId,
        allocatedByName: user?.name || 'Admin',
      };

      state.allocations.push(allocation);

      const newTotalShipmentPaid = totalAllocatedToShipment + amount;
      shipment.paymentStatus = deriveShipmentPaymentStatus(Number(shipment.invoiceValueUsd), newTotalShipmentPaid);
      shipment.updatedAt = now;

      jsonStore.save();
      return allocation;
    } finally {
      jsonStore.releaseLock(lockKey);
    }
  }

  async deallocate(allocationId: string): Promise<{ success: boolean }> {
    const state = jsonStore.getState();
    const idx = state.allocations.findIndex((a) => a.id === allocationId);
    if (idx === -1) throw new NotFoundError('Allocation not found.');

    const alloc = state.allocations[idx];
    const shipment = state.shipments.find((s) => s.id === alloc.shipmentId);

    state.allocations.splice(idx, 1);

    if (shipment) {
      const remainingAllocs = state.allocations.filter((a) => a.shipmentId === shipment.id);
      const totalPaid = remainingAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      shipment.paymentStatus = deriveShipmentPaymentStatus(Number(shipment.invoiceValueUsd), totalPaid);
      shipment.updatedAt = new Date().toISOString();
    }

    jsonStore.save();
    return { success: true };
  }
}
