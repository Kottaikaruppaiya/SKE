/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type {
  User,
  FinancialYear,
  ConsigneeMaster,
  BankMaster,
  Shipment,
  InvoiceItem,
  DocumentRecord,
  Payment,
  PaymentAllocation,
  IncentiveRecord,
  BrcRecord,
  GstEntry,
  GstSummary,
  GstResult,
  AppSettings,
  DashboardMetrics,
  OcrJob,
  OcrJobStatus,
  MergedShipmentDraft,
  DocumentCategory,
  Supplier,
  B2bInvoice,
  B2bMonthlySummary,
  B2bDashboardMetrics,
  ImportBatch,
  B2bImportPreview,
} from '../src/types/index.ts';
import {
  createInitialSeedState,
  hashPassword as hashUserPassword,
  verifyPassword as verifyUserPassword,
  type PersistedDatabaseState,
  type RevokedTokenRecord,
} from '../prisma/seedData.ts';
import { normalizeInvoiceKey } from './normalizer.ts';
import { parseGstrPeriod, getMonthsForFinancialYear } from './gstr_period.ts';
import { jsonStore } from './infrastructure/jsonPersistence.ts';
import { hydratePaymentDto, hydrateShipmentDto } from './infrastructure/hydration.ts';

export type RevokedToken = RevokedTokenRecord;
type DatabaseState = PersistedDatabaseState;

// In-memory mutex for concurrency control on allocations
const paymentLocks = new Set<string>();

class DatabaseService {
  private get state(): DatabaseState {
    return jsonStore.getState();
  }

  private set state(next: DatabaseState) {
    jsonStore.replaceState(next);
  }

  private hashPassword(password: string, customSalt?: string): string {
    return hashUserPassword(password, customSalt);
  }

  public verifyPassword(password: string, hash: string): boolean {
    return verifyUserPassword(password, hash);
  }

  public reseedWithDefaults(actorUserId?: string) {
    const existingUsers = [...(this.state.users || [])];
    const existingSettings = { ...this.state.settings };
    const nextState = this.getInitialSeedState();

    // Preserve existing users and settings so administrative sessions are never invalidated on reseed
    if (existingUsers.length > 0) {
      nextState.users = existingUsers;
    }
    if (existingSettings && Object.keys(existingSettings).length > 0) {
      nextState.settings = { ...nextState.settings, ...existingSettings };
    }

    this.state = nextState;
    return { success: true, count: this.state.shipments.length };
  }

  private save() {
    jsonStore.save();
  }

  public reloadFromDisk() {
    jsonStore.reloadFromDisk();
  }

  public async runInTransaction<T>(fn: () => Promise<T> | T): Promise<T> {
    return jsonStore.runInTransaction(fn);
  }

  // --- Users & Auth ---
  public getUsers(): User[] {
    return this.state.users.map(({ passwordHash, ...u }: any) => u);
  }

  public getUserById(id: string): User | undefined {
    const user = this.state.users.find((u) => u.id === id);
    if (!user) return undefined;
    const { passwordHash, ...clean }: any = user;
    return clean;
  }

  public getUserByEmail(email: string): (User & { passwordHash?: string }) | undefined {
    return this.state.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  }

