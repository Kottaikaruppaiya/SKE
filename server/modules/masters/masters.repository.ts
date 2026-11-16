/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { BankMaster, ConsigneeMaster, FinancialYear } from '../../../shared/contracts/index.ts';
import { ConflictError, NotFoundError } from '../../domain/errors/AppError.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';
import { toIsoDate, toIsoTimestamp } from '../../infrastructure/prismaMappers.ts';

export interface IMastersRepository {
  findFinancialYears(): Promise<FinancialYear[]>;
  findCurrentFinancialYear(): Promise<FinancialYear>;
  findConsignees(): Promise<ConsigneeMaster[]>;
  findConsigneeById(id: string): Promise<ConsigneeMaster | null>;
  findConsigneeByName(name: string): Promise<ConsigneeMaster | null>;
  createConsignee(data: Omit<ConsigneeMaster, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConsigneeMaster>;
  updateConsignee(id: string, updates: Partial<ConsigneeMaster>): Promise<ConsigneeMaster>;
  deleteConsignee(id: string): Promise<{ success: boolean }>;
  findBanks(): Promise<BankMaster[]>;
  findBankById(id: string): Promise<BankMaster | null>;
  findBankByName(name: string): Promise<BankMaster | null>;
  createBank(data: Omit<BankMaster, 'id' | 'createdAt' | 'updatedAt'>): Promise<BankMaster>;
  updateBank(id: string, updates: Partial<BankMaster>): Promise<BankMaster>;
  deleteBank(id: string): Promise<{ success: boolean }>;
}

function mapConsignee(row: any): ConsigneeMaster {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    portOfDischarge: row.portOfDischarge || '',
    paymentTerms: row.paymentTerms || '',
    currency: row.currency || 'USD',
    contactEmail: row.contactEmail || undefined,
    isActive: row.isActive,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

function mapBank(row: any): BankMaster {
  return {
    id: row.id,
    name: row.name,
    branch: row.branch || '',
    adCode: row.adCode || '',
    ifscCode: row.ifscCode || '',
    swiftCode: row.swiftCode || '',
    accountNumber: row.accountNumber || '',
    isActive: row.isActive,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

export class PrismaMastersRepository implements IMastersRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findFinancialYears(): Promise<FinancialYear[]> {
    const rows = await this.prisma.financialYear.findMany({ orderBy: { startDate: 'desc' } });
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      startDate: toIsoDate(r.startDate),
      endDate: toIsoDate(r.endDate),
      isCurrent: r.isCurrent,
    }));
  }

  async findCurrentFinancialYear(): Promise<FinancialYear> {
    const row =
      (await this.prisma.financialYear.findFirst({ where: { isCurrent: true } })) ||
      (await this.prisma.financialYear.findFirst({ orderBy: { startDate: 'desc' } }));
    if (!row) throw new NotFoundError('No financial year configured.');
    return {
      id: row.id,
      label: row.label,
      startDate: toIsoDate(row.startDate),
      endDate: toIsoDate(row.endDate),
      isCurrent: row.isCurrent,
    };
  }

  async findConsignees(): Promise<ConsigneeMaster[]> {
    const rows = await this.prisma.consigneeMaster.findMany({ orderBy: { name: 'asc' } });
    return rows.map(mapConsignee);
  }

  async findConsigneeById(id: string): Promise<ConsigneeMaster | null> {
    const row = await this.prisma.consigneeMaster.findUnique({ where: { id } });
    return row ? mapConsignee(row) : null;
  }

  async findConsigneeByName(name: string): Promise<ConsigneeMaster | null> {
    const row = await this.prisma.consigneeMaster.findFirst({
      where: { name: { equals: name.trim(), mode: 'insensitive' } },
    });
    return row ? mapConsignee(row) : null;
  }

