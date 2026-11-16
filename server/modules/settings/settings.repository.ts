/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import type { PrismaClient } from '@prisma/client';
import type { AppSettings } from '../../../shared/contracts/index.ts';
import { seedPrismaDatabase } from '../../../prisma/seed.ts';
import { createInitialSeedState, DEFAULT_SETTINGS } from '../../../prisma/seedData.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';

export interface ISettingsRepository {
  getSettings(): Promise<AppSettings>;
  updateSettings(updates: Partial<AppSettings>): Promise<AppSettings>;
  clearAllOperationalData(): Promise<{ success: boolean; cleared: Record<string, number> }>;
  reseedWithDefaults(): Promise<{ success: boolean; count: number }>;
}

function parseSettingsRows(rows: Array<{ key: string; value: string }>): AppSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    statutoryBrcDays: Number(map.get('statutoryBrcDays') ?? DEFAULT_SETTINGS.statutoryBrcDays),
    defaultPortCode: map.get('defaultPortCode') ?? DEFAULT_SETTINGS.defaultPortCode,
    baseCurrency: map.get('baseCurrency') ?? DEFAULT_SETTINGS.baseCurrency,
    allowOverAllocation:
      map.has('allowOverAllocation')
        ? map.get('allowOverAllocation') === 'true'
        : DEFAULT_SETTINGS.allowOverAllocation,
    companyName: map.get('companyName') ?? DEFAULT_SETTINGS.companyName,
    iecNumber: map.get('iecNumber') ?? DEFAULT_SETTINGS.iecNumber,
    panNumber: map.get('panNumber') ?? DEFAULT_SETTINGS.panNumber,
  };
}

export class PrismaSettingsRepository implements ISettingsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getSettings(): Promise<AppSettings> {
    const rows = await this.prisma.appSetting.findMany();
    return parseSettingsRows(rows);
  }

  async updateSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
    const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
    await this.prisma.$transaction(async (tx) => {
      for (const [key, value] of entries) {
        await tx.appSetting.upsert({
          where: { key },
          update: { value: String(value) },
          create: { key, value: String(value) },
        });
      }
    });
    return this.getSettings();
  }

  async clearAllOperationalData(): Promise<{ success: boolean; cleared: Record<string, number> }> {
    const docs = await this.prisma.document.findMany({ select: { storedPath: true } });

    const cleared = await this.prisma.$transaction(async (tx) => {
      const counts = {
        shipments: await tx.shipment.count(),
        invoiceItems: await tx.invoiceItem.count(),
        documents: await tx.document.count(),
        payments: await tx.payment.count(),
        allocations: await tx.paymentAllocation.count(),
        incentives: await tx.incentiveRecord.count(),
        brcRecords: await tx.brcRecord.count(),
      };

      await tx.document.deleteMany();
      await tx.paymentAllocation.deleteMany();
      await tx.incentiveRecord.deleteMany();
      await tx.brcRecord.deleteMany();
      await tx.invoiceItem.deleteMany();
      await tx.shipment.deleteMany();
      await tx.payment.deleteMany();
      return counts;
    });

    for (const doc of docs) {
      try {
        const fullPath = path.isAbsolute(doc.storedPath) ? doc.storedPath : path.resolve(doc.storedPath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      } catch (err) {
        console.warn('Could not remove file on disk:', err);
      }
    }

    return { success: true, cleared };
  }

  async reseedWithDefaults(): Promise<{ success: boolean; count: number }> {
    await seedPrismaDatabase(this.prisma, { preserveUsersAndSettings: true });
    const count = await this.prisma.shipment.count();
    return { success: true, count };
  }
}

export class JsonSettingsRepository implements ISettingsRepository {
  async getSettings(): Promise<AppSettings> {
    return jsonStore.getState().settings;
  }

  async updateSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
    const state = jsonStore.getState();
    Object.assign(state.settings, updates);
    jsonStore.save();
    return state.settings;
  }

  async clearAllOperationalData(): Promise<{ success: boolean; cleared: Record<string, number> }> {
    const state = jsonStore.getState();
    const countSummary = {
      shipments: state.shipments.length,
      invoiceItems: state.invoiceItems.length,
      documents: state.documents.length,
      payments: state.payments.length,
      allocations: state.allocations.length,
      incentives: state.incentives.length,
      brcRecords: state.brcRecords.length,
    };

    for (const doc of state.documents) {
      try {
        const fullPath = path.isAbsolute(doc.storedPath) ? doc.storedPath : path.resolve(doc.storedPath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      } catch (e) {
        console.warn('Could not remove file on disk:', e);
      }
    }

    state.shipments = [];
    state.invoiceItems = [];
    state.documents = [];
    state.payments = [];
    state.allocations = [];
    state.incentives = [];
    state.brcRecords = [];

    jsonStore.save();
    return { success: true, cleared: countSummary };
  }

  async reseedWithDefaults(): Promise<{ success: boolean; count: number }> {
    const current = jsonStore.getState();
    const existingUsers = [...(current.users || [])];
    const existingSettings = { ...current.settings };

    const fresh = createInitialSeedState();
    if (existingUsers.length > 0) fresh.users = existingUsers;
    if (existingSettings && Object.keys(existingSettings).length > 0) {
      fresh.settings = { ...fresh.settings, ...existingSettings };
    }

    jsonStore.replaceState(fresh);
    return { success: true, count: fresh.shipments.length };
  }
}