  public createUser(data: Omit<User, 'id' | 'createdAt' | 'updatedAt'>, passwordPlain: string, actorUserId: string): User {
    const existing = this.getUserByEmail(data.email);
    if (existing) throw new Error('User with this email already exists');

    const newUser: any = {
      id: crypto.randomUUID(),
      ...data,
      passwordHash: this.hashPassword(passwordPlain),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.users.push(newUser);
    this.save();

    const { passwordHash, ...clean } = newUser;
    return clean;
  }

  public updateUser(id: string, updates: Partial<User> & { password?: string }, actorUserId: string): User {
    const idx = this.state.users.findIndex((u) => u.id === id);
    if (idx === -1) throw new Error('User not found');

    const old = { ...this.state.users[idx] };
    const user = this.state.users[idx];

    if (updates.name) user.name = updates.name;
    if (updates.role) user.role = updates.role;
    if (updates.isActive !== undefined) {
      user.isActive = updates.isActive;
      if (!updates.isActive) {
        this.revokeAllUserSessions(id);
      }
    }
    if (updates.password) {
      (user as any).passwordHash = this.hashPassword(updates.password);
      user.mustChangePassword = false;
      this.revokeAllUserSessions(id);
    }
    user.updatedAt = new Date().toISOString();

    this.save();
    const { passwordHash, ...clean } = user as any;
    return clean;
  }

  public deleteUser(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.users.findIndex((u) => u.id === id);
    if (idx === -1) throw new Error('User not found');

    const user = this.state.users[idx];
    if (user.id === actorUserId) {
      throw new Error('You cannot delete your own account while logged in.');
    }

    const superAdmins = this.state.users.filter((u) => u.role === 'SUPER_ADMIN' && u.isActive);
    if (user.role === 'SUPER_ADMIN' && superAdmins.length <= 1) {
      throw new Error('Cannot delete the last remaining active Super Admin.');
    }

    // Reassign documents and payment allocations to the active administrator performing the deletion
    for (const doc of this.state.documents) {
      if (doc.uploadedByUserId === id) {
        doc.uploadedByUserId = actorUserId;
      }
    }
    for (const alloc of this.state.allocations) {
      if (alloc.allocatedByUserId === id) {
        alloc.allocatedByUserId = actorUserId;
      }
    }

    this.revokeAllUserSessions(id);

    const old = { ...user };
    this.state.users.splice(idx, 1);

    this.save();
    return { success: true };
  }

  // --- Financial Years ---
  public getFinancialYears(): FinancialYear[] {
    return this.state.financialYears;
  }

  public getCurrentFinancialYear(): FinancialYear {
    return this.state.financialYears.find((fy) => fy.isCurrent) || this.state.financialYears[0];
  }

  // --- Consignees ---
  public getConsignees(): ConsigneeMaster[] {
    return this.state.consignees;
  }

  public createConsignee(data: Omit<ConsigneeMaster, 'id' | 'createdAt' | 'updatedAt'>, actorUserId: string): ConsigneeMaster {
    const existing = this.state.consignees.find((c) => c.name.toLowerCase() === data.name.trim().toLowerCase());
    if (existing) throw new Error(`Consignee '${data.name}' already exists in master.`);

    const record: ConsigneeMaster = {
      id: crypto.randomUUID(),
      name: data.name.trim(),
      country: data.country.trim(),
      portOfDischarge: data.portOfDischarge || '',
      paymentTerms: data.paymentTerms || '',
      currency: data.currency || 'USD',
      contactEmail: data.contactEmail,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.consignees.push(record);
    this.save();
    return record;
  }

  public updateConsignee(id: string, updates: Partial<ConsigneeMaster>, actorUserId: string): ConsigneeMaster {
    const item = this.state.consignees.find((c) => c.id === id);
    if (!item) throw new Error('Consignee not found');

    const old = { ...item };
    Object.assign(item, updates, { updatedAt: new Date().toISOString() });

    this.save();
    return item;
  }

  public deleteConsignee(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.consignees.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error('Consignee not found');

    const consignee = this.state.consignees[idx];
    const referencedShipments = this.state.shipments.filter((s) => s.consigneeId === id);
    if (referencedShipments.length > 0) {
      throw new Error(
        `Cannot delete Consignee "${consignee.name}": It is referenced by ${referencedShipments.length} export shipment(s) (e.g. ${referencedShipments[0].invoiceNumber}). You must reassign those shipments or deactivate the consignee instead.`
      );
    }

    const old = { ...this.state.consignees[idx] };
    this.state.consignees.splice(idx, 1);

    this.save();
    return { success: true };
  }

  // --- Bank Master ---
  public getBanks(): BankMaster[] {
    return this.state.banks;
  }

  public createBank(data: Omit<BankMaster, 'id' | 'createdAt' | 'updatedAt'>, actorUserId: string): BankMaster {
    const existing = this.state.banks.find((b) => b.name.toLowerCase() === data.name.trim().toLowerCase());
    if (existing) throw new Error(`Bank '${data.name}' already exists.`);

    const record: BankMaster = {
      id: crypto.randomUUID(),
      name: data.name.trim(),
      branch: data.branch || '',
      adCode: data.adCode || '',
      ifscCode: data.ifscCode || '',
      swiftCode: data.swiftCode || '',
      accountNumber: data.accountNumber || '',
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.banks.push(record);
    this.save();
    return record;
  }

  public updateBank(id: string, updates: Partial<BankMaster>, actorUserId: string): BankMaster {
    const item = this.state.banks.find((b) => b.id === id);
    if (!item) throw new Error('Bank not found');

    const old = { ...item };
    Object.assign(item, updates, { updatedAt: new Date().toISOString() });

    this.save();
    return item;
  }

  public deleteBank(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.banks.findIndex((b) => b.id === id);
    if (idx === -1) throw new Error('Bank not found');

    const bank = this.state.banks[idx];
    const referencedPayments = this.state.payments.filter((p) => p.bankId === id);
    if (referencedPayments.length > 0) {
      throw new Error(
        `Cannot delete Bank "${bank.name}": It is referenced by ${referencedPayments.length} FIRC payment(s) (e.g. IRM ${referencedPayments[0].irmNumber}). You must reassign those payments or deactivate the bank instead.`
      );
    }

    const old = { ...this.state.banks[idx] };
    this.state.banks.splice(idx, 1);

    this.save();
    return { success: true };
  }

  // --- Shipments ---
  public getShipments(filters?: {
    financialYearId?: string;
    consigneeId?: string;
    paymentStatus?: string;
    reviewStatus?: string;
    search?: string;
    includeArchived?: boolean;
  }): Shipment[] {
    let list = this.state.shipments;

    if (!filters?.includeArchived) {
      list = list.filter((s) => !s.isArchived);
    }

    if (filters?.financialYearId && filters.financialYearId !== 'ALL') {
      list = list.filter((s) => s.financialYearId === filters.financialYearId);
    }
    if (filters?.consigneeId) {
      list = list.filter((s) => s.consigneeId === filters.consigneeId);
    }
    if (filters?.paymentStatus) {
      list = list.filter((s) => s.paymentStatus === filters.paymentStatus);
    }
    if (filters?.reviewStatus) {
      list = list.filter((s) => s.reviewStatus === filters.reviewStatus);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase().trim();
      list = list.filter((s) => {
        const consignee = this.state.consignees.find((c) => c.id === s.consigneeId);
        return (
          s.invoiceNumber.toLowerCase().includes(q) ||
          s.normalizedInvoiceKey.toLowerCase().includes(q) ||
          s.shippingBillNumber.toLowerCase().includes(q) ||
          (s.blNumber && s.blNumber.toLowerCase().includes(q)) ||
          (s.portCode && s.portCode.toLowerCase().includes(q)) ||
          (consignee && consignee.name.toLowerCase().includes(q)) ||
          (s.remarks && s.remarks.toLowerCase().includes(q))
        );
      });
    }

    // Hydrate relational calculated fields
    return list.map((s) => this.hydrateShipment(s));
  }

  public getShipmentById(id: string): Shipment | undefined {
    const shipment = this.state.shipments.find((s) => s.id === id);
    if (!shipment) return undefined;
    return this.hydrateShipment(shipment);
  }

  public getShipmentByNormalizedKey(normalizedKey: string, financialYearId: string): Shipment | undefined {
    const shipment = this.state.shipments.find(
      (s) => s.normalizedInvoiceKey === normalizedKey && s.financialYearId === financialYearId
    );
    if (!shipment) return undefined;
    return this.hydrateShipment(shipment);
  }

  private hydrateShipment(shipment: Shipment): Shipment {
    const allocations = this.state.allocations.filter((a) => a.shipmentId === shipment.id);
    const documents = this.state.documents.filter((d) => d.shipmentId === shipment.id && d.isCurrent);
    const incentives = this.state.incentives.filter((i) => i.shipmentId === shipment.id);
    const brcRecord = this.state.brcRecords.find((b) => b.shipmentId === shipment.id);
    const consignee = this.state.consignees.find((c) => c.id === shipment.consigneeId);
    const fy = this.state.financialYears.find((f) => f.id === shipment.financialYearId);

    return hydrateShipmentDto({
      shipment,
      consigneeName: consignee?.name,
      financialYearLabel: fy?.label,
      allocations: allocations.map((a) => {
        const p = this.state.payments.find((pm) => pm.id === a.paymentId);
        return { ...a, paymentIrm: p?.irmNumber, exchangeRate: p?.exchangeRate ?? null };
      }),
      documents,
      incentives,
      brcRecord,
    });
  }

  /**
   * Creates a shipment enforcing:
   * 1. Unique normalized invoice key within financial year.
   * 2. Mandatory FIRC rule: A valid FIRC/payment record must be linked before a shipment can be saved.
   */
  public createShipment(
    data: {
      financialYearId: string;
      invoiceNumber: string;
      invoiceDate: string;
      consigneeId: string;
      portCode: string;
      packageCount?: number;
      invoiceValueUsd: number;
      shippingBillNumber: string;
      shippingBillDate: string;
      sbExchangeRate: number;
      fobValueInr: number;
      blNumber?: string;
      blDate?: string;
      vesselName?: string;
      remarks?: string;
      reviewStatus?: Shipment['reviewStatus'];
      // Initial FIRC linking (mandatory rule)
      initialFircPaymentId?: string;
      initialFircAllocationAmount?: number;
      initialFircDocumentUploaded?: boolean;
      // Initial incentives
      incentives?: {
        dbkClaimed?: number;
        rodtepClaimed?: number;
        rosctlClaimed?: number;
      };
      // Initial BRC
      brc?: {
        uploadMode?: 'SINGLE' | 'MULTIPLE';
        statutoryDeadline?: string;
        remarks?: string;
      };
    },
    actorUserId: string
  ): Shipment {
    const normalizedKey = normalizeInvoiceKey(data.invoiceNumber);

    // Rule: Duplicate check within same FY
    const duplicate = this.state.shipments.find(
      (s) => s.financialYearId === data.financialYearId && s.normalizedInvoiceKey === normalizedKey
    );
    if (duplicate) {
      throw new Error(
        `Duplicate Invoice Identity: An invoice with key '${normalizedKey}' already exists in Financial Year '${data.financialYearId}'. (Existing: ${duplicate.invoiceNumber})`
      );
    }

    const hasFircEvidence = Boolean(data.initialFircPaymentId || data.initialFircDocumentUploaded);
    if (!hasFircEvidence) {
      throw new Error(
        'Mandatory Rule Violation: A valid FIRC/payment document or IRM reference must be linked before saving a shipment.'
      );
    }

    const shipmentId = crypto.randomUUID();
    const newShipment: Shipment = {
      id: shipmentId,
      financialYearId: data.financialYearId,
      invoiceNumber: data.invoiceNumber.trim(),
      normalizedInvoiceKey: normalizedKey,
      invoiceDate: data.invoiceDate || new Date().toISOString().split('T')[0],
      consigneeId: data.consigneeId || this.state.consignees[0]?.id || '',
      portCode: (data.portCode || 'INNSA1').trim().toUpperCase(),
      packageCount: data.packageCount || 0,
      invoiceValueUsd: Number(data.invoiceValueUsd || 0),
      shippingBillNumber: (data.shippingBillNumber || 'PENDING').trim(),
      shippingBillDate: data.shippingBillDate || new Date().toISOString().split('T')[0],
      sbExchangeRate: Number(data.sbExchangeRate || 84.5),
      fobValueInr: Number(data.fobValueInr || Math.round(Number(data.invoiceValueUsd || 0) * Number(data.sbExchangeRate || 84.5) * 100) / 100),
      blNumber: data.blNumber?.trim(),
      blDate: data.blDate,
      vesselName: data.vesselName?.trim(),
      remarks: data.remarks?.trim(),
      paymentStatus: 'UNPAID',
      reviewStatus: data.reviewStatus || 'CONFIRMED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const initialShipmentsLen = this.state.shipments.length;
    const initialIncentivesLen = this.state.incentives.length;
    const initialBrcLen = this.state.brcRecords.length;

    try {
      this.state.shipments.push(newShipment);

      // Create default incentive records
      if (data.incentives) {
        if (data.incentives.dbkClaimed !== undefined && data.incentives.dbkClaimed >= 0) {
          this.state.incentives.push({
            id: crypto.randomUUID(),
            shipmentId,
            type: 'DRAWBACK',
            claimedAmount: Number(data.incentives.dbkClaimed),
            status: 'PENDING',
            receivedAmount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        if (data.incentives.rodtepClaimed !== undefined && data.incentives.rodtepClaimed >= 0) {
          this.state.incentives.push({
            id: crypto.randomUUID(),
            shipmentId,
            type: 'RODTEP',
            claimedAmount: Number(data.incentives.rodtepClaimed),
            status: 'PENDING',
            receivedAmount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        if (data.incentives.rosctlClaimed !== undefined && data.incentives.rosctlClaimed >= 0) {
          this.state.incentives.push({
            id: crypto.randomUUID(),
            shipmentId,
            type: 'ROSCTL',
            claimedAmount: Number(data.incentives.rosctlClaimed),
            status: 'PENDING',
            receivedAmount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      }

      // Create default BRC record
      const statutoryDays = this.state.settings.statutoryBrcDays || 270;
      const sbDate = new Date(data.shippingBillDate);
      const defaultDeadline = new Date(sbDate.getTime() + statutoryDays * 86400000).toISOString().split('T')[0];

      this.state.brcRecords.push({
        id: crypto.randomUUID(),
        shipmentId,
        uploadMode: data.brc?.uploadMode || 'SINGLE',
        statutoryDeadline: data.brc?.statutoryDeadline || defaultDeadline,
        status: 'PENDING',
        remarks: data.brc?.remarks,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Handle initial FIRC payment allocation if provided (transactional)
      if (data.initialFircPaymentId) {
        const allocAmount = data.initialFircAllocationAmount || data.invoiceValueUsd;
        this.allocatePayment(
          {
            paymentId: data.initialFircPaymentId,
            shipmentId,
            allocatedAmountUsd: allocAmount,
            notes: 'Initial allocation on shipment creation',
          },
          actorUserId
        );
      }

      this.save();
      return this.hydrateShipment(newShipment);
    } catch (err) {
      this.state.shipments.splice(initialShipmentsLen);
      this.state.incentives.splice(initialIncentivesLen);
      this.state.brcRecords.splice(initialBrcLen);
      throw err;
    }
  }

  public updateShipment(id: string, updates: Partial<Shipment>, actorUserId: string): Shipment {
    const idx = this.state.shipments.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('Shipment not found');

    const old = { ...this.state.shipments[idx] };
    const shipment = this.state.shipments[idx];

    if (updates.invoiceNumber && updates.invoiceNumber !== shipment.invoiceNumber) {
      const newKey = normalizeInvoiceKey(updates.invoiceNumber);
      const fyId = updates.financialYearId || shipment.financialYearId;
      const dup = this.state.shipments.find(
        (s) => s.id !== id && s.financialYearId === fyId && s.normalizedInvoiceKey === newKey
      );
      if (dup) throw new Error(`Another shipment with key '${newKey}' exists in this Financial Year.`);
      shipment.invoiceNumber = updates.invoiceNumber.trim();
      shipment.normalizedInvoiceKey = newKey;
    }

    if (updates.consigneeId) shipment.consigneeId = updates.consigneeId;
    if (updates.financialYearId) shipment.financialYearId = updates.financialYearId;
    if (updates.invoiceDate) shipment.invoiceDate = updates.invoiceDate;
    if (updates.portCode) shipment.portCode = updates.portCode.trim().toUpperCase();
    if (updates.packageCount !== undefined) shipment.packageCount = updates.packageCount;
    if (updates.invoiceValueUsd !== undefined) {
      const newInvVal = Number(updates.invoiceValueUsd);
      if (newInvVal < 0) throw new Error('Invoice Value cannot be negative.');
      const currentAllocs = this.state.allocations.filter((a) => a.shipmentId === id);
      const totalAllocated = currentAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      if (newInvVal < totalAllocated - 0.001) {
        throw new Error(
          `Cannot reduce Invoice Value ($${newInvVal.toFixed(2)}) below already allocated payment amount ($${totalAllocated.toFixed(2)}) on Invoice ${shipment.invoiceNumber}. Please reverse excess payment allocations first.`
        );
      }
      shipment.invoiceValueUsd = newInvVal;
    }
    if (updates.shippingBillNumber) shipment.shippingBillNumber = updates.shippingBillNumber.trim();
    if (updates.shippingBillDate) shipment.shippingBillDate = updates.shippingBillDate;
    if (updates.sbExchangeRate !== undefined) shipment.sbExchangeRate = Number(updates.sbExchangeRate);
    if (updates.fobValueInr !== undefined) {
      shipment.fobValueInr = Number(updates.fobValueInr);
    } else if (updates.invoiceValueUsd !== undefined || updates.sbExchangeRate !== undefined) {
      // Recalculate FOB INR when USD or rate changes and FOB not explicitly provided
      shipment.fobValueInr = Math.round(shipment.invoiceValueUsd * shipment.sbExchangeRate * 100) / 100;
    }
    if (updates.blNumber !== undefined) shipment.blNumber = updates.blNumber ? updates.blNumber.trim() : undefined;
    if (updates.blDate !== undefined) shipment.blDate = updates.blDate || undefined;
    if (updates.vesselName !== undefined) shipment.vesselName = updates.vesselName ? updates.vesselName.trim() : undefined;
    if (updates.remarks !== undefined) shipment.remarks = updates.remarks ? updates.remarks.trim() : undefined;
    if (updates.reviewStatus) shipment.reviewStatus = updates.reviewStatus;

    const anyUpdates = updates as any;
    if (anyUpdates.consigneeName) {
      const match = this.state.consignees.find(
        (c) => c.name.toLowerCase() === anyUpdates.consigneeName.trim().toLowerCase()
      );
      if (match) shipment.consigneeId = match.id;
    }

    // Incentive fields updates
    if (anyUpdates.dbkClaimed !== undefined || anyUpdates.dbkReceived !== undefined || anyUpdates.dbkReceivedDate !== undefined) {
      let inc = this.state.incentives.find((i) => i.shipmentId === id && i.type === 'DRAWBACK');
      if (!inc) {
        const newInc = {
          id: crypto.randomUUID(),
          shipmentId: id,
          type: 'DRAWBACK' as const,
          claimedAmount: 0,
          receivedAmount: 0,
          status: 'PENDING' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.state.incentives.push(newInc);
        inc = newInc;
      }
      if (anyUpdates.dbkClaimed !== undefined) inc.claimedAmount = Number(anyUpdates.dbkClaimed);
      if (anyUpdates.dbkReceived !== undefined) inc.receivedAmount = Number(anyUpdates.dbkReceived);
      if (anyUpdates.dbkReceivedDate !== undefined) inc.receivedDate = anyUpdates.dbkReceivedDate || undefined;
      inc.status = inc.receivedAmount >= inc.claimedAmount && inc.claimedAmount > 0 ? 'RECEIVED' : inc.receivedAmount > 0 ? 'PART_RECEIVED' : 'PENDING';
      inc.updatedAt = new Date().toISOString();
    }

    if (anyUpdates.rodtepClaimed !== undefined || anyUpdates.rodtepReceived !== undefined) {
      let inc = this.state.incentives.find((i) => i.shipmentId === id && i.type === 'RODTEP');
      if (!inc) {
        inc = {
          id: crypto.randomUUID(),
          shipmentId: id,
          type: 'RODTEP',
          claimedAmount: 0,
          receivedAmount: 0,
          status: 'PENDING',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.state.incentives.push(inc);
      }
      if (anyUpdates.rodtepClaimed !== undefined) inc.claimedAmount = Number(anyUpdates.rodtepClaimed);
      if (anyUpdates.rodtepReceived !== undefined) inc.receivedAmount = Number(anyUpdates.rodtepReceived);
      inc.status = inc.receivedAmount >= inc.claimedAmount && inc.claimedAmount > 0 ? 'RECEIVED' : inc.receivedAmount > 0 ? 'PART_RECEIVED' : 'PENDING';
      inc.updatedAt = new Date().toISOString();
    }

    if (anyUpdates.rosctlClaimed !== undefined || anyUpdates.rosctlReceived !== undefined) {
      let inc = this.state.incentives.find((i) => i.shipmentId === id && i.type === 'ROSCTL');
      if (!inc) {
        inc = {
          id: crypto.randomUUID(),
          shipmentId: id,
          type: 'ROSCTL',
          claimedAmount: 0,
          receivedAmount: 0,
          status: 'PENDING',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.state.incentives.push(inc);
      }
      if (anyUpdates.rosctlClaimed !== undefined) inc.claimedAmount = Number(anyUpdates.rosctlClaimed);
      if (anyUpdates.rosctlReceived !== undefined) inc.receivedAmount = Number(anyUpdates.rosctlReceived);
      inc.status = inc.receivedAmount >= inc.claimedAmount && inc.claimedAmount > 0 ? 'RECEIVED' : inc.receivedAmount > 0 ? 'PART_RECEIVED' : 'PENDING';
      inc.updatedAt = new Date().toISOString();
    }

    // BRC fields update
    if (anyUpdates.brcNumber !== undefined || anyUpdates.brcDate !== undefined) {
      let brc = this.state.brcRecords.find((b) => b.shipmentId === id);
      if (!brc) {
        brc = {
          id: crypto.randomUUID(),
          shipmentId: id,
          uploadMode: 'SINGLE',
          status: 'PENDING',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.state.brcRecords.push(brc);
      }
      if (anyUpdates.brcNumber !== undefined) brc.brcNumber = anyUpdates.brcNumber || undefined;
      if (anyUpdates.brcDate !== undefined) brc.realisationDate = anyUpdates.brcDate || undefined;
      if (brc.brcNumber) brc.status = 'REALISED';
      brc.updatedAt = new Date().toISOString();
    }

    // Recalculate paymentStatus based on current allocations and new invoiceValueUsd
    const currentAllocs = this.state.allocations.filter((a) => a.shipmentId === id);
    const totalPaid = currentAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
    if (totalPaid >= shipment.invoiceValueUsd && shipment.invoiceValueUsd > 0) {
      shipment.paymentStatus = totalPaid > shipment.invoiceValueUsd ? 'EXCESS_RECEIVED' : 'FULLY_PAID';
    } else if (totalPaid > 0) {
      shipment.paymentStatus = 'PART_PAID';
    } else {
      shipment.paymentStatus = 'UNPAID';
    }

    shipment.updatedAt = new Date().toISOString();


    this.save();
    return this.hydrateShipment(shipment);
  }

  public archiveShipment(id: string, reason: string | undefined, actorUserId: string): Shipment {
    const idx = this.state.shipments.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('Shipment not found');

    const shipment = this.state.shipments[idx];
    const old = { ...shipment };

    shipment.isArchived = true;
    shipment.archivedAt = new Date().toISOString();
    shipment.archivedBy = actorUserId;
    shipment.archivedReason = reason?.trim() || 'Archived by administrator';
    shipment.updatedAt = new Date().toISOString();

    this.save();
    return this.hydrateShipment(shipment);
  }

  public restoreShipment(id: string, actorUserId: string): Shipment {
    const idx = this.state.shipments.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('Shipment not found');

    const shipment = this.state.shipments[idx];
    const old = { ...shipment };

    shipment.isArchived = false;
    shipment.archivedAt = undefined;
    shipment.archivedBy = undefined;
    shipment.archivedReason = undefined;
    shipment.updatedAt = new Date().toISOString();

    this.save();
    return this.hydrateShipment(shipment);
  }

  public deleteShipment(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.shipments.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('Shipment not found');

    const shipment = this.state.shipments[idx];

    // Dependency protection rule: active allocations
    const allocs = this.state.allocations.filter((a) => a.shipmentId === id);
    if (allocs.length > 0) {
      const totalPaid = allocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      throw new Error(
        `Cannot delete shipment "${shipment.invoiceNumber}": It has active FIRC payment allocations totaling $${totalPaid.toFixed(2)} USD across ${allocs.length} payment(s). Please reverse all payment allocations first, or archive this shipment.`
      );
    }

    // Dependency protection rule: received incentives
    const receivedIncentives = this.state.incentives.filter((i) => i.shipmentId === id && Number(i.receivedAmount) > 0);
    if (receivedIncentives.length > 0) {
      throw new Error(
        `Cannot delete shipment "${shipment.invoiceNumber}": Incentive funds have already been credited for this shipment. Deletion is blocked to preserve statutory customs history. Please archive this shipment instead.`
      );
    }

    // Dependency protection rule: realised BRC
    const brc = this.state.brcRecords.find((b) => b.shipmentId === id);
    if (brc && (brc.status === 'REALISED' || Boolean(brc.brcNumber))) {
      throw new Error(
        `Cannot delete shipment "${shipment.invoiceNumber}": Bank Realisation Certificate (${brc.brcNumber || 'eBRC'}) is marked REALISED. Deletion of realised export records is prohibited under DGFT regulations. Please archive this shipment instead.`
      );
    }

    const old = { ...this.state.shipments[idx] };

    // Remove shipment
    this.state.shipments.splice(idx, 1);

    // Remove associated items
    this.state.invoiceItems = this.state.invoiceItems.filter((i) => i.shipmentId !== id);

    // Remove associated incentives (all unclaimed)
    this.state.incentives = this.state.incentives.filter((i) => i.shipmentId !== id);

    // Remove associated BRC (unrealised)
    this.state.brcRecords = this.state.brcRecords.filter((b) => b.shipmentId !== id);

    // Remove or unlink associated documents
    this.state.documents = this.state.documents.filter((d) => d.shipmentId !== id);


    this.save();
    return { success: true };
  }

  // --- Payments & Concurrency-Safe Allocations ---
  public getPayments(): Payment[] {
    return this.state.payments.map((p) => this.hydratePayment(p));
  }

  public getPaymentById(id: string): Payment | undefined {
    const payment = this.state.payments.find((p) => p.id === id);
    if (!payment) return undefined;
    return this.hydratePayment(payment);
  }

  private hydratePayment(payment: Payment): Payment {
    const allocations = this.state.allocations.filter((a) => a.paymentId === payment.id);
    const documents = this.state.documents.filter((d) => d.paymentId === payment.id && d.isCurrent);
    const bank = this.state.banks.find((b) => b.id === payment.bankId);

    return hydratePaymentDto({
      payment,
      bankName: bank?.name,
      allocations: allocations.map((a) => {
        const s = this.state.shipments.find((sh) => sh.id === a.shipmentId);
        return { ...a, shipmentInvoiceNo: s?.invoiceNumber };
      }),
      documents,
    });
  }

  public createPayment(
    data: {
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
    },
    actorUserId: string
  ): Payment {
    const cleanIrm = data.irmNumber.trim().toUpperCase();
    const existing = this.state.payments.find((p) => p.irmNumber.toUpperCase() === cleanIrm);
    if (existing) {
      throw new Error(`Inward Remittance / IRM '${cleanIrm}' already exists in payments register.`);
    }

    const paymentId = crypto.randomUUID();
    const newPayment: Payment = {
      id: paymentId,
      irmNumber: cleanIrm,
      senderReference: data.senderReference?.trim(),
      currency: data.currency || 'USD',
      verifiedAmount: Number(data.verifiedAmount),
      inrAmount: data.inrAmount ? Number(data.inrAmount) : undefined,
      exchangeRate: data.exchangeRate ? Number(data.exchangeRate) : undefined,
      valueDate: data.valueDate,
      creditDate: data.creditDate,
      fircIssueDate: data.fircIssueDate,
      bankId: data.bankId,
      purposeCode: data.purposeCode || 'P0102',
      remarks: data.remarks?.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.payments.push(newPayment);

    this.save();
    return this.hydratePayment(newPayment);
  }

  public updatePayment(
    id: string,
    updates: Partial<Payment>,
    actorUserId: string
  ): Payment {
    const idx = this.state.payments.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('Payment not found');

    const old = { ...this.state.payments[idx] };
    const payment = this.state.payments[idx];

    if (updates.irmNumber && updates.irmNumber !== payment.irmNumber) {
      const cleanIrm = updates.irmNumber.trim().toUpperCase();
      const dup = this.state.payments.find((p) => p.id !== id && p.irmNumber.toUpperCase() === cleanIrm);
      if (dup) throw new Error(`Inward Remittance / IRM '${cleanIrm}' already exists.`);
      payment.irmNumber = cleanIrm;
    }

    if (updates.senderReference !== undefined) payment.senderReference = updates.senderReference?.trim();
    if (updates.verifiedAmount !== undefined) {
      const newAmt = Number(updates.verifiedAmount);
      if (newAmt <= 0) throw new Error('Payment verified amount must be greater than zero.');
      const currentAllocs = this.state.allocations.filter((a) => a.paymentId === id);
      const totalAllocated = currentAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      if (newAmt < totalAllocated - 0.001) {
        throw new Error(
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


    this.save();
    return this.hydratePayment(payment);
  }

  public deletePayment(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.payments.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('Payment not found');

    const payment = this.state.payments[idx];

    // Dependency check: block deletion if allocations exist
    const paymentAllocs = this.state.allocations.filter((a) => a.paymentId === id);
    if (paymentAllocs.length > 0) {
      const totalAllocated = paymentAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      throw new Error(
        `Cannot delete FIRC payment "${payment.irmNumber}": It has ${paymentAllocs.length} active allocation(s) totaling $${totalAllocated.toFixed(2)} USD. Please reverse all invoice allocations first before deleting this payment.`
      );
    }

    const old = { ...this.state.payments[idx] };

    // Unlink documents
    this.state.documents = this.state.documents.filter((d) => d.paymentId !== id);

    // Remove payment
    this.state.payments.splice(idx, 1);


    this.save();
    return { success: true };
  }

  /**
   * Concurrency-safe Payment Allocation Method
   * Section 9 Rules:
   * 1. Available Payment Balance = Verified Payment Amount − Active Allocations.
   * 2. Each new allocation must be no greater than:
   *    - The remaining available payment balance.
   *    - The invoice balance due.
   * 3. Concurrency lock to prevent double-spending the same payment.
   */
  public allocatePayment(
    data: {
      paymentId: string;
      shipmentId: string;
      allocatedAmountUsd: number;
      notes?: string;
    },
    actorUserId: string
  ): PaymentAllocation {
    const { paymentId, shipmentId, allocatedAmountUsd, notes } = data;
    const amount = Number(allocatedAmountUsd);

    if (amount <= 0) {
      throw new Error('Allocation amount must be strictly greater than 0.');
    }

    // Acquire lock for this payment
    if (paymentLocks.has(paymentId)) {
      throw new Error('Concurrent payment transaction in progress. Please retry in a moment.');
    }
    paymentLocks.add(paymentId);

    try {
      const payment = this.state.payments.find((p) => p.id === paymentId);
      if (!payment) throw new Error('Payment record not found.');

      const shipment = this.state.shipments.find((s) => s.id === shipmentId);
      if (!shipment) throw new Error('Shipment record not found.');

      // 1. Calculate active allocations on this payment
      const existingPaymentAllocs = this.state.allocations.filter((a) => a.paymentId === paymentId);
      const totalAllocatedOnPayment = existingPaymentAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      const availablePaymentBalance = Number(payment.verifiedAmount) - totalAllocatedOnPayment;

      if (amount > availablePaymentBalance + 0.001) {
        throw new Error(
          `Over-allocation rejected: Requested $${amount.toFixed(2)} exceeds available payment balance of $${availablePaymentBalance.toFixed(2)} on FIRC ${payment.irmNumber}.`
        );
      }

      // 2. Calculate remaining invoice balance due
      const existingShipmentAllocs = this.state.allocations.filter((a) => a.shipmentId === shipmentId);
      const totalAllocatedToShipment = existingShipmentAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      const invoiceBalanceDue = Number(shipment.invoiceValueUsd) - totalAllocatedToShipment;

      if (amount > invoiceBalanceDue + 0.001) {
        throw new Error(
          `Over-allocation rejected: Requested $${amount.toFixed(2)} exceeds remaining invoice balance due of $${invoiceBalanceDue.toFixed(2)} on Invoice ${shipment.invoiceNumber}.`
        );
      }

      // 3. Create allocation
      const user = this.getUserById(actorUserId);
      const allocation: PaymentAllocation = {
        id: crypto.randomUUID(),
        paymentId,
        shipmentId,
        allocatedAmountUsd: amount,
        notes: notes?.trim(),
        allocatedAt: new Date().toISOString(),
        allocatedByUserId: actorUserId,
        allocatedByName: user?.name || 'Admin',
      };

      this.state.allocations.push(allocation);

      // 4. Update shipment payment status
      const newTotalShipmentPaid = totalAllocatedToShipment + amount;
      if (newTotalShipmentPaid >= Number(shipment.invoiceValueUsd)) {
        shipment.paymentStatus = 'FULLY_PAID';
      } else {
        shipment.paymentStatus = 'PART_PAID';
      }
      shipment.updatedAt = new Date().toISOString();


      this.save();
      return allocation;
    } finally {
      paymentLocks.delete(paymentId);
    }
  }

  public deallocatePayment(allocationId: string, actorUserId: string) {
    const idx = this.state.allocations.findIndex((a) => a.id === allocationId);
    if (idx === -1) throw new Error('Allocation not found');

    const alloc = this.state.allocations[idx];
    const shipment = this.state.shipments.find((s) => s.id === alloc.shipmentId);

    this.state.allocations.splice(idx, 1);

    if (shipment) {
      // Recalculate shipment status
      const remainingAllocs = this.state.allocations.filter((a) => a.shipmentId === shipment.id);
      const totalPaid = remainingAllocs.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
      if (totalPaid >= Number(shipment.invoiceValueUsd) && Number(shipment.invoiceValueUsd) > 0) {
        shipment.paymentStatus = 'FULLY_PAID';
      } else if (totalPaid > 0) {
        shipment.paymentStatus = 'PART_PAID';
      } else {
        shipment.paymentStatus = 'UNPAID';
      }
      shipment.updatedAt = new Date().toISOString();
    }


    this.save();
    return { success: true };
  }

  // --- Incentives ---
  public createIncentive(
    data: {
      shipmentId: string;
      type: IncentiveRecord['type'];
      claimedAmount: number;
      receivedAmount?: number;
      receivedDate?: string;
      scrollNumber?: string;
      remarks?: string;
    },
    actorUserId: string
  ): IncentiveRecord {
    const shipment = this.state.shipments.find((s) => s.id === data.shipmentId);
    if (!shipment) throw new Error('Shipment not found');

    const claimed = Number(data.claimedAmount || 0);
    const received = Number(data.receivedAmount || 0);
    const status = received >= claimed && claimed > 0 ? 'RECEIVED' : received > 0 ? 'PART_RECEIVED' : 'PENDING';

    const record: IncentiveRecord = {
      id: crypto.randomUUID(),
      shipmentId: data.shipmentId,
      type: data.type,
      claimedAmount: claimed,
      receivedAmount: received,
      receivedDate: data.receivedDate,
      scrollNumber: data.scrollNumber?.trim(),
      remarks: data.remarks?.trim(),
      status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.incentives.push(record);
    this.save();
    return {
      ...record,
      outstandingBalance: Math.max(0, record.claimedAmount - record.receivedAmount),
    };
  }

  public updateIncentive(
    id: string,
    updates: {
      claimedAmount?: number;
      receivedAmount?: number;
      receivedDate?: string;
      status?: IncentiveRecord['status'];
      scrollNumber?: string;
      remarks?: string;
    },
    actorUserId: string
  ): IncentiveRecord {
    const item = this.state.incentives.find((i) => i.id === id);
    if (!item) throw new Error('Incentive record not found');

    const old = { ...item };
    if (updates.claimedAmount !== undefined) item.claimedAmount = Number(updates.claimedAmount);
    if (updates.receivedAmount !== undefined) item.receivedAmount = Number(updates.receivedAmount);
    if (updates.receivedDate !== undefined) item.receivedDate = updates.receivedDate;
    if (updates.scrollNumber !== undefined) item.scrollNumber = updates.scrollNumber;
    if (updates.remarks !== undefined) item.remarks = updates.remarks;

    // Derive status if not explicitly set
    if (updates.status) {
      item.status = updates.status;
    } else if (item.receivedAmount >= item.claimedAmount && item.claimedAmount > 0) {
      item.status = 'RECEIVED';
    } else if (item.receivedAmount > 0) {
      item.status = 'PART_RECEIVED';
    } else {
      item.status = 'PENDING';
    }

    item.updatedAt = new Date().toISOString();


    this.save();
    return {
      ...item,
      outstandingBalance: Math.max(0, item.claimedAmount - item.receivedAmount),
    };
  }

  public deleteIncentive(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.incentives.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error('Incentive record not found');

    const item = this.state.incentives[idx];
    if (Number(item.receivedAmount) > 0) {
      throw new Error(
        `Cannot delete incentive claim (${item.type}): Funds of ₹${Number(item.receivedAmount).toLocaleString()} have already been credited. Deletion of received incentive funds is prohibited. Please adjust amounts or record a correction instead.`
      );
    }

    const old = { ...this.state.incentives[idx] };
    this.state.incentives.splice(idx, 1);


    this.save();
    return { success: true };
  }

  // --- BRC Management ---
  public updateBrcRecord(
    idOrShipmentId: string,
    updates: {
      brcNumber?: string;
      issueDate?: string;
      realisationDate?: string;
      realisedAmount?: number;
      realisedCurrency?: string;
      uploadMode?: 'SINGLE' | 'MULTIPLE';
      statutoryDeadline?: string;
      status?: BrcRecord['status'];
      remarks?: string;
    },
    actorUserId: string
  ): BrcRecord {
    let item = this.state.brcRecords.find((b) => b.id === idOrShipmentId || b.shipmentId === idOrShipmentId);
    if (!item) {
      item = {
        id: crypto.randomUUID(),
        shipmentId: idOrShipmentId,
        uploadMode: updates.uploadMode || 'SINGLE',
        status: updates.status || 'PENDING',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.state.brcRecords.push(item);
    }

    const old = { ...item };
    if (updates.brcNumber !== undefined) item.brcNumber = updates.brcNumber?.trim();
    if (updates.issueDate !== undefined) item.issueDate = updates.issueDate;
    if (updates.realisationDate !== undefined) item.realisationDate = updates.realisationDate;
    if (updates.realisedAmount !== undefined) item.realisedAmount = Number(updates.realisedAmount);
    if (updates.realisedCurrency !== undefined) item.realisedCurrency = updates.realisedCurrency;
    if (updates.uploadMode !== undefined) item.uploadMode = updates.uploadMode;
    if (updates.statutoryDeadline !== undefined) item.statutoryDeadline = updates.statutoryDeadline;
    if (updates.status !== undefined) item.status = updates.status;
    if (updates.remarks !== undefined) item.remarks = updates.remarks;

    // Check overdue
    if (item.status === 'PENDING' && item.statutoryDeadline) {
      if (new Date(item.statutoryDeadline) < new Date()) {
        item.status = 'OVERDUE';
      }
    }

    item.updatedAt = new Date().toISOString();


    this.save();
    return item;
  }

  public resetBrcRecord(idOrShipmentId: string, actorUserId: string): BrcRecord {
    const item = this.state.brcRecords.find((b) => b.id === idOrShipmentId || b.shipmentId === idOrShipmentId);
    if (!item) throw new Error('BRC record not found');
    const old = { ...item };
    item.brcNumber = undefined;
    item.issueDate = undefined;
    item.realisationDate = undefined;
    item.realisedAmount = undefined;
    item.status = 'PENDING';
    item.remarks = undefined;
    item.updatedAt = new Date().toISOString();

    this.save();
    return item;
  }

  // --- Documents & Private Storage ---
  public registerDocument(
    data: {
      shipmentId?: string;
      paymentId?: string;
      category: DocumentRecord['category'];
      originalFilename: string;
      storedPath: string;
      mimeType: string;
      fileSizeBytes: number;
      extractedData?: Record<string, any>;
      reviewStatus?: DocumentRecord['reviewStatus'];
      ocrApplied?: boolean;
      ocrConfidence?: number;
      ocrTextPreview?: string;
      extractionMethod?: any;
      extractedFieldsJson?: string;
    },
    actorUserId: string
  ): DocumentRecord {
    // If replacing an existing current document of same category on same shipment/payment, preserve version history
    const existing = this.state.documents.filter(
      (d) =>
        d.isCurrent &&
        d.category === data.category &&
        ((data.shipmentId && d.shipmentId === data.shipmentId) || (data.paymentId && d.paymentId === data.paymentId))
    );

    let nextVersion = 1;
    for (const doc of existing) {
      doc.isCurrent = false;
      doc.updatedAt = new Date().toISOString();
      if (doc.version >= nextVersion) nextVersion = doc.version + 1;
    }

    const user = this.getUserById(actorUserId);
    const newDoc: DocumentRecord = {
      id: crypto.randomUUID(),
      shipmentId: data.shipmentId,
      paymentId: data.paymentId,
      category: data.category,
      originalFilename: data.originalFilename,
      storedPath: data.storedPath,
      mimeType: data.mimeType,
      fileSizeBytes: data.fileSizeBytes,
      version: nextVersion,
      isCurrent: true,
      reviewStatus: data.reviewStatus || 'EXTRACTED',
      extractedData: data.extractedData,
      ocrApplied: data.ocrApplied,
      ocrConfidence: data.ocrConfidence,
      ocrTextPreview: data.ocrTextPreview,
      extractionMethod: data.extractionMethod,
      extractedFieldsJson: data.extractedFieldsJson,
      uploadedByUserId: actorUserId,
      uploadedByName: user?.name || 'Admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.documents.push(newDoc);

    this.save();
    return newDoc;
  }

  public getDocuments(filter?: { shipmentId?: string; paymentId?: string }): DocumentRecord[] {
    let docs = this.state.documents;
    if (filter?.shipmentId) docs = docs.filter((d) => d.shipmentId === filter.shipmentId);
    if (filter?.paymentId) docs = docs.filter((d) => d.paymentId === filter.paymentId);
    return docs;
  }

  public getDocumentById(id: string): DocumentRecord | undefined {
    return this.state.documents.find((d) => d.id === id);
  }

  public updateDocumentReviewStatus(id: string, status: DocumentRecord['reviewStatus'], actorUserId: string) {
    const doc = this.state.documents.find((d) => d.id === id);
    if (!doc) throw new Error('Document not found');

    const oldStatus = doc.reviewStatus;
    doc.reviewStatus = status;
    doc.updatedAt = new Date().toISOString();


    this.save();
    return doc;
  }

  public updateDocumentExtraction(
    id: string,
    updates: Partial<Pick<DocumentRecord, 'extractedData' | 'ocrApplied' | 'ocrConfidence' | 'ocrTextPreview' | 'extractionMethod' | 'reviewStatus'>>
  ): DocumentRecord | undefined {
    const doc = this.state.documents.find((d) => d.id === id);
    if (!doc) return undefined;
    Object.assign(doc, updates, { updatedAt: new Date().toISOString() });
    this.save();
    return doc;
  }

  public deleteDocument(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.documents.findIndex((d) => d.id === id);
    if (idx === -1) throw new Error('Document not found');
    const doc = this.state.documents[idx];
    const old = { ...doc };

    try {
      const fullPath = path.isAbsolute(doc.storedPath) ? doc.storedPath : path.resolve(doc.storedPath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (e) {
      console.warn('Could not remove file on disk:', e);
    }

    this.state.documents.splice(idx, 1);


    this.save();
    return { success: true };
  }

  // --- Asynchronous OCR Job Queue & Staging Store ---
  public getOcrJobs(filters?: { status?: OcrJobStatus; category?: DocumentCategory }): OcrJob[] {
    let list = this.state.ocrJobs || [];
    if (filters?.status) list = list.filter((j) => j.status === filters.status);
    if (filters?.category) list = list.filter((j) => j.category === filters.category);
    return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public getOcrJobById(id: string): OcrJob | undefined {
    return (this.state.ocrJobs || []).find((j) => j.id === id);
  }

  public enqueueOcrJob(
    data: {
      originalFilename: string;
      fileSizeBytes: number;
      category: DocumentCategory;
      financialYearId?: string;
      documentId?: string;
    },
    actorUserId: string
  ): OcrJob {
    if (!this.state.ocrJobs) this.state.ocrJobs = [];

    // Deduplication check: prevent duplicate active jobs for identical file within 10 minutes
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const existing = this.state.ocrJobs.find(
      (j) =>
        (j.status === 'PENDING' || j.status === 'PROCESSING') &&
        j.originalFilename === data.originalFilename &&
        j.category === data.category &&
        j.fileSizeBytes === data.fileSizeBytes &&
        new Date(j.createdAt).getTime() > tenMinutesAgo
    );
    if (existing) {
      return existing;
    }

    const job: OcrJob = {
      id: crypto.randomUUID(),
      documentId: data.documentId,
      originalFilename: data.originalFilename,
      fileSizeBytes: data.fileSizeBytes,
      category: data.category,
      financialYearId: data.financialYearId || this.getCurrentFinancialYear().id,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.ocrJobs.unshift(job);

    this.save();
    return job;
  }

  public updateOcrJob(id: string, updates: Partial<OcrJob>): OcrJob {
    const job = (this.state.ocrJobs || []).find((j) => j.id === id);
    if (!job) throw new Error('OCR job not found');

    Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    this.save();
    return job;
  }

  public retryOcrJob(id: string, actorUserId: string): OcrJob {
    const job = (this.state.ocrJobs || []).find((j) => j.id === id);
    if (!job) throw new Error('OCR job not found');

    job.status = 'PENDING';
    job.error = undefined;
    job.attempts = 0;
    job.lockedByWorkerId = undefined;
    job.lockedAt = undefined;
    job.leaseExpiresAt = undefined;
    job.updatedAt = new Date().toISOString();

    this.save();
    return job;
  }

  public deleteOcrJob(id: string, actorUserId: string): { success: boolean } {
    const idx = (this.state.ocrJobs || []).findIndex((j) => j.id === id);
    if (idx === -1) throw new Error('OCR job not found');

    const job = this.state.ocrJobs[idx];
    this.state.ocrJobs.splice(idx, 1);


    this.save();
    return { success: true };
  }

  /**
   * Database-level atomic job claiming with row lease locking strategy.
   * Atomically selects the next eligible job (PENDING, or PROCESSING with expired lease),
   * transitions it to PROCESSING, assigns lockedByWorkerId, lockedAt, and leaseExpiresAt.
   * Prevents multiple concurrent processes/workers from claiming the same job.
   */
  public claimNextOcrJob(workerId: string, leaseDurationMs = 60000): OcrJob | null {
    if (!this.state.ocrJobs) this.state.ocrJobs = [];

    const now = Date.now();
    // Eligible jobs:
    // 1) Status is PENDING and attempts < maxAttempts
    // 2) Status is PROCESSING, but lease has expired (worker crashed / abandoned) and attempts < maxAttempts
    const eligibleIndex = this.state.ocrJobs.findIndex((j) => {
      const isMaxAttempts = (j.attempts || 0) >= (j.maxAttempts || 3);
      if (isMaxAttempts) return false;

      if (j.status === 'PENDING') return true;

      if (j.status === 'PROCESSING') {
        if (!j.leaseExpiresAt) return true; // Dangling without lease
        const leaseTime = new Date(j.leaseExpiresAt).getTime();
        return leaseTime < now; // Lease expired!
      }

      return false;
    });

    if (eligibleIndex === -1) return null;

    const job = this.state.ocrJobs[eligibleIndex];
    job.status = 'PROCESSING';
    job.lockedByWorkerId = workerId;
    job.lockedAt = new Date().toISOString();
    job.leaseExpiresAt = new Date(now + leaseDurationMs).toISOString();
    job.attempts = (job.attempts || 0) + 1;
    job.updatedAt = new Date().toISOString();

    this.save();
    return { ...job };
  }

  /**
   * Extends the lease of an actively processing job so long-running OCR doesn't expire prematurely.
   */
  public renewOcrJobLease(jobId: string, workerId: string, additionalMs = 60000): boolean {
    const job = (this.state.ocrJobs || []).find((j) => j.id === jobId);
    if (!job || job.status !== 'PROCESSING' || job.lockedByWorkerId !== workerId) {
      return false;
    }

    job.leaseExpiresAt = new Date(Date.now() + additionalMs).toISOString();
    job.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /**
   * Commits the completion of an OCR job, verifying that the committing worker
   * still holds a valid unexpired lease on the job.
   */
  public completeOcrJob(
    jobId: string,
    workerId: string,
    result: {
      executionTimeMs: number;
      ocrApplied?: boolean;
      ocrConfidence?: number;
      ocrTextPreview?: string;
      extractionMethod?: 'PDF_TEXT' | 'LOCAL_OCR';
      candidateFields?: any;
      candidateDraft?: any;
    }
  ): OcrJob {
    const job = (this.state.ocrJobs || []).find((j) => j.id === jobId);
    if (!job) throw new Error('OCR job not found');

    // Lease verification guard: Prevent a slow or timed-out worker from committing if its lease expired or was reclaimed
    if (job.lockedByWorkerId && job.lockedByWorkerId !== workerId) {
      throw new Error(`Lease violation: OCR job ${jobId} was reclaimed by worker ${job.lockedByWorkerId}; commit rejected.`);
    }

    if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() < Date.now()) {
      throw new Error(`Lease expired: OCR job ${jobId} lease expired at ${job.leaseExpiresAt}; commit rejected.`);
    }

    job.status = 'COMPLETED';
    job.lockedByWorkerId = undefined;
    job.leaseExpiresAt = undefined;
    job.executionTimeMs = result.executionTimeMs;
    job.ocrApplied = result.ocrApplied;
    job.ocrConfidence = result.ocrConfidence;
    job.ocrTextPreview = result.ocrTextPreview;
    job.extractionMethod = result.extractionMethod;
    job.candidateFields = result.candidateFields;
    job.candidateDraft = result.candidateDraft;
    job.error = undefined;
    job.updatedAt = new Date().toISOString();

    this.save();
    return job;
  }

  /**
   * Fails or releases an OCR job when processing encounters an error or worker releases ownership.
   */
  public failOcrJob(jobId: string, workerId: string, errorMsg: string, executionTimeMs?: number): OcrJob {
    const job = (this.state.ocrJobs || []).find((j) => j.id === jobId);
    if (!job) throw new Error('OCR job not found');

    const maxAttempts = job.maxAttempts || 3;
    const isFinalFailure = (job.attempts || 0) >= maxAttempts;

    job.status = isFinalFailure ? 'FAILED' : 'PENDING';
    job.lockedByWorkerId = undefined;
    job.leaseExpiresAt = undefined;
    job.error = errorMsg;
    if (executionTimeMs) job.executionTimeMs = executionTimeMs;
    job.updatedAt = new Date().toISOString();

    this.save();
    return job;
  }

  // --- Session & Token Revocation Management ---
  public revokeToken(token: string, userId: string, expiresAt?: string): void {
    if (!this.state.revokedTokens) this.state.revokedTokens = [];
    if (!this.state.revokedTokens.some((r) => r.token === token)) {
      this.state.revokedTokens.push({
        token,
        userId,
        revokedAt: new Date().toISOString(),
        expiresAt: expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      // Prune expired tokens older than current timestamp to keep table small
      const now = new Date().toISOString();
      this.state.revokedTokens = this.state.revokedTokens.filter((r) => r.expiresAt > now);
      this.save();
    }
  }

  public isTokenRevoked(token: string): boolean {
    if (!this.state.revokedTokens || this.state.revokedTokens.length === 0) return false;
    return this.state.revokedTokens.some((r) => r.token === token);
  }

  public revokeAllUserSessions(userId: string): void {
    if (!this.state.revokedTokens) this.state.revokedTokens = [];
    const now = new Date().toISOString();
    const user = this.state.users.find((u) => u.id === userId);
    if (user) {
      user.tokenRevokedBefore = now;
      user.updatedAt = now;
    }
    this.state.revokedTokens.push({
      token: `user-revocation-${userId}-${Date.now()}`,
      userId,
      revokedAt: now,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    this.save();
  }

  public approveOcrJob(
    jobId: string,
    reviewedValues: Record<string, any>,
    actorUserId: string
  ): { shipment?: Shipment; payment?: Payment; job: OcrJob } {
    const job = (this.state.ocrJobs || []).find((j) => j.id === jobId);
    if (!job) throw new Error('OCR job not found');

    const user = this.getUserById(actorUserId);
    let targetShipment: Shipment | undefined;
    let targetPayment: Payment | undefined;

    if (
      job.category === 'COMMERCIAL_INVOICE' ||
      job.category === 'SHIPPING_BILL' ||
      job.category === 'BILL_OF_LADING' ||
      job.category === 'ADDITIONAL_DOC'
    ) {
      const invoiceNumber = (reviewedValues.invoiceNumber || job.candidateDraft?.invoiceNumber || '').trim();
      if (!invoiceNumber) {
        throw new Error('Invoice Number is required to commit approved shipment data.');
      }

      const fyId = job.financialYearId || this.getCurrentFinancialYear().id;
      const normalizedKey = normalizeInvoiceKey(invoiceNumber);
      const existing = this.state.shipments.find(
        (s) => s.financialYearId === fyId && s.normalizedInvoiceKey === normalizedKey
      );

      if (existing) {
        // Update existing shipment with reviewed fields
        targetShipment = this.updateShipment(
          existing.id,
          {
            invoiceDate: reviewedValues.invoiceDate || existing.invoiceDate,
            invoiceValueUsd: reviewedValues.invoiceValueUsd !== undefined ? Number(reviewedValues.invoiceValueUsd) : existing.invoiceValueUsd,
            shippingBillNumber: reviewedValues.shippingBillNumber || existing.shippingBillNumber,
            shippingBillDate: reviewedValues.shippingBillDate || existing.shippingBillDate,
            sbExchangeRate: reviewedValues.sbExchangeRate !== undefined ? Number(reviewedValues.sbExchangeRate) : existing.sbExchangeRate,
            fobValueInr: reviewedValues.fobValueInr !== undefined ? Number(reviewedValues.fobValueInr) : existing.fobValueInr,
            blNumber: reviewedValues.blNumber !== undefined ? reviewedValues.blNumber : existing.blNumber,
            blDate: reviewedValues.blDate !== undefined ? reviewedValues.blDate : existing.blDate,
            vesselName: reviewedValues.vesselName !== undefined ? reviewedValues.vesselName : existing.vesselName,
            packageCount: reviewedValues.packageCount !== undefined ? Number(reviewedValues.packageCount) : existing.packageCount,
            portCode: reviewedValues.portCode || existing.portCode,
            reviewStatus: 'CONFIRMED',
          },
          actorUserId
        );
      } else {
        // Match or resolve consignee
        let consigneeId = reviewedValues.consigneeId;
        if (!consigneeId && (reviewedValues.consigneeName || job.candidateDraft?.consigneeName)) {
          const cName = (reviewedValues.consigneeName || job.candidateDraft?.consigneeName || '').trim();
          const found = this.state.consignees.find((c) => c.name.toLowerCase() === cName.toLowerCase());
          if (found) {
            consigneeId = found.id;
          } else if (cName) {
            const created = this.createConsignee(
              {
                name: cName,
                country: 'International',
                portOfDischarge: reviewedValues.portCode || 'LKCMB',
                paymentTerms: 'DA 90 DAYS',
                currency: 'USD',
                isActive: true,
              },
              actorUserId
            );
            consigneeId = created.id;
          }
        }
        if (!consigneeId) consigneeId = this.state.consignees[0]?.id;

        targetShipment = this.createShipment(
          {
            financialYearId: fyId,
            invoiceNumber,
            invoiceDate: reviewedValues.invoiceDate || new Date().toISOString().split('T')[0],
            consigneeId,
            portCode: reviewedValues.portCode || 'INMAA1',
            packageCount: Number(reviewedValues.packageCount || 0),
            invoiceValueUsd: Number(reviewedValues.invoiceValueUsd || 0),
            shippingBillNumber: reviewedValues.shippingBillNumber || 'PENDING',
            shippingBillDate: reviewedValues.shippingBillDate || new Date().toISOString().split('T')[0],
            sbExchangeRate: Number(reviewedValues.sbExchangeRate || 92.1),
            fobValueInr: Number(reviewedValues.fobValueInr || 0),
            blNumber: reviewedValues.blNumber,
            blDate: reviewedValues.blDate,
            vesselName: reviewedValues.vesselName,
            remarks: reviewedValues.remarks,
            reviewStatus: 'CONFIRMED',
            initialFircPaymentId: reviewedValues.initialFircPaymentId,
            initialFircDocumentUploaded: Boolean(reviewedValues.initialFircPaymentId || reviewedValues.initialFircDocumentUploaded),
            incentives: {
              dbkClaimed: Number(reviewedValues.dbkClaimed || 0),
              rodtepClaimed: Number(reviewedValues.rodtepClaimed || 0),
              rosctlClaimed: Number(reviewedValues.rosctlClaimed || 0),
            },
          },
          actorUserId
        );
      }

      job.targetShipmentId = targetShipment.id;
    } else if (job.category === 'FIRC_PAYMENT') {
      const irmNumber = (reviewedValues.irmNumber || job.candidateFields?.irmNumber?.value || '').toString().trim().toUpperCase();
      if (!irmNumber) {
        throw new Error('Inward Remittance Number (IRM) is required to commit payment data.');
      }

      const existingPayment = this.state.payments.find((p) => p.irmNumber.toUpperCase() === irmNumber);
      if (existingPayment) {
        targetPayment = this.updatePayment(
          existingPayment.id,
          {
            verifiedAmount: reviewedValues.verifiedAmount !== undefined ? Number(reviewedValues.verifiedAmount) : existingPayment.verifiedAmount,
            exchangeRate: reviewedValues.exchangeRate !== undefined ? Number(reviewedValues.exchangeRate) : existingPayment.exchangeRate,
            inrAmount: reviewedValues.inrAmount !== undefined ? Number(reviewedValues.inrAmount) : existingPayment.inrAmount,
            valueDate: reviewedValues.valueDate || existingPayment.valueDate,
            creditDate: reviewedValues.creditDate || existingPayment.creditDate,
          },
          actorUserId
        );
      } else {
        const banks = this.getBanks();
        targetPayment = this.createPayment(
          {
            irmNumber,
            senderReference: reviewedValues.senderReference,
            currency: reviewedValues.currency || 'USD',
            verifiedAmount: Number(reviewedValues.verifiedAmount || 0),
            exchangeRate: Number(reviewedValues.exchangeRate || 93.28),
            inrAmount: Number(reviewedValues.inrAmount || 0),
            valueDate: reviewedValues.valueDate || new Date().toISOString().split('T')[0],
            creditDate: reviewedValues.creditDate || new Date().toISOString().split('T')[0],
            bankId: reviewedValues.bankId || banks[0]?.id || '',
            purposeCode: reviewedValues.purposeCode || 'P0103',
            remarks: reviewedValues.remarks,
          },
          actorUserId
        );
      }

      job.targetPaymentId = targetPayment.id;
    }

    // Link original document if exists
    if (job.documentId) {
      const doc = this.getDocumentById(job.documentId);
      if (doc) {
        if (targetShipment && !doc.shipmentId) doc.shipmentId = targetShipment.id;
        if (targetPayment && !doc.paymentId) doc.paymentId = targetPayment.id;
        doc.reviewStatus = 'CONFIRMED';
        doc.updatedAt = new Date().toISOString();
      }
    }

    job.approvedAt = new Date().toISOString();
    job.approvedByUserId = actorUserId;
    job.approvedByName = user?.name || 'Administrator';
    job.updatedAt = new Date().toISOString();


    this.save();
    return { shipment: targetShipment, payment: targetPayment, job };
  }


  // --- Settings ---
  public getSettings(): AppSettings {
    return this.state.settings;
  }

  public updateSettings(updates: Partial<AppSettings>, actorUserId: string): AppSettings {
    const old = { ...this.state.settings };
    Object.assign(this.state.settings, updates);


    this.save();
    return this.state.settings;
  }

  // --- Operational Data Management ---
  public clearAllOperationalData(actorUserId: string): { success: boolean; cleared: Record<string, number> } {
    const countSummary = {
      shipments: this.state.shipments.length,
      invoiceItems: this.state.invoiceItems.length,
      documents: this.state.documents.length,
      payments: this.state.payments.length,
      allocations: this.state.allocations.length,
      incentives: this.state.incentives.length,
      brcRecords: this.state.brcRecords.length,
    };

    // Remove physical files associated with documents
    for (const doc of this.state.documents) {
      try {
        const fullPath = path.isAbsolute(doc.storedPath) ? doc.storedPath : path.resolve(doc.storedPath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      } catch (e) {
        console.warn('Could not remove file on disk:', e);
      }
    }

    this.state.shipments = [];
    this.state.invoiceItems = [];
    this.state.documents = [];
    this.state.payments = [];
    this.state.allocations = [];
    this.state.incentives = [];
    this.state.brcRecords = [];


    this.save();
    return { success: true, cleared: countSummary };
  }

  // --- GST Entries ---
  public getGstEntries(filters?: {
    consigneeId?: string;
    result?: GstResult;
    search?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
    sortBy?: 'entryDate' | 'consigneeName' | 'totalGst' | 'refundEligible' | 'difference';
    sortOrder?: 'asc' | 'desc';
  }): { entries: GstEntry[]; total: number; summary: GstSummary } {
    let list = [...this.state.gstEntries];

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

    const summary = this.calculateGstSummary(list);

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
    const limit = filters?.limit ? Math.max(1, filters.limit) : total;
    const startIndex = (page - 1) * limit;
    const paginated = list.slice(startIndex, startIndex + limit);

    return { entries: paginated, total, summary };
  }

  public calculateGstSummary(entries?: GstEntry[]): GstSummary {
    const list = entries || this.state.gstEntries;
    let totalIgst = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalGst = 0;
    let totalRefundEligible = 0;
    let gainCount = 0;
    let lossCount = 0;
    let nilCount = 0;

    for (const e of list) {
      totalIgst += Number(e.igst || 0);
      totalCgst += Number(e.cgst || 0);
      totalSgst += Number(e.sgst || 0);
      totalGst += Number(e.totalGst || 0);
      totalRefundEligible += Number(e.refundEligible || 0);
      if (e.result === 'GAIN') gainCount++;
      else if (e.result === 'LOSS') lossCount++;
      else nilCount++;
    }

    const round2 = (val: number) => Math.round(val * 100) / 100;

    return {
      totalEntries: list.length,
      totalIgst: round2(totalIgst),
      totalCgst: round2(totalCgst),
      totalSgst: round2(totalSgst),
      totalGst: round2(totalGst),
      totalRefundEligible: round2(totalRefundEligible),
      netDifference: round2(totalRefundEligible - totalGst),
      overallResult: (round2(totalRefundEligible - totalGst) > 0 ? 'GAIN' : round2(totalRefundEligible - totalGst) < 0 ? 'LOSS' : 'NIL') as GstResult,
      gainCount,
      lossCount,
      nilCount,
    };
  }

  public getGstSummary(filters?: { consigneeId?: string; startDate?: string; endDate?: string }): GstSummary {
    let list = [...this.state.gstEntries];
    if (filters?.consigneeId && filters.consigneeId !== 'ALL') {
      list = list.filter((e) => e.consigneeId === filters.consigneeId);
    }
    if (filters?.startDate) {
      list = list.filter((e) => e.entryDate >= filters.startDate!);
    }
    if (filters?.endDate) {
      list = list.filter((e) => e.entryDate <= filters.endDate!);
    }
    return this.calculateGstSummary(list);
  }

  public getGstEntryById(id: string): GstEntry | undefined {
    return this.state.gstEntries.find((e) => e.id === id);
  }

  public createGstEntry(data: {
    entryDate: string;
    consigneeId: string;
    igst: number;
    cgst: number;
    sgst: number;
    refundEligible: number;
    remarks?: string;
  }): GstEntry {
    if (!data.entryDate || isNaN(new Date(data.entryDate).getTime())) {
      throw new Error('Valid entry date is required.');
    }
    const consignee = this.state.consignees.find((c) => c.id === data.consigneeId);
    if (!consignee) {
      throw new Error('Selected consignee does not exist in master records.');
    }

    const round2 = (val: number) => Math.round(val * 100) / 100;

    const igst = round2(Number(data.igst || 0));
    const cgst = round2(Number(data.cgst || 0));
    const sgst = round2(Number(data.sgst || 0));
    const refundEligible = round2(Number(data.refundEligible || 0));

    if (igst < 0 || cgst < 0 || sgst < 0 || refundEligible < 0) {
      throw new Error('GST amounts and refund eligible cannot be negative.');
    }

    const totalGst = round2(igst + cgst + sgst);
    const difference = round2(refundEligible - totalGst);
    const result: GstResult = difference > 0 ? 'GAIN' : difference < 0 ? 'LOSS' : 'NIL';

    const year = new Date(data.entryDate).getFullYear();
    const countForYear = this.state.gstEntries.filter((e) => e.entryDate.startsWith(String(year))).length + 1;
    const readableId = 'GST-' + year + '-' + String(countForYear).padStart(3, '0');

    const newEntry: GstEntry = {
      id: readableId,
      entryDate: data.entryDate,
      consigneeId: consignee.id,
      consigneeName: consignee.name,
      igst,
      cgst,
      sgst,
      totalGst,
      refundEligible,
      difference,
      result,
      remarks: data.remarks?.trim() || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.gstEntries.unshift(newEntry);
    this.save();
    return newEntry;
  }

  public updateGstEntry(
    id: string,
    updates: Partial<{
      entryDate: string;
      consigneeId: string;
      igst: number;
      cgst: number;
      sgst: number;
      refundEligible: number;
      remarks?: string;
    }>
  ): GstEntry {
    const entry = this.state.gstEntries.find((e) => e.id === id);
    if (!entry) throw new Error('GST entry not found.');

    const round2 = (val: number) => Math.round(val * 100) / 100;

    if (updates.entryDate !== undefined) {
      if (!updates.entryDate || isNaN(new Date(updates.entryDate).getTime())) {
        throw new Error('Valid entry date is required.');
      }
      entry.entryDate = updates.entryDate;
    }

    if (updates.consigneeId !== undefined) {
      const consignee = this.state.consignees.find((c) => c.id === updates.consigneeId);
      if (!consignee) throw new Error('Selected consignee does not exist in master records.');
      entry.consigneeId = consignee.id;
      entry.consigneeName = consignee.name;
    }

    if (updates.igst !== undefined) {
      const v = round2(Number(updates.igst));
      if (v < 0) throw new Error('IGST amount cannot be negative.');
      entry.igst = v;
    }

    if (updates.cgst !== undefined) {
      const v = round2(Number(updates.cgst));
      if (v < 0) throw new Error('CGST amount cannot be negative.');
      entry.cgst = v;
    }

    if (updates.sgst !== undefined) {
      const v = round2(Number(updates.sgst));
      if (v < 0) throw new Error('SGST amount cannot be negative.');
      entry.sgst = v;
    }

    if (updates.refundEligible !== undefined) {
      const v = round2(Number(updates.refundEligible));
      if (v < 0) throw new Error('Refund eligible amount cannot be negative.');
      entry.refundEligible = v;
    }

    if (updates.remarks !== undefined) {
      entry.remarks = updates.remarks.trim() || undefined;
    }

    entry.totalGst = round2(entry.igst + entry.cgst + entry.sgst);
    entry.difference = round2(entry.refundEligible - entry.totalGst);
    entry.result = entry.difference > 0 ? 'GAIN' : entry.difference < 0 ? 'LOSS' : 'NIL';
    entry.updatedAt = new Date().toISOString();

    this.save();
    return entry;
  }

  public deleteGstEntry(id: string): boolean {
    const idx = this.state.gstEntries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.state.gstEntries.splice(idx, 1);
    this.save();
    return true;
  }

  // ==========================================
  // --- B2B GST Management Module Methods ---
  // ==========================================

  public getSuppliers(search?: string): Supplier[] {
    const invoices = this.state.b2bInvoices || [];
    const searchLower = (search || '').trim().toLowerCase();

    return (this.state.suppliers || [])
      .map((sup) => {
        const supInvoices = invoices.filter(
          (inv) => inv.supplierId === sup.id || inv.supplierGstin.toUpperCase() === sup.gstin.toUpperCase()
        );
        const invoiceCount = supInvoices.length;
        const totalInvoiceValue = Math.round(supInvoices.reduce((sum, inv) => sum + (inv.invoiceValue || 0), 0) * 100) / 100;
        const totalTaxableValue = Math.round(supInvoices.reduce((sum, inv) => sum + (inv.taxableValue || 0), 0) * 100) / 100;
        const totalGst = Math.round(supInvoices.reduce((sum, inv) => sum + (inv.totalGst || 0), 0) * 100) / 100;

        let latestInvoiceDate: string | undefined = undefined;
        if (supInvoices.length > 0) {
          const sorted = [...supInvoices].sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));
          latestInvoiceDate = sorted[0].invoiceDate;
        }

        return {
          ...sup,
          invoiceCount,
          totalInvoiceValue,
          totalTaxableValue,
          totalGst,
          latestInvoiceDate,
        };
      })
      .filter((sup) => {
        if (!searchLower) return true;
        return (
          sup.legalName.toLowerCase().includes(searchLower) ||
          sup.gstin.toLowerCase().includes(searchLower) ||
          (sup.tradeName && sup.tradeName.toLowerCase().includes(searchLower)) ||
          (sup.state && sup.state.toLowerCase().includes(searchLower))
        );
      })
      .sort((a, b) => a.legalName.localeCompare(b.legalName));
  }

  public getSupplierById(id: string): Supplier | undefined {
    const list = this.getSuppliers();
    return list.find((s) => s.id === id);
  }

  public getSupplierByGstin(gstin: string): Supplier | undefined {
    const cleanGstin = gstin.trim().toUpperCase();
    return (this.state.suppliers || []).find((s) => s.gstin.toUpperCase() === cleanGstin);
  }

  public createSupplier(data: {
    gstin: string;
    legalName: string;
    tradeName?: string;
    address?: string;
    state?: string;
  }): Supplier {
    const gstin = data.gstin.trim().toUpperCase();
    if (!gstin || gstin.length !== 15) {
      throw new Error('Valid 15-character GSTIN is required.');
    }
    const legalName = data.legalName.trim();
    if (!legalName) {
      throw new Error('Supplier legal name is required.');
    }

    const existing = this.getSupplierByGstin(gstin);
    if (existing) {
      throw new Error(`Supplier with GSTIN "${gstin}" already exists (${existing.legalName}).`);
    }

    const now = new Date().toISOString();
    const newSupplier: Supplier = {
      id: `sup-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      gstin,
      legalName,
      tradeName: data.tradeName?.trim() || undefined,
      address: data.address?.trim() || undefined,
      state: data.state?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };

    if (!this.state.suppliers) this.state.suppliers = [];
    this.state.suppliers.push(newSupplier);
    this.save();
    return newSupplier;
  }

  public updateSupplier(
    id: string,
    updates: Partial<{
      legalName: string;
      tradeName?: string;
      address?: string;
      state?: string;
    }>
  ): Supplier {
    const supplier = (this.state.suppliers || []).find((s) => s.id === id);
    if (!supplier) throw new Error('Supplier not found.');

    if (updates.legalName !== undefined) {
      const name = updates.legalName.trim();
      if (!name) throw new Error('Legal name cannot be empty.');
      supplier.legalName = name;

      // Update linked invoices
      if (this.state.b2bInvoices) {
        for (const inv of this.state.b2bInvoices) {
          if (inv.supplierId === id || inv.supplierGstin.toUpperCase() === supplier.gstin.toUpperCase()) {
            inv.supplierName = name;
          }
        }
      }
    }

    if (updates.tradeName !== undefined) supplier.tradeName = updates.tradeName.trim() || undefined;
    if (updates.address !== undefined) supplier.address = updates.address.trim() || undefined;
    if (updates.state !== undefined) supplier.state = updates.state.trim() || undefined;

    supplier.updatedAt = new Date().toISOString();
    this.save();
    return supplier;
  }

  public deleteSupplier(id: string): boolean {
    const supplier = (this.state.suppliers || []).find((s) => s.id === id);
    if (!supplier) return false;

    const hasLinked = (this.state.b2bInvoices || []).some(
      (inv) => inv.supplierId === id || inv.supplierGstin.toUpperCase() === supplier.gstin.toUpperCase()
    );
    if (hasLinked) {
      throw new Error(`Cannot delete supplier "${supplier.legalName}" as it has linked B2B invoices.`);
    }

    const idx = this.state.suppliers.findIndex((s) => s.id === id);
    if (idx !== -1) {
      this.state.suppliers.splice(idx, 1);
      this.save();
      return true;
    }
    return false;
  }

  public getB2bInvoices(filters?: {
    periodKey?: string;
    financialYear?: string;
    supplierGstin?: string;
    invoiceType?: string;
    reverseCharge?: string;
    itcAvailability?: string;
    search?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): {
    data: B2bInvoice[];
    total: number;
    page: number;
    limit: number;
    totalTaxableValue: number;
    totalGst: number;
    totalInvoiceValue: number;
  } {
    let list = [...(this.state.b2bInvoices || [])];

    if (filters?.periodKey && filters.periodKey !== 'ALL') {
      list = list.filter((inv) => inv.periodKey === filters.periodKey);
    }

    if (filters?.financialYear && filters.financialYear !== 'ALL') {
      list = list.filter((inv) => inv.financialYear === filters.financialYear);
    }

    if (filters?.supplierGstin && filters.supplierGstin !== 'ALL') {
      const g = filters.supplierGstin.trim().toUpperCase();
      list = list.filter((inv) => inv.supplierGstin.toUpperCase() === g);
    }

    if (filters?.invoiceType && filters.invoiceType !== 'ALL') {
      list = list.filter((inv) => inv.invoiceType.toLowerCase() === filters.invoiceType!.toLowerCase());
    }

    if (filters?.reverseCharge && filters.reverseCharge !== 'ALL') {
      list = list.filter((inv) => inv.reverseCharge.toUpperCase() === filters.reverseCharge!.toUpperCase());
    }

    if (filters?.itcAvailability && filters.itcAvailability !== 'ALL') {
      list = list.filter((inv) => inv.itcAvailability.toLowerCase() === filters.itcAvailability!.toLowerCase());
    }

    if (filters?.search) {
      const s = filters.search.trim().toLowerCase();
      list = list.filter(
        (inv) =>
          inv.invoiceNumber.toLowerCase().includes(s) ||
          inv.supplierName.toLowerCase().includes(s) ||
          inv.supplierGstin.toLowerCase().includes(s) ||
          (inv.irn && inv.irn.toLowerCase().includes(s))
      );
    }

    const round2 = (v: number) => Math.round(v * 100) / 100;
    const totalTaxableValue = round2(list.reduce((sum, inv) => sum + (inv.taxableValue || 0), 0));
    const totalGst = round2(list.reduce((sum, inv) => sum + (inv.totalGst || 0), 0));
    const totalInvoiceValue = round2(list.reduce((sum, inv) => sum + (inv.invoiceValue || 0), 0));
    const total = list.length;

    // Sort
    const sortBy = filters?.sortBy || 'invoiceDate';
    const sortOrder = filters?.sortOrder || 'desc';

    list.sort((a: any, b: any) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (typeof valA === 'string') {
        const cmp = valA.localeCompare(valB || '');
        return sortOrder === 'asc' ? cmp : -cmp;
      }
      if (typeof valA === 'number') {
        const cmp = (valA || 0) - (valB || 0);
        return sortOrder === 'asc' ? cmp : -cmp;
      }
      return 0;
    });

    const page = Math.max(1, filters?.page || 1);
    const limit = filters?.limit === 0 ? total : Math.max(1, filters?.limit || 50);
    const start = (page - 1) * limit;
    const paginated = list.slice(start, start + limit);

    return {
      data: paginated,
      total,
      page,
      limit,
      totalTaxableValue,
      totalGst,
      totalInvoiceValue,
    };
  }

  public getB2bInvoiceById(id: string): B2bInvoice | undefined {
    return (this.state.b2bInvoices || []).find((inv) => inv.id === id);
  }

  public createB2bInvoice(data: any, userId?: string): B2bInvoice {
    const round2 = (v: number) => Math.round(Number(v || 0) * 100) / 100;

    const supplierGstin = (data.supplierGstin || '').trim().toUpperCase();
    if (!supplierGstin || supplierGstin.length !== 15) {
      throw new Error('Valid 15-character Supplier GSTIN is required.');
    }

    const invoiceNumber = (data.invoiceNumber || '').trim();
    if (!invoiceNumber) {
      throw new Error('Invoice Number is required.');
    }

    const invoiceType = (data.invoiceType || 'Regular').trim();

    // Check duplicate
    const existing = (this.state.b2bInvoices || []).find(
      (inv) =>
        inv.supplierGstin.toUpperCase() === supplierGstin &&
        inv.invoiceNumber.trim().toUpperCase() === invoiceNumber.toUpperCase() &&
        inv.invoiceType.trim().toUpperCase() === invoiceType.toUpperCase()
    );

    if (existing) {
      throw new Error(
        `Duplicate invoice detected: Invoice "${invoiceNumber}" for supplier "${supplierGstin}" already exists in GSTR Period ${existing.gstrPeriod}.`
      );
    }

    const parsedPeriod = parseGstrPeriod(data.gstrPeriod);
    if (!parsedPeriod) {
      throw new Error(
        `Invalid GSTR Period: "${data.gstrPeriod}". Must be a valid period like "August 2026", "2026-08", or "08-2026".`
      );
    }

    // Ensure supplier exists or auto-create
    let supplier = this.getSupplierByGstin(supplierGstin);
    if (!supplier) {
      const supplierName = (data.supplierName || 'SUPPLIER ' + supplierGstin).trim();
      const state = data.placeOfSupply?.replace(/^\d+-/, '').trim() || undefined;
      supplier = this.createSupplier({
        gstin: supplierGstin,
        legalName: supplierName,
        tradeName: supplierName,
        state,
      });
    }

    const taxableValue = round2(data.taxableValue);
    const integratedTax = round2(data.integratedTax);
    const centralTax = round2(data.centralTax);
    const stateUtTax = round2(data.stateUtTax);
    const cess = round2(data.cess);
    const totalGst = round2(integratedTax + centralTax + stateUtTax + cess);

    let invoiceValue = round2(data.invoiceValue);
    if (!invoiceValue || invoiceValue === 0) {
      invoiceValue = round2(taxableValue + totalGst);
    }

    const now = new Date().toISOString();
    const newInvoice: B2bInvoice = {
      id: `b2b-inv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      supplierId: supplier.id,
      supplierGstin,
      supplierName: supplier.legalName,
      invoiceNumber,
      invoiceType,
      invoiceDate: data.invoiceDate,
      invoiceValue,
      placeOfSupply: data.placeOfSupply?.trim() || undefined,
      reverseCharge: data.reverseCharge?.toUpperCase() === 'Y' ? 'Y' : 'N',
      taxableValue,
      integratedTax,
      centralTax,
      stateUtTax,
      cess,
      totalGst,
      gstrPeriod: parsedPeriod.displayPeriod,
      periodKey: parsedPeriod.periodKey,
      financialYear: parsedPeriod.financialYear,
      filingDate: data.filingDate || undefined,
      itcAvailability: data.itcAvailability === 'No' ? 'No' : 'Yes',
      reason: data.reason?.trim() || undefined,
      applicableTaxRate: data.applicableTaxRate ? Number(data.applicableTaxRate) : 100,
      source: data.source?.trim() || 'GSTR-1',
      irn: data.irn?.trim() || undefined,
      irnDate: data.irnDate || undefined,
      importBatchId: data.importBatchId || undefined,
      createdBy: userId || undefined,
      createdAt: now,
      updatedAt: now,
    };

    if (!this.state.b2bInvoices) this.state.b2bInvoices = [];
    this.state.b2bInvoices.unshift(newInvoice);
    this.save();
    return newInvoice;
  }

  public updateB2bInvoice(id: string, updates: any, userId?: string): B2bInvoice {
    const invoice = (this.state.b2bInvoices || []).find((inv) => inv.id === id);
    if (!invoice) throw new Error('B2B Invoice not found.');

    const round2 = (v: number) => Math.round(Number(v || 0) * 100) / 100;

    const newGstin = (updates.supplierGstin || invoice.supplierGstin).trim().toUpperCase();
    const newInvoiceNumber = (updates.invoiceNumber || invoice.invoiceNumber).trim();
    const newInvoiceType = (updates.invoiceType || invoice.invoiceType).trim();

    // Check duplicate if key components changed
    if (
      newGstin !== invoice.supplierGstin ||
      newInvoiceNumber.toUpperCase() !== invoice.invoiceNumber.toUpperCase() ||
      newInvoiceType.toUpperCase() !== invoice.invoiceType.toUpperCase()
    ) {
      const dup = (this.state.b2bInvoices || []).find(
        (inv) =>
          inv.id !== id &&
          inv.supplierGstin.toUpperCase() === newGstin &&
          inv.invoiceNumber.trim().toUpperCase() === newInvoiceNumber.toUpperCase() &&
          inv.invoiceType.trim().toUpperCase() === newInvoiceType.toUpperCase()
      );
      if (dup) {
        throw new Error(
          `Duplicate conflict: Another invoice with number "${newInvoiceNumber}" for supplier "${newGstin}" already exists.`
        );
      }
    }

    if (updates.gstrPeriod !== undefined) {
      const parsed = parseGstrPeriod(updates.gstrPeriod);
      if (!parsed) throw new Error(`Invalid GSTR Period: "${updates.gstrPeriod}"`);
      invoice.gstrPeriod = parsed.displayPeriod;
      invoice.periodKey = parsed.periodKey;
      invoice.financialYear = parsed.financialYear;
    }

    if (updates.supplierGstin !== undefined) {
      invoice.supplierGstin = newGstin;
      let sup = this.getSupplierByGstin(newGstin);
      if (!sup) {
        sup = this.createSupplier({
          gstin: newGstin,
          legalName: updates.supplierName || 'SUPPLIER ' + newGstin,
        });
      }
      invoice.supplierId = sup.id;
      invoice.supplierName = updates.supplierName || sup.legalName;
    } else if (updates.supplierName !== undefined) {
      invoice.supplierName = updates.supplierName.trim();
    }

    if (updates.invoiceNumber !== undefined) invoice.invoiceNumber = newInvoiceNumber;
    if (updates.invoiceType !== undefined) invoice.invoiceType = newInvoiceType;
    if (updates.invoiceDate !== undefined) invoice.invoiceDate = updates.invoiceDate;
    if (updates.placeOfSupply !== undefined) invoice.placeOfSupply = updates.placeOfSupply.trim() || undefined;
    if (updates.reverseCharge !== undefined) invoice.reverseCharge = updates.reverseCharge.toUpperCase() === 'Y' ? 'Y' : 'N';
    if (updates.taxableValue !== undefined) invoice.taxableValue = round2(updates.taxableValue);
    if (updates.integratedTax !== undefined) invoice.integratedTax = round2(updates.integratedTax);
    if (updates.centralTax !== undefined) invoice.centralTax = round2(updates.centralTax);
    if (updates.stateUtTax !== undefined) invoice.stateUtTax = round2(updates.stateUtTax);
    if (updates.cess !== undefined) invoice.cess = round2(updates.cess);

    invoice.totalGst = round2(invoice.integratedTax + invoice.centralTax + invoice.stateUtTax + invoice.cess);

    if (updates.invoiceValue !== undefined) {
      invoice.invoiceValue = round2(updates.invoiceValue);
    } else if (updates.taxableValue !== undefined || updates.integratedTax !== undefined) {
      if (!invoice.invoiceValue) invoice.invoiceValue = round2(invoice.taxableValue + invoice.totalGst);
    }

    if (updates.filingDate !== undefined) invoice.filingDate = updates.filingDate || undefined;
    if (updates.itcAvailability !== undefined) invoice.itcAvailability = updates.itcAvailability === 'No' ? 'No' : 'Yes';
    if (updates.reason !== undefined) invoice.reason = updates.reason.trim() || undefined;
    if (updates.applicableTaxRate !== undefined) invoice.applicableTaxRate = Number(updates.applicableTaxRate);
    if (updates.source !== undefined) invoice.source = updates.source.trim() || undefined;
    if (updates.irn !== undefined) invoice.irn = updates.irn.trim() || undefined;
    if (updates.irnDate !== undefined) invoice.irnDate = updates.irnDate || undefined;

    invoice.updatedBy = userId || undefined;
    invoice.updatedAt = new Date().toISOString();

    this.save();
    return invoice;
  }

  public deleteB2bInvoice(id: string): boolean {
    const idx = (this.state.b2bInvoices || []).findIndex((inv) => inv.id === id);
    if (idx === -1) return false;
    this.state.b2bInvoices.splice(idx, 1);
    this.save();
    return true;
  }

  public getB2bMonthlySummaries(financialYear?: string): B2bMonthlySummary[] {
    const fy = financialYear && financialYear !== 'ALL' ? financialYear : '2026-27';
    const standardMonths = getMonthsForFinancialYear(fy);
    const invoices = (this.state.b2bInvoices || []).filter((inv) => inv.financialYear === fy);

    const round2 = (v: number) => Math.round(v * 100) / 100;

    const summaries: B2bMonthlySummary[] = standardMonths.map((m) => {
      const monthInvoices = invoices.filter((inv) => inv.periodKey === m.periodKey);
      const uniqueSuppliers = new Set(monthInvoices.map((inv) => inv.supplierGstin.toUpperCase())).size;
      const totalInvoiceValue = round2(monthInvoices.reduce((s, inv) => s + (inv.invoiceValue || 0), 0));
      const totalTaxableValue = round2(monthInvoices.reduce((s, inv) => s + (inv.taxableValue || 0), 0));
      const totalIgst = round2(monthInvoices.reduce((s, inv) => s + (inv.integratedTax || 0), 0));
      const totalCgst = round2(monthInvoices.reduce((s, inv) => s + (inv.centralTax || 0), 0));
      const totalSgst = round2(monthInvoices.reduce((s, inv) => s + (inv.stateUtTax || 0), 0));
      const totalCess = round2(monthInvoices.reduce((s, inv) => s + (inv.cess || 0), 0));
      const totalGst = round2(monthInvoices.reduce((s, inv) => s + (inv.totalGst || 0), 0));
      const itcAvailableCount = monthInvoices.filter((inv) => inv.itcAvailability === 'Yes').length;
      const reverseChargeCount = monthInvoices.filter((inv) => inv.reverseCharge === 'Y').length;

      return {
        periodKey: m.periodKey,
        displayPeriod: m.displayPeriod,
        financialYear: fy,
        invoiceCount: monthInvoices.length,
        uniqueSuppliers,
        totalInvoiceValue,
        totalTaxableValue,
        totalIgst,
        totalCgst,
        totalSgst,
        totalCess,
        totalGst,
        itcAvailableCount,
        reverseChargeCount,
      };
    });

    const existingKeys = new Set(summaries.map((s) => s.periodKey));
    const extraPeriodKeys = Array.from(new Set(invoices.map((inv) => inv.periodKey))).filter((k) => !existingKeys.has(k));
    for (const epk of extraPeriodKeys) {
      const sample = invoices.find((inv) => inv.periodKey === epk)!;
      const monthInvoices = invoices.filter((inv) => inv.periodKey === epk);
      const uniqueSuppliers = new Set(monthInvoices.map((inv) => inv.supplierGstin.toUpperCase())).size;
      summaries.push({
        periodKey: epk,
        displayPeriod: sample.gstrPeriod || epk,
        financialYear: fy,
        invoiceCount: monthInvoices.length,
        uniqueSuppliers,
        totalInvoiceValue: round2(monthInvoices.reduce((s, inv) => s + (inv.invoiceValue || 0), 0)),
        totalTaxableValue: round2(monthInvoices.reduce((s, inv) => s + (inv.taxableValue || 0), 0)),
        totalIgst: round2(monthInvoices.reduce((s, inv) => s + (inv.integratedTax || 0), 0)),
        totalCgst: round2(monthInvoices.reduce((s, inv) => s + (inv.centralTax || 0), 0)),
        totalSgst: round2(monthInvoices.reduce((s, inv) => s + (inv.stateUtTax || 0), 0)),
        totalCess: round2(monthInvoices.reduce((s, inv) => s + (inv.cess || 0), 0)),
        totalGst: round2(monthInvoices.reduce((s, inv) => s + (inv.totalGst || 0), 0)),
        itcAvailableCount: monthInvoices.filter((inv) => inv.itcAvailability === 'Yes').length,
        reverseChargeCount: monthInvoices.filter((inv) => inv.reverseCharge === 'Y').length,
      });
    }

    return summaries;
  }

  public getB2bMonthDetail(periodKey: string): {
    summary: B2bMonthlySummary;
    invoices: B2bInvoice[];
    topSuppliers: Array<{
      gstin: string;
      name: string;
      invoiceCount: number;
      invoiceValue: number;
      taxableValue: number;
      totalGst: number;
    }>;
  } {
    const invoices = (this.state.b2bInvoices || []).filter((inv) => inv.periodKey === periodKey);
    const parsed = parseGstrPeriod(periodKey);
    const displayPeriod = parsed?.displayPeriod || periodKey;
    const financialYear = parsed?.financialYear || '2026-27';

    const round2 = (v: number) => Math.round(v * 100) / 100;
    const uniqueSuppliers = new Set(invoices.map((inv) => inv.supplierGstin.toUpperCase())).size;

    const summary: B2bMonthlySummary = {
      periodKey,
      displayPeriod,
      financialYear,
      invoiceCount: invoices.length,
      uniqueSuppliers,
      totalInvoiceValue: round2(invoices.reduce((s, inv) => s + (inv.invoiceValue || 0), 0)),
      totalTaxableValue: round2(invoices.reduce((s, inv) => s + (inv.taxableValue || 0), 0)),
      totalIgst: round2(invoices.reduce((s, inv) => s + (inv.integratedTax || 0), 0)),
      totalCgst: round2(invoices.reduce((s, inv) => s + (inv.centralTax || 0), 0)),
      totalSgst: round2(invoices.reduce((s, inv) => s + (inv.stateUtTax || 0), 0)),
      totalCess: round2(invoices.reduce((s, inv) => s + (inv.cess || 0), 0)),
      totalGst: round2(invoices.reduce((s, inv) => s + (inv.totalGst || 0), 0)),
      itcAvailableCount: invoices.filter((inv) => inv.itcAvailability === 'Yes').length,
      reverseChargeCount: invoices.filter((inv) => inv.reverseCharge === 'Y').length,
    };

    const supMap = new Map<string, { gstin: string; name: string; invoiceCount: number; invoiceValue: number; taxableValue: number; totalGst: number }>();
    for (const inv of invoices) {
      const gstin = inv.supplierGstin.toUpperCase();
      const existing = supMap.get(gstin) || {
        gstin,
        name: inv.supplierName,
        invoiceCount: 0,
        invoiceValue: 0,
        taxableValue: 0,
        totalGst: 0,
      };
      existing.invoiceCount += 1;
      existing.invoiceValue = round2(existing.invoiceValue + (inv.invoiceValue || 0));
      existing.taxableValue = round2(existing.taxableValue + (inv.taxableValue || 0));
      existing.totalGst = round2(existing.totalGst + (inv.totalGst || 0));
      supMap.set(gstin, existing);
    }

    const topSuppliers = Array.from(supMap.values()).sort((a, b) => b.taxableValue - a.taxableValue);

    return {
      summary,
      invoices,
      topSuppliers,
    };
  }

  public getB2bDashboardMetrics(financialYear?: string): B2bDashboardMetrics {
    const fy = financialYear && financialYear !== 'ALL' ? financialYear : '2026-27';
    let invoices = [...(this.state.b2bInvoices || [])];
    if (fy !== 'ALL') {
      invoices = invoices.filter((inv) => inv.financialYear === fy);
    }

    const round2 = (v: number) => Math.round(v * 100) / 100;
    const uniqueSuppliers = new Set(invoices.map((inv) => inv.supplierGstin.toUpperCase())).size;

    const monthlySummaries = this.getB2bMonthlySummaries(fy);
    const monthlyTrends = monthlySummaries.map((m) => ({
      periodKey: m.periodKey,
      displayPeriod: m.displayPeriod,
      invoiceCount: m.invoiceCount,
      taxableValue: m.totalTaxableValue,
      totalGst: m.totalGst,
      invoiceValue: m.totalInvoiceValue,
    }));

    const supMap = new Map<string, { gstin: string; name: string; invoiceCount: number; invoiceValue: number; taxableValue: number; totalGst: number }>();
    for (const inv of invoices) {
      const gstin = inv.supplierGstin.toUpperCase();
      const existing = supMap.get(gstin) || {
        gstin,
        name: inv.supplierName,
        invoiceCount: 0,
        invoiceValue: 0,
        taxableValue: 0,
        totalGst: 0,
      };
      existing.invoiceCount += 1;
      existing.invoiceValue = round2(existing.invoiceValue + (inv.invoiceValue || 0));
      existing.taxableValue = round2(existing.taxableValue + (inv.taxableValue || 0));
      existing.totalGst = round2(existing.totalGst + (inv.totalGst || 0));
      supMap.set(gstin, existing);
    }

    const topSuppliers = Array.from(supMap.values())
      .sort((a, b) => b.totalGst - a.totalGst)
      .slice(0, 10);

    const recentInvoices = [...invoices]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8);

    return {
      totalInvoices: invoices.length,
      uniqueSuppliers,
      totalInvoiceValue: round2(invoices.reduce((s, inv) => s + (inv.invoiceValue || 0), 0)),
      totalTaxableValue: round2(invoices.reduce((s, inv) => s + (inv.taxableValue || 0), 0)),
      totalIgst: round2(invoices.reduce((s, inv) => s + (inv.integratedTax || 0), 0)),
      totalCgst: round2(invoices.reduce((s, inv) => s + (inv.centralTax || 0), 0)),
      totalSgst: round2(invoices.reduce((s, inv) => s + (inv.stateUtTax || 0), 0)),
      totalCess: round2(invoices.reduce((s, inv) => s + (inv.cess || 0), 0)),
      totalGst: round2(invoices.reduce((s, inv) => s + (inv.totalGst || 0), 0)),
      itcAvailableCount: invoices.filter((inv) => inv.itcAvailability === 'Yes').length,
      reverseChargeCount: invoices.filter((inv) => inv.reverseCharge === 'Y').length,
      monthlyTrends,
      supplierSummaries: topSuppliers,
      topSuppliers,
      recentInvoices,
    };
  }

  public commitB2bImport(
    batchMeta: { fileName: string; fileSizeBytes?: number },
    previewData: B2bImportPreview,
    mode: 'SKIP_EXISTING' | 'OVERWRITE_EXISTING' | 'INSERT_ALL',
    userId?: string
  ): { batchId: string; totalProcessed: number; inserted: number; updated: number; skipped: number } {
    const round2 = (v: number) => Math.round(Number(v || 0) * 100) / 100;
    const batchId = `batch-${Date.now()}`;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    const gstrPeriodSummary: Record<string, number> = {};
    const rowsToProcess = previewData.allParsedRecords || previewData.sampleRows || [];

    for (const row of rowsToProcess) {
      const supplierGstin = (row.supplierGstin || '').trim().toUpperCase();
      const invoiceNumber = (row.invoiceNumber || '').trim();
      const invoiceType = (row.invoiceType || 'Regular').trim();

      if (!supplierGstin || !invoiceNumber) {
        skipped++;
        continue;
      }

      const existingIndex = (this.state.b2bInvoices || []).findIndex(
        (inv) =>
          inv.supplierGstin.toUpperCase() === supplierGstin &&
          inv.invoiceNumber.trim().toUpperCase() === invoiceNumber.toUpperCase() &&
          inv.invoiceType.trim().toUpperCase() === invoiceType.toUpperCase()
      );

      if (existingIndex !== -1) {
        if (mode === 'SKIP_EXISTING') {
          skipped++;
          continue;
        } else if (mode === 'OVERWRITE_EXISTING') {
          const existingInv = this.state.b2bInvoices[existingIndex];
          this.updateB2bInvoice(
            existingInv.id,
            {
              ...row,
              importBatchId: batchId,
            },
            userId
          );
          updated++;
          gstrPeriodSummary[row.periodKey] = (gstrPeriodSummary[row.periodKey] || 0) + 1;
          continue;
        }
      }

      try {
        const parsedPeriod = (row.periodKey ? parseGstrPeriod(row.periodKey) : null) || parseGstrPeriod(row.gstrPeriod);
        if (!parsedPeriod) {
          skipped++;
          continue;
        }

        let sup = this.getSupplierByGstin(supplierGstin);
        if (!sup) {
          sup = this.createSupplier({
            gstin: supplierGstin,
            legalName: row.supplierName || 'SUPPLIER ' + supplierGstin,
            state: row.placeOfSupply?.replace(/^\d+-/, '').trim() || undefined,
          });
        }

        const taxableValue = round2(row.taxableValue);
        const integratedTax = round2(row.integratedTax);
        const centralTax = round2(row.centralTax);
        const stateUtTax = round2(row.stateUtTax);
        const cess = round2(row.cess);
        const totalGst = round2(integratedTax + centralTax + stateUtTax + cess);
        let invoiceValue = round2(row.invoiceValue);
        if (!invoiceValue || invoiceValue === 0) {
          invoiceValue = round2(taxableValue + totalGst);
        }

        const now = new Date().toISOString();
        const newInv: B2bInvoice = {
          id: `b2b-inv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          supplierId: sup.id,
          supplierGstin,
          supplierName: sup.legalName,
          invoiceNumber,
          invoiceType,
          invoiceDate: row.invoiceDate,
          invoiceValue,
          placeOfSupply: row.placeOfSupply?.trim() || undefined,
          reverseCharge: row.reverseCharge === 'Y' ? 'Y' : 'N',
          taxableValue,
          integratedTax,
          centralTax,
          stateUtTax,
          cess,
          totalGst,
          gstrPeriod: parsedPeriod.displayPeriod,
          periodKey: parsedPeriod.periodKey,
          financialYear: parsedPeriod.financialYear,
          filingDate: row.filingDate || undefined,
          itcAvailability: row.itcAvailability === 'No' ? 'No' : 'Yes',
          reason: row.reason?.trim() || undefined,
          applicableTaxRate: row.applicableTaxRate ? Number(row.applicableTaxRate) : 100,
          source: row.source?.trim() || 'GSTR-1',
          irn: row.irn?.trim() || undefined,
          irnDate: row.irnDate || undefined,
          importBatchId: batchId,
          createdBy: userId || undefined,
          createdAt: now,
          updatedAt: now,
        };

        if (!this.state.b2bInvoices) this.state.b2bInvoices = [];
        this.state.b2bInvoices.unshift(newInv);
        inserted++;
        gstrPeriodSummary[parsedPeriod.periodKey] = (gstrPeriodSummary[parsedPeriod.periodKey] || 0) + 1;
      } catch (err) {
        console.error('Error inserting row in commitB2bImport:', err);
        skipped++;
      }
    }

    const batchRecord: ImportBatch = {
      id: batchId,
      fileName: batchMeta.fileName,
      fileSizeBytes: batchMeta.fileSizeBytes,
      uploadedAt: new Date().toISOString(),
      uploadedBy: userId,
      totalRows: rowsToProcess.length,
      successfulRows: inserted + updated,
      failedRows: (previewData.errors || []).length,
      duplicateRows: (previewData.duplicates || []).length,
      importStatus: inserted + updated > 0 ? 'COMPLETED' : 'FAILED',
      gstrPeriodSummary,
    };

    if (!this.state.importBatches) this.state.importBatches = [];
    this.state.importBatches.unshift(batchRecord);

    this.save();
    return {
      batchId,
      totalProcessed: rowsToProcess.length,
      inserted,
      updated,
      skipped,
    };
  }

  public getImportBatches(): ImportBatch[] {
    return this.state.importBatches || [];
  }

  // --- Dashboard Metrics ---
  public getDashboardMetrics(financialYearId?: string): DashboardMetrics {
    const shipments = this.getShipments(financialYearId ? { financialYearId } : undefined);

    let totalInvoiceValueUsd = 0;
    let totalRealisedUsd = 0;
    let totalOutstandingUsd = 0;
    let totalExcessReceivedUsd = 0;
    let unpaidCount = 0;
    let partPaidCount = 0;
    let fullyPaidCount = 0;
    let excessCount = 0;
    let pendingReviewCount = 0;

    for (const s of shipments) {
      const invUsd = Number(s.invoiceValueUsd || 0);
      const paidUsd = Number(s.totalPaidUsd || 0);
      totalInvoiceValueUsd += invUsd;
      totalRealisedUsd += paidUsd;
      totalOutstandingUsd += Math.max(0, invUsd - paidUsd);
      if (paidUsd > invUsd) {
        totalExcessReceivedUsd += paidUsd - invUsd;
      }

      if (s.paymentStatus === 'UNPAID') unpaidCount++;
      else if (s.paymentStatus === 'PART_PAID') partPaidCount++;
      else if (s.paymentStatus === 'FULLY_PAID') fullyPaidCount++;
      else if (s.paymentStatus === 'EXCESS_RECEIVED') excessCount++;

      if (s.reviewStatus === 'NEEDS_REVIEW' || s.reviewStatus === 'EXTRACTED') {
        pendingReviewCount++;
      }
    }

    // Incentives calculations
    const shipmentIds = new Set(shipments.map((s) => s.id));
    const incentives = this.state.incentives.filter((i) => shipmentIds.has(i.shipmentId));
    let incentivesClaimedInr = 0;
    let incentivesReceivedInr = 0;

    for (const inc of incentives) {
      incentivesClaimedInr += Number(inc.claimedAmount);
      incentivesReceivedInr += Number(inc.receivedAmount);
    }

    // BRC calculations
    const brcs = this.state.brcRecords.filter((b) => shipmentIds.has(b.shipmentId));
    let brcPendingCount = 0;
    let brcRealisedCount = 0;
    let brcOverdueCount = 0;

    for (const b of brcs) {
      if (b.status === 'REALISED') brcRealisedCount++;
      else if (b.status === 'OVERDUE') brcOverdueCount++;
      else brcPendingCount++;
    }

    // Archive calculations
    const archivedShipments = this.state.shipments.filter(
      (s) => s.isArchived && (!financialYearId || financialYearId === 'ALL' || s.financialYearId === financialYearId)
    );
    const archivedCount = archivedShipments.length;

    return {
      totalShipments: shipments.length,
      totalInvoiceValueUsd: Math.round(totalInvoiceValueUsd * 100) / 100,
      totalRealisedUsd: Math.round(totalRealisedUsd * 100) / 100,
      totalOutstandingUsd: Math.round(totalOutstandingUsd * 100) / 100,
      totalExcessReceivedUsd: Math.round(totalExcessReceivedUsd * 100) / 100,
      unpaidCount,
      partPaidCount,
      fullyPaidCount,
      excessCount,
      incentivesClaimedInr: Math.round(incentivesClaimedInr * 100) / 100,
      incentivesReceivedInr: Math.round(incentivesReceivedInr * 100) / 100,
      incentivesPendingInr: Math.round(Math.max(0, incentivesClaimedInr - incentivesReceivedInr) * 100) / 100,
      brcPendingCount,
      brcRealisedCount,
      brcOverdueCount,
      pendingReviewCount,
      archivedCount,
      gstSummary: this.getGstSummary(),
    };
  }

  // --- Initial Seed Data ---
  private getInitialSeedState(): DatabaseState {
    return createInitialSeedState();
  }
}

export const db = new DatabaseService();