  async createConsignee(data: Omit<ConsigneeMaster, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConsigneeMaster> {
    const existing = await this.findConsigneeByName(data.name);
    if (existing) {
      throw new ConflictError(`Consignee '${data.name}' already exists in master.`);
    }
    const created = await this.prisma.consigneeMaster.create({
      data: {
        name: data.name.trim(),
        country: data.country.trim(),
        portOfDischarge: data.portOfDischarge || null,
        paymentTerms: data.paymentTerms || null,
        currency: data.currency || 'USD',
        contactEmail: data.contactEmail || null,
        isActive: data.isActive ?? true,
      },
    });
    return mapConsignee(created);
  }

  async updateConsignee(id: string, updates: Partial<ConsigneeMaster>): Promise<ConsigneeMaster> {
    const existing = await this.prisma.consigneeMaster.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Consignee not found.');

    const updated = await this.prisma.consigneeMaster.update({
      where: { id },
      data: {
        ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
        ...(updates.country !== undefined ? { country: updates.country.trim() } : {}),
        ...(updates.portOfDischarge !== undefined ? { portOfDischarge: updates.portOfDischarge } : {}),
        ...(updates.paymentTerms !== undefined ? { paymentTerms: updates.paymentTerms } : {}),
        ...(updates.currency !== undefined ? { currency: updates.currency } : {}),
        ...(updates.contactEmail !== undefined ? { contactEmail: updates.contactEmail || null } : {}),
        ...(updates.isActive !== undefined ? { isActive: updates.isActive } : {}),
      },
    });
    return mapConsignee(updated);
  }

  async deleteConsignee(id: string): Promise<{ success: boolean }> {
    const consignee = await this.prisma.consigneeMaster.findUnique({ where: { id } });
    if (!consignee) throw new NotFoundError('Consignee not found.');

    const [shipCount, firstShip, gstCount] = await Promise.all([
      this.prisma.shipment.count({ where: { consigneeId: id } }),
      this.prisma.shipment.findFirst({ where: { consigneeId: id }, select: { invoiceNumber: true } }),
      this.prisma.gstEntry.count({ where: { consigneeId: id } }),
    ]);

    if (shipCount > 0) {
      throw new ConflictError(
        `Cannot delete Consignee "${consignee.name}": It is referenced by ${shipCount} export shipment(s) (e.g. ${firstShip?.invoiceNumber || ''}). You must reassign those shipments or deactivate the consignee instead.`
      );
    }
    if (gstCount > 0) {
      throw new ConflictError(
        `Cannot delete Consignee "${consignee.name}": It is referenced by ${gstCount} GST ledger entries.`
      );
    }

    await this.prisma.consigneeMaster.delete({ where: { id } });
    return { success: true };
  }

  async findBanks(): Promise<BankMaster[]> {
    const rows = await this.prisma.bankMaster.findMany({ orderBy: { name: 'asc' } });
    return rows.map(mapBank);
  }

  async findBankById(id: string): Promise<BankMaster | null> {
    const row = await this.prisma.bankMaster.findUnique({ where: { id } });
    return row ? mapBank(row) : null;
  }

  async findBankByName(name: string): Promise<BankMaster | null> {
    const row = await this.prisma.bankMaster.findFirst({
      where: { name: { equals: name.trim(), mode: 'insensitive' } },
    });
    return row ? mapBank(row) : null;
  }

  async createBank(data: Omit<BankMaster, 'id' | 'createdAt' | 'updatedAt'>): Promise<BankMaster> {
    const existing = await this.findBankByName(data.name);
    if (existing) {
      throw new ConflictError(`Bank '${data.name}' already exists.`);
    }
    const created = await this.prisma.bankMaster.create({
      data: {
        name: data.name.trim(),
        branch: data.branch || null,
        adCode: data.adCode || null,
        ifscCode: data.ifscCode || null,
        swiftCode: data.swiftCode || null,
        accountNumber: data.accountNumber || null,
        isActive: data.isActive ?? true,
      },
    });
    return mapBank(created);
  }

  async updateBank(id: string, updates: Partial<BankMaster>): Promise<BankMaster> {
    const existing = await this.prisma.bankMaster.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Bank not found.');

    const updated = await this.prisma.bankMaster.update({
      where: { id },
      data: {
        ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
        ...(updates.branch !== undefined ? { branch: updates.branch } : {}),
        ...(updates.adCode !== undefined ? { adCode: updates.adCode } : {}),
        ...(updates.ifscCode !== undefined ? { ifscCode: updates.ifscCode } : {}),
        ...(updates.swiftCode !== undefined ? { swiftCode: updates.swiftCode } : {}),
        ...(updates.accountNumber !== undefined ? { accountNumber: updates.accountNumber } : {}),
        ...(updates.isActive !== undefined ? { isActive: updates.isActive } : {}),
      },
    });
    return mapBank(updated);
  }

  async deleteBank(id: string): Promise<{ success: boolean }> {
    const bank = await this.prisma.bankMaster.findUnique({ where: { id } });
    if (!bank) throw new NotFoundError('Bank not found.');

    const [paymentCount, firstPayment] = await Promise.all([
      this.prisma.payment.count({ where: { bankId: id } }),
      this.prisma.payment.findFirst({ where: { bankId: id }, select: { irmNumber: true } }),
    ]);

    if (paymentCount > 0) {
      throw new ConflictError(
        `Cannot delete Bank "${bank.name}": It is referenced by ${paymentCount} FIRC payment(s) (e.g. IRM ${firstPayment?.irmNumber || ''}). You must reassign those payments or deactivate the bank instead.`
      );
    }

    await this.prisma.bankMaster.delete({ where: { id } });
    return { success: true };
  }
}

export class JsonMastersRepository implements IMastersRepository {
  async findFinancialYears(): Promise<FinancialYear[]> {
    return jsonStore.getState().financialYears;
  }

  async findCurrentFinancialYear(): Promise<FinancialYear> {
    const years = jsonStore.getState().financialYears;
    return years.find((fy) => fy.isCurrent) || years[0];
  }

  async findConsignees(): Promise<ConsigneeMaster[]> {
    return jsonStore.getState().consignees;
  }

  async findConsigneeById(id: string): Promise<ConsigneeMaster | null> {
    return jsonStore.getState().consignees.find((c) => c.id === id) || null;
  }

  async findConsigneeByName(name: string): Promise<ConsigneeMaster | null> {
    return jsonStore.getState().consignees.find((c) => c.name.toLowerCase() === name.trim().toLowerCase()) || null;
  }

  async createConsignee(data: Omit<ConsigneeMaster, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConsigneeMaster> {
    const state = jsonStore.getState();
    const existing = state.consignees.find((c) => c.name.toLowerCase() === data.name.trim().toLowerCase());
    if (existing) throw new ConflictError(`Consignee '${data.name}' already exists in master.`);

    const now = new Date().toISOString();
    const record: ConsigneeMaster = {
      id: crypto.randomUUID(),
      name: data.name.trim(),
      country: data.country.trim(),
      portOfDischarge: data.portOfDischarge || '',
      paymentTerms: data.paymentTerms || '',
      currency: data.currency || 'USD',
      contactEmail: data.contactEmail,
      isActive: data.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    state.consignees.push(record);
    jsonStore.save();
    return record;
  }

  async updateConsignee(id: string, updates: Partial<ConsigneeMaster>): Promise<ConsigneeMaster> {
    const state = jsonStore.getState();
    const item = state.consignees.find((c) => c.id === id);
    if (!item) throw new NotFoundError('Consignee not found.');

    Object.assign(item, updates, { updatedAt: new Date().toISOString() });
    jsonStore.save();
    return item;
  }

  async deleteConsignee(id: string): Promise<{ success: boolean }> {
    const state = jsonStore.getState();
    const idx = state.consignees.findIndex((c) => c.id === id);
    if (idx === -1) throw new NotFoundError('Consignee not found.');

    const consignee = state.consignees[idx];
    const referencedShipments = state.shipments.filter((s) => s.consigneeId === id);
    if (referencedShipments.length > 0) {
      throw new ConflictError(
        `Cannot delete Consignee "${consignee.name}": It is referenced by ${referencedShipments.length} export shipment(s) (e.g. ${referencedShipments[0].invoiceNumber}). You must reassign those shipments or deactivate the consignee instead.`
      );
    }

    const referencedGst = (state.gstEntries || []).filter((g) => g.consigneeId === id);
    if (referencedGst.length > 0) {
      throw new ConflictError(
        `Cannot delete Consignee "${consignee.name}": It is referenced by ${referencedGst.length} GST ledger entries.`
      );
    }

    state.consignees.splice(idx, 1);
    jsonStore.save();
    return { success: true };
  }

  async findBanks(): Promise<BankMaster[]> {
    return jsonStore.getState().banks;
  }

  async findBankById(id: string): Promise<BankMaster | null> {
    return jsonStore.getState().banks.find((b) => b.id === id) || null;
  }

  async findBankByName(name: string): Promise<BankMaster | null> {
    return jsonStore.getState().banks.find((b) => b.name.toLowerCase() === name.trim().toLowerCase()) || null;
  }

  async createBank(data: Omit<BankMaster, 'id' | 'createdAt' | 'updatedAt'>): Promise<BankMaster> {
    const state = jsonStore.getState();
    const existing = state.banks.find((b) => b.name.toLowerCase() === data.name.trim().toLowerCase());
    if (existing) throw new ConflictError(`Bank '${data.name}' already exists.`);

    const now = new Date().toISOString();
    const record: BankMaster = {
      id: crypto.randomUUID(),
      name: data.name.trim(),
      branch: data.branch || '',
      adCode: data.adCode || '',
      ifscCode: data.ifscCode || '',
      swiftCode: data.swiftCode || '',
      accountNumber: data.accountNumber || '',
      isActive: data.isActive ?? true,
      createdAt: now,
      updatedAt: now,
    };
    state.banks.push(record);
    jsonStore.save();
    return record;
  }

  async updateBank(id: string, updates: Partial<BankMaster>): Promise<BankMaster> {
    const state = jsonStore.getState();
    const item = state.banks.find((b) => b.id === id);
    if (!item) throw new NotFoundError('Bank not found.');

    Object.assign(item, updates, { updatedAt: new Date().toISOString() });
    jsonStore.save();
    return item;
  }

  async deleteBank(id: string): Promise<{ success: boolean }> {
    const state = jsonStore.getState();
    const idx = state.banks.findIndex((b) => b.id === id);
    if (idx === -1) throw new NotFoundError('Bank not found.');

    const bank = state.banks[idx];
    const referencedPayments = state.payments.filter((p) => p.bankId === id);
    if (referencedPayments.length > 0) {
      throw new ConflictError(
        `Cannot delete Bank "${bank.name}": It is referenced by ${referencedPayments.length} FIRC payment(s) (e.g. IRM ${referencedPayments[0].irmNumber}). You must reassign those payments or deactivate the bank instead.`
      );
    }

    state.banks.splice(idx, 1);
    jsonStore.save();
    return { success: true };
  }
}
