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
  AuditLog,
  AppSettings,
  DashboardMetrics,
} from '../src/types/index.ts';
import { normalizeInvoiceKey } from './normalizer.ts';

const STORAGE_DIR = path.resolve('storage');
const DATA_DIR = path.resolve('storage/data');
const DB_FILE = path.resolve('storage/data/db.json');

// Ensure directories exist
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

interface DatabaseState {
  users: User[];
  financialYears: FinancialYear[];
  consignees: ConsigneeMaster[];
  banks: BankMaster[];
  shipments: Shipment[];
  invoiceItems: InvoiceItem[];
  documents: DocumentRecord[];
  payments: Payment[];
  allocations: PaymentAllocation[];
  incentives: IncentiveRecord[];
  brcRecords: BrcRecord[];
  auditLogs: AuditLog[];
  settings: AppSettings;
}

// In-memory mutex for concurrency control on allocations
const paymentLocks = new Set<string>();

class DatabaseService {
  private state: DatabaseState;

  constructor() {
    this.state = this.loadOrInitialize();
  }

  private hashPassword(password: string): string {
    const salt = 'ske_enterprise_salt_2026';
    return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  }

  public verifyPassword(password: string, hash: string): boolean {
    return this.hashPassword(password) === hash;
  }

  private loadOrInitialize(): DatabaseState {
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.shipments && parsed.shipments.length > 0 && parsed.consignees?.some((c: any) => c.name.includes('S K Global'))) {
          return parsed;
        }
      } catch (err) {
        console.error('Failed reading existing db.json, re-initializing...', err);
      }
    }

    const defaultState: DatabaseState = this.getInitialSeedState();
    this.persist(defaultState);
    return defaultState;
  }

  public reseedWithDefaults(actorUserId?: string) {
    this.state = this.getInitialSeedState();
    if (actorUserId) {
      this.logAudit({
        userId: actorUserId,
        action: 'RESEED_DATABASE',
        entityType: 'DATABASE',
        newValues: { shipments: this.state.shipments.length },
      });
    }
    this.save();
    return { success: true, count: this.state.shipments.length };
  }

  private persist(state: DatabaseState) {
    const tempFile = `${DB_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempFile, DB_FILE);
  }

  private save() {
    this.persist(this.state);
  }

  public reloadFromDisk() {
    this.state = this.loadOrInitialize();
  }

  public logAudit(entry: {
    userId?: string;
    userName?: string;
    action: string;
    entityType: string;
    entityId?: string;
    oldValues?: any;
    newValues?: any;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const log: AuditLog = {
      id: crypto.randomUUID(),
      userId: entry.userId,
      userName: entry.userName || (entry.userId ? this.getUserById(entry.userId)?.name : 'System'),
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      oldValues: entry.oldValues,
      newValues: entry.newValues,
      ipAddress: entry.ipAddress || '127.0.0.1',
      userAgent: entry.userAgent || 'SKE Internal Engine',
      timestamp: new Date().toISOString(),
    };
    this.state.auditLogs.unshift(log);
    // Keep max 2000 logs in memory
    if (this.state.auditLogs.length > 2000) {
      this.state.auditLogs = this.state.auditLogs.slice(0, 2000);
    }
    this.save();
    return log;
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
    this.logAudit({
      userId: actorUserId,
      action: 'CREATE',
      entityType: 'USER',
      entityId: newUser.id,
      newValues: { email: newUser.email, role: newUser.role, name: newUser.name },
    });
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
    if (updates.isActive !== undefined) user.isActive = updates.isActive;
    if (updates.password) {
      (user as any).passwordHash = this.hashPassword(updates.password);
    }
    user.updatedAt = new Date().toISOString();

    this.logAudit({
      userId: actorUserId,
      action: 'UPDATE',
      entityType: 'USER',
      entityId: id,
      oldValues: old,
      newValues: user,
    });
    this.save();
    return user;
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

    const old = { ...user };
    this.state.users.splice(idx, 1);

    this.logAudit({
      userId: actorUserId,
      action: 'DELETE',
      entityType: 'USER',
      entityId: id,
      oldValues: old,
    });

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
    this.logAudit({
      userId: actorUserId,
      action: 'CREATE',
      entityType: 'CONSIGNEE_MASTER',
      entityId: record.id,
      newValues: record,
    });
    this.save();
    return record;
  }

  public updateConsignee(id: string, updates: Partial<ConsigneeMaster>, actorUserId: string): ConsigneeMaster {
    const item = this.state.consignees.find((c) => c.id === id);
    if (!item) throw new Error('Consignee not found');

    const old = { ...item };
    Object.assign(item, updates, { updatedAt: new Date().toISOString() });

    this.logAudit({
      userId: actorUserId,
      action: 'UPDATE',
      entityType: 'CONSIGNEE_MASTER',
      entityId: id,
      oldValues: old,
      newValues: item,
    });
    this.save();
    return item;
  }

  public deleteConsignee(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.consignees.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error('Consignee not found');

    const old = { ...this.state.consignees[idx] };
    this.state.consignees.splice(idx, 1);

    this.logAudit({
      userId: actorUserId,
      action: 'DELETE',
      entityType: 'CONSIGNEE_MASTER',
      entityId: id,
      oldValues: old,
    });
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
    this.logAudit({
      userId: actorUserId,
      action: 'CREATE',
      entityType: 'BANK_MASTER',
      entityId: record.id,
      newValues: record,
    });
    this.save();
    return record;
  }

  public updateBank(id: string, updates: Partial<BankMaster>, actorUserId: string): BankMaster {
    const item = this.state.banks.find((b) => b.id === id);
    if (!item) throw new Error('Bank not found');

    const old = { ...item };
    Object.assign(item, updates, { updatedAt: new Date().toISOString() });

    this.logAudit({
      userId: actorUserId,
      action: 'UPDATE',
      entityType: 'BANK_MASTER',
      entityId: id,
      oldValues: old,
      newValues: item,
    });
    this.save();
    return item;
  }

  public deleteBank(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.banks.findIndex((b) => b.id === id);
    if (idx === -1) throw new Error('Bank not found');

    const old = { ...this.state.banks[idx] };
    this.state.banks.splice(idx, 1);

    this.logAudit({
      userId: actorUserId,
      action: 'DELETE',
      entityType: 'BANK_MASTER',
      entityId: id,
      oldValues: old,
    });
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
  }): Shipment[] {
    let list = this.state.shipments;

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

    // Calculate total USD paid
    const totalPaidUsd = allocations.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
    const balanceDueUsd = Math.max(0, Number(shipment.invoiceValueUsd) - totalPaidUsd);

    // Calculate Realised INR and average realised rate from linked payments
    let totalInrAllocated = 0;
    for (const alloc of allocations) {
      const payment = this.state.payments.find((p) => p.id === alloc.paymentId);
      if (payment && payment.exchangeRate) {
        totalInrAllocated += alloc.allocatedAmountUsd * payment.exchangeRate;
      }
    }
    const averageRealisedRate = totalPaidUsd > 0 ? totalInrAllocated / totalPaidUsd : 0;

    // Check FIRC evidence
    const hasFircDoc = documents.some((d) => d.category === 'FIRC_PAYMENT');
    const hasLinkedFircPayment = allocations.length > 0;
    const hasFircEvidence = hasFircDoc || hasLinkedFircPayment;

    // Determine derived payment status
    let paymentStatus = shipment.paymentStatus;
    if (totalPaidUsd >= shipment.invoiceValueUsd && shipment.invoiceValueUsd > 0) {
      paymentStatus = totalPaidUsd > shipment.invoiceValueUsd ? 'EXCESS_RECEIVED' : 'FULLY_PAID';
    } else if (totalPaidUsd > 0) {
      paymentStatus = 'PART_PAID';
    } else {
      paymentStatus = 'UNPAID';
    }

    return {
      ...shipment,
      consigneeName: consignee?.name || 'Unknown Buyer',
      financialYearLabel: fy?.label || 'Unknown FY',
      allocations: allocations.map((a) => {
        const p = this.state.payments.find((pm) => pm.id === a.paymentId);
        return { ...a, paymentIrm: p?.irmNumber };
      }),
      documents,
      incentives: incentives.map((i) => ({
        ...i,
        outstandingBalance: Math.max(0, Number(i.claimedAmount) - Number(i.receivedAmount)),
      })),
      brcRecord,
      totalPaidUsd: Math.round(totalPaidUsd * 100) / 100,
      balanceDueUsd: Math.round(balanceDueUsd * 100) / 100,
      realisedInr: Math.round(totalInrAllocated * 100) / 100,
      averageRealisedRate: Math.round(averageRealisedRate * 10000) / 10000,
      hasFircEvidence,
      paymentStatus,
    };
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

    // Handle initial FIRC payment allocation if provided
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

    this.logAudit({
      userId: actorUserId,
      action: 'CREATE',
      entityType: 'SHIPMENT',
      entityId: shipmentId,
      newValues: newShipment,
    });

    this.save();
    return this.hydrateShipment(newShipment);
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
    if (updates.invoiceValueUsd !== undefined) shipment.invoiceValueUsd = Number(updates.invoiceValueUsd);
    if (updates.shippingBillNumber) shipment.shippingBillNumber = updates.shippingBillNumber.trim();
    if (updates.shippingBillDate) shipment.shippingBillDate = updates.shippingBillDate;
    if (updates.sbExchangeRate !== undefined) shipment.sbExchangeRate = Number(updates.sbExchangeRate);
    if (updates.fobValueInr !== undefined) shipment.fobValueInr = Number(updates.fobValueInr);
    if (updates.blNumber !== undefined) shipment.blNumber = updates.blNumber;
    if (updates.blDate !== undefined) shipment.blDate = updates.blDate;
    if (updates.vesselName !== undefined) shipment.vesselName = updates.vesselName;
    if (updates.remarks !== undefined) shipment.remarks = updates.remarks;
    if (updates.reviewStatus) shipment.reviewStatus = updates.reviewStatus;

    shipment.updatedAt = new Date().toISOString();

    this.logAudit({
      userId: actorUserId,
      action: 'UPDATE',
      entityType: 'SHIPMENT',
      entityId: id,
      oldValues: old,
      newValues: shipment,
    });

    this.save();
    return this.hydrateShipment(shipment);
  }

  public deleteShipment(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.shipments.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('Shipment not found');

    const old = { ...this.state.shipments[idx] };

    // Remove shipment
    this.state.shipments.splice(idx, 1);

    // Remove associated items
    this.state.invoiceItems = this.state.invoiceItems.filter((i) => i.shipmentId !== id);

    // Remove associated allocations
    this.state.allocations = this.state.allocations.filter((a) => a.shipmentId !== id);

    // Remove associated incentives
    this.state.incentives = this.state.incentives.filter((i) => i.shipmentId !== id);

    // Remove associated BRC
    this.state.brcRecords = this.state.brcRecords.filter((b) => b.shipmentId !== id);

    // Remove or unlink associated documents
    this.state.documents = this.state.documents.filter((d) => d.shipmentId !== id);

    this.logAudit({
      userId: actorUserId,
      action: 'DELETE',
      entityType: 'SHIPMENT',
      entityId: id,
      oldValues: old,
    });

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

    const totalAllocatedUsd = allocations.reduce((sum, a) => sum + Number(a.allocatedAmountUsd), 0);
    const availableBalanceUsd = Math.max(0, Number(payment.verifiedAmount) - totalAllocatedUsd);

    return {
      ...payment,
      bankName: bank?.name || 'Unknown Bank',
      allocations: allocations.map((a) => {
        const s = this.state.shipments.find((sh) => sh.id === a.shipmentId);
        return { ...a, shipmentInvoiceNo: s?.invoiceNumber };
      }),
      documents,
      totalAllocatedUsd: Math.round(totalAllocatedUsd * 100) / 100,
      availableBalanceUsd: Math.round(availableBalanceUsd * 100) / 100,
    };
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
    this.logAudit({
      userId: actorUserId,
      action: 'CREATE',
      entityType: 'PAYMENT',
      entityId: paymentId,
      newValues: newPayment,
    });

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
    if (updates.verifiedAmount !== undefined) payment.verifiedAmount = Number(updates.verifiedAmount);
    if (updates.exchangeRate !== undefined) payment.exchangeRate = Number(updates.exchangeRate);
    if (updates.inrAmount !== undefined) payment.inrAmount = Number(updates.inrAmount);
    if (updates.valueDate) payment.valueDate = updates.valueDate;
    if (updates.creditDate) payment.creditDate = updates.creditDate;
    if (updates.fircIssueDate !== undefined) payment.fircIssueDate = updates.fircIssueDate;
    if (updates.bankId) payment.bankId = updates.bankId;
    if (updates.purposeCode !== undefined) payment.purposeCode = updates.purposeCode;
    if (updates.remarks !== undefined) payment.remarks = updates.remarks;

    payment.updatedAt = new Date().toISOString();

    this.logAudit({
      userId: actorUserId,
      action: 'UPDATE',
      entityType: 'PAYMENT',
      entityId: id,
      oldValues: old,
      newValues: payment,
    });

    this.save();
    return this.hydratePayment(payment);
  }

  public deletePayment(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.payments.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('Payment not found');

    const old = { ...this.state.payments[idx] };

    // Find affected shipments before removing allocations
    const affectedShipmentIds = new Set(
      this.state.allocations.filter((a) => a.paymentId === id).map((a) => a.shipmentId)
    );

    // Remove allocations
    this.state.allocations = this.state.allocations.filter((a) => a.paymentId !== id);

    // Recalculate status for affected shipments
    for (const shId of affectedShipmentIds) {
      const shipment = this.state.shipments.find((s) => s.id === shId);
      if (shipment) {
        const remainingAllocs = this.state.allocations.filter((a) => a.shipmentId === shId);
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
    }

    // Unlink documents
    this.state.documents = this.state.documents.filter((d) => d.paymentId !== id);

    // Remove payment
    this.state.payments.splice(idx, 1);

    this.logAudit({
      userId: actorUserId,
      action: 'DELETE',
      entityType: 'PAYMENT',
      entityId: id,
      oldValues: old,
    });

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

      this.logAudit({
        userId: actorUserId,
        action: 'ALLOCATE',
        entityType: 'PAYMENT_ALLOCATION',
        entityId: allocation.id,
        newValues: {
          allocation,
          paymentIrm: payment.irmNumber,
          shipmentInvoice: shipment.invoiceNumber,
          remainingPaymentBalance: availablePaymentBalance - amount,
          remainingInvoiceBalance: invoiceBalanceDue - amount,
        },
      });

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

    this.logAudit({
      userId: actorUserId,
      action: 'DEALLOCATE',
      entityType: 'PAYMENT_ALLOCATION',
      entityId: allocationId,
      oldValues: alloc,
    });

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
    this.logAudit({
      userId: actorUserId,
      action: 'CREATE',
      entityType: 'INCENTIVE',
      entityId: record.id,
      newValues: record,
    });
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

    this.logAudit({
      userId: actorUserId,
      action: 'UPDATE',
      entityType: 'INCENTIVE',
      entityId: id,
      oldValues: old,
      newValues: item,
    });

    this.save();
    return {
      ...item,
      outstandingBalance: Math.max(0, item.claimedAmount - item.receivedAmount),
    };
  }

  public deleteIncentive(id: string, actorUserId: string): { success: boolean } {
    const idx = this.state.incentives.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error('Incentive record not found');

    const old = { ...this.state.incentives[idx] };
    this.state.incentives.splice(idx, 1);

    this.logAudit({
      userId: actorUserId,
      action: 'DELETE',
      entityType: 'INCENTIVE',
      entityId: id,
      oldValues: old,
    });

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

    this.logAudit({
      userId: actorUserId,
      action: 'UPDATE',
      entityType: 'BRC_RECORD',
      entityId: item.id,
      oldValues: old,
      newValues: item,
    });

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

    this.logAudit({
      userId: actorUserId,
      action: 'RESET_BRC',
      entityType: 'BRC_RECORD',
      entityId: item.id,
      oldValues: old,
      newValues: item,
    });
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
      uploadedByUserId: actorUserId,
      uploadedByName: user?.name || 'Admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.documents.push(newDoc);
    this.logAudit({
      userId: actorUserId,
      action: nextVersion > 1 ? 'REPLACE_DOCUMENT' : 'UPLOAD_DOCUMENT',
      entityType: 'DOCUMENT',
      entityId: newDoc.id,
      newValues: {
        category: newDoc.category,
        filename: newDoc.originalFilename,
        version: newDoc.version,
        shipmentId: newDoc.shipmentId,
        paymentId: newDoc.paymentId,
      },
    });

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

    this.logAudit({
      userId: actorUserId,
      action: 'REVIEW_DOCUMENT',
      entityType: 'DOCUMENT',
      entityId: id,
      oldValues: { reviewStatus: oldStatus },
      newValues: { reviewStatus: status },
    });

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

    this.logAudit({
      userId: actorUserId,
      action: 'DELETE',
      entityType: 'DOCUMENT',
      entityId: id,
      oldValues: old,
    });

    this.save();
    return { success: true };
  }

  // --- Audit Logs ---
  public getAuditLogs(limit = 100): AuditLog[] {
    return this.state.auditLogs.slice(0, limit);
  }

  // --- Settings ---
  public getSettings(): AppSettings {
    return this.state.settings;
  }

  public updateSettings(updates: Partial<AppSettings>, actorUserId: string): AppSettings {
    const old = { ...this.state.settings };
    Object.assign(this.state.settings, updates);

    this.logAudit({
      userId: actorUserId,
      action: 'UPDATE_SETTINGS',
      entityType: 'SETTINGS',
      oldValues: old,
      newValues: this.state.settings,
    });

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

    this.logAudit({
      userId: actorUserId,
      action: 'CLEAR_ALL_OPERATIONAL_DATA',
      entityType: 'DATABASE',
      newValues: countSummary,
    });

    this.save();
    return { success: true, cleared: countSummary };
  }

  // --- Dashboard Metrics ---
  public getDashboardMetrics(financialYearId?: string): DashboardMetrics {
    const shipments = this.getShipments(financialYearId ? { financialYearId } : undefined);

    let totalInvoiceValueUsd = 0;
    let totalRealisedUsd = 0;
    let unpaidCount = 0;
    let partPaidCount = 0;
    let fullyPaidCount = 0;
    let excessCount = 0;
    let pendingReviewCount = 0;

    for (const s of shipments) {
      totalInvoiceValueUsd += s.invoiceValueUsd;
      totalRealisedUsd += s.totalPaidUsd || 0;

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

    return {
      totalShipments: shipments.length,
      totalInvoiceValueUsd: Math.round(totalInvoiceValueUsd * 100) / 100,
      totalRealisedUsd: Math.round(totalRealisedUsd * 100) / 100,
      totalOutstandingUsd: Math.round(Math.max(0, totalInvoiceValueUsd - totalRealisedUsd) * 100) / 100,
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
      recentActivity: this.state.auditLogs.slice(0, 10),
    };
  }

  // --- Initial Seed Data ---
  private getInitialSeedState(): DatabaseState {
    const superAdminId = crypto.randomUUID();
    const adminId = crypto.randomUUID();
    const viewerId = crypto.randomUUID();

    const fyCurrentId = 'fy-2026-27';
    const fyPrevId = 'fy-2025-26';

    const consignee1Id = 'c-sk-global-lk';
    const consignee2Id = 'c-shasvanth-impex';
    const consignee3Id = 'c-intl-remit-sg';

    const bank1Id = 'b-dbs-india';
    const bank2Id = 'b-hdfc-chennai';
    const bank3Id = 'b-kotak-chennai';
    const bank4Id = 'b-yes-chennai';

    const payment1Id = 'p-firc-210426i049900457';
    const payment2Id = 'p-firc-280426i049900891';

    const shipment1Id = 's-ske-26-27-020';
    const shipment2Id = 's-ske-26-27-021';

    return {
      users: [
        {
          id: superAdminId,
          email: 'owner@skenterprises.com',
          name: 'Suresh Kumar (Owner)',
          role: 'SUPER_ADMIN',
          isActive: true,
          passwordHash: this.hashPassword('Admin@123'),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as any,
        {
          id: adminId,
          email: 'accountant@skenterprises.com',
          name: 'Pooja Verma (Sr. Accountant)',
          role: 'ADMIN',
          isActive: true,
          passwordHash: this.hashPassword('Admin@123'),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as any,
        {
          id: viewerId,
          email: 'auditor@skenterprises.com',
          name: 'Ramesh Mehta (Statutory Auditor)',
          role: 'VIEWER',
          isActive: true,
          passwordHash: this.hashPassword('Admin@123'),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as any,
      ],
      financialYears: [
        {
          id: fyCurrentId,
          label: '2026-27',
          startDate: '2026-04-01',
          endDate: '2027-03-31',
          isCurrent: true,
        },
        {
          id: fyPrevId,
          label: '2025-26',
          startDate: '2025-04-01',
          endDate: '2026-03-31',
          isCurrent: false,
        },
      ],
      consignees: [
        {
          id: consignee1Id,
          name: 'S K Global Ventures Private Limited',
          country: 'Sri Lanka',
          portOfDischarge: 'LKCMB - Colombo',
          paymentTerms: 'FOB COLOMBO | DA 90 DAYS',
          currency: 'USD',
          contactEmail: 'trade@skglobalventures.lk',
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: consignee2Id,
          name: 'Shasvanth Impex',
          country: 'Sri Lanka',
          portOfDischarge: 'LKCMB - Colombo',
          paymentTerms: 'DA 90 Days from BL',
          currency: 'USD',
          contactEmail: 'accounts@shasvanthimpex.com',
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: consignee3Id,
          name: 'International Remittance Pte Ltd',
          country: 'Singapore',
          portOfDischarge: 'Singapore / Colombo',
          paymentTerms: 'Direct Remittance',
          currency: 'USD',
          contactEmail: 'remittance@intl-remit.sg',
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      banks: [
        {
          id: bank1Id,
          name: 'DBS Bank India',
          branch: 'Chennai Branch',
          adCode: '6690005',
          ifscCode: 'DBSS0IN0811',
          swiftCode: 'DBSSINBBCHE',
          accountNumber: '82XXXXXXX544',
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: bank2Id,
          name: 'HDFC Bank',
          branch: 'Second Line Beach Road, Parrys, Chennai',
          adCode: '6690005',
          ifscCode: 'HDFC0000166',
          swiftCode: 'HDFCINBBCHE',
          accountNumber: '50200055901688',
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: bank3Id,
          name: 'Kotak Mahindra Bank',
          branch: 'Mount Road, Chennai',
          adCode: '6690005',
          ifscCode: 'KKBK0008471',
          swiftCode: 'KKBKINBB',
          accountNumber: '77190022314',
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: bank4Id,
          name: 'Yes Bank',
          branch: 'Parrys Corner, Chennai',
          adCode: '6690005',
          ifscCode: 'YESB0000124',
          swiftCode: 'YESBINBB',
          accountNumber: '01248002931',
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      shipments: [
        {
          id: shipment1Id,
          financialYearId: fyCurrentId,
          invoiceNumber: 'SKE/26-27/020',
          normalizedInvoiceKey: 'SKE-26-27-020',
          invoiceDate: '2026-04-06',
          consigneeId: consignee1Id,
          portCode: 'INMAA1',
          packageCount: 88,
          invoiceValueUsd: 24025.65,
          shippingBillNumber: '2173318',
          shippingBillDate: '2026-04-07',
          sbExchangeRate: 92.1,
          fobValueInr: 2212762.37,
          blNumber: '736116000605',
          blDate: '2026-05-07',
          vesselName: 'ZHONG GU GUI YANG / VARADA 0085W',
          paymentStatus: 'FULLY_PAID',
          reviewStatus: 'CONFIRMED',
          remarks: 'Export under LUT without payment of IGST. Colombo Sri Lanka. DA 90 Days. Realisation received via HDFC Inward Remittance.',
          createdAt: '2026-04-06T10:00:00.000Z',
          updatedAt: '2026-04-21T14:30:00.000Z',
        },
        {
          id: shipment2Id,
          financialYearId: fyCurrentId,
          invoiceNumber: 'SKE/26-27/021',
          normalizedInvoiceKey: 'SKE-26-27-021',
          invoiceDate: '2026-04-18',
          consigneeId: consignee2Id,
          portCode: 'INMAA1',
          packageCount: 65,
          invoiceValueUsd: 18450.0,
          shippingBillNumber: '2174892',
          shippingBillDate: '2026-04-19',
          sbExchangeRate: 92.2,
          fobValueInr: 1701090.0,
          blNumber: '736116000840',
          blDate: '2026-05-12',
          vesselName: 'SSL CHENNAI 042E',
          paymentStatus: 'FULLY_PAID',
          reviewStatus: 'CONFIRMED',
          remarks: 'Ladies woven apparel export to Shasvanth Impex Colombo. FIRC credited via DBS Bank.',
          createdAt: '2026-04-18T09:15:00.000Z',
          updatedAt: '2026-04-29T11:20:00.000Z',
        },
      ],
      invoiceItems: [
        {
          id: 'item-1',
          shipmentId: shipment1Id,
          description: 'Polyester Ladies Salwar',
          hsnCode: '62114390',
          quantity: 1549,
          unit: 'Pcs',
          rateUsd: 5.25,
          amountUsd: 8132.25,
        },
        {
          id: 'item-2',
          shipmentId: shipment1Id,
          description: 'Polyester Ladies Tops And Pant Set',
          hsnCode: '62044390',
          quantity: 334,
          unit: 'Pcs',
          rateUsd: 3.5,
          amountUsd: 1169.0,
        },
        {
          id: 'item-3',
          shipmentId: shipment1Id,
          description: 'Polyester Ladies Tops',
          hsnCode: '62114390',
          quantity: 901,
          unit: 'Pcs',
          rateUsd: 2.4,
          amountUsd: 2162.4,
        },
        {
          id: 'item-4',
          shipmentId: shipment1Id,
          description: 'Polyester Salwar Material Unstitched (745.60 Kgs, 15005.76 SqM)',
          hsnCode: '54075290',
          quantity: 1392,
          unit: 'Pcs',
          rateUsd: 2.0,
          amountUsd: 2784.0,
        },
        {
          id: 'item-5',
          shipmentId: shipment1Id,
          description: 'Polyester Fancy Salwar Material (2613.60 Kgs, 41438.32 SqM)',
          hsnCode: '54075290',
          quantity: 3844,
          unit: 'Pcs',
          rateUsd: 2.5,
          amountUsd: 9610.0,
        },
        {
          id: 'item-6',
          shipmentId: shipment1Id,
          description: 'Cotton Ladies Trousers',
          hsnCode: '62046290',
          quantity: 56,
          unit: 'Pcs',
          rateUsd: 3.0,
          amountUsd: 168.0,
        },
      ],
      documents: [
        {
          id: 'doc-inv-020',
          shipmentId: shipment1Id,
          category: 'COMMERCIAL_INVOICE',
          originalFilename: 'SKE-26-27-020-Invoice.pdf',
          storedPath: 'storage/FY2026-27/SKE-26-27-020/commercial_invoice_SKE-26-27-020.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 145200,
          version: 1,
          isCurrent: true,
          reviewStatus: 'CONFIRMED',
          uploadedByUserId: adminId,
          uploadedByName: 'Pooja Verma',
          createdAt: '2026-04-06T10:05:00.000Z',
          updatedAt: '2026-04-06T10:05:00.000Z',
        },
        {
          id: 'doc-sb-020',
          shipmentId: shipment1Id,
          category: 'SHIPPING_BILL',
          originalFilename: 'SKE-26-27-20-SHIPPING_BILL.pdf',
          storedPath: 'storage/FY2026-27/SKE-26-27-020/shipping_bill_2173318.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 210400,
          version: 1,
          isCurrent: true,
          reviewStatus: 'CONFIRMED',
          uploadedByUserId: adminId,
          uploadedByName: 'Pooja Verma',
          createdAt: '2026-04-07T11:00:00.000Z',
          updatedAt: '2026-04-07T11:00:00.000Z',
        },
        {
          id: 'doc-bl-020',
          shipmentId: shipment1Id,
          category: 'BILL_OF_LADING',
          originalFilename: 'BL_SKE-26-27-20.pdf',
          storedPath: 'storage/FY2026-27/SKE-26-27-020/bill_of_lading_736116000605.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 185000,
          version: 1,
          isCurrent: true,
          reviewStatus: 'CONFIRMED',
          uploadedByUserId: adminId,
          uploadedByName: 'Pooja Verma',
          createdAt: '2026-05-07T14:00:00.000Z',
          updatedAt: '2026-05-07T14:00:00.000Z',
        },
        {
          id: 'doc-firc-020',
          shipmentId: shipment1Id,
          paymentId: payment1Id,
          category: 'FIRC_PAYMENT',
          originalFilename: 'SKE-26-27-20-FIRC.pdf',
          storedPath: 'storage/FY2026-27/SKE-26-27-020/firc_payment_210426I049900457.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 168900,
          version: 1,
          isCurrent: true,
          reviewStatus: 'CONFIRMED',
          uploadedByUserId: adminId,
          uploadedByName: 'Pooja Verma',
          createdAt: '2026-04-21T12:00:00.000Z',
          updatedAt: '2026-04-21T12:00:00.000Z',
        },
        {
          id: 'doc-brc-020',
          shipmentId: shipment1Id,
          category: 'BRC_COPY_1',
          originalFilename: 'BRC_Copy.pdf',
          storedPath: 'storage/FY2026-27/SKE-26-27-020/brc_copy_1_HDFC0000166A02685488.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 132000,
          version: 1,
          isCurrent: true,
          reviewStatus: 'CONFIRMED',
          uploadedByUserId: adminId,
          uploadedByName: 'Pooja Verma',
          createdAt: '2026-09-02T09:30:00.000Z',
          updatedAt: '2026-09-02T09:30:00.000Z',
        },
      ],
      payments: [
        {
          id: payment1Id,
          irmNumber: '210426I049900457',
          senderReference: '2219730110JS',
          currency: 'USD',
          verifiedAmount: 24025.65,
          inrAmount: 2241112.63,
          exchangeRate: 93.28,
          valueDate: '2026-04-20',
          creditDate: '2026-04-21',
          fircIssueDate: '2026-04-21',
          bankId: bank2Id,
          purposeCode: 'P0103',
          remarks: 'IMPORT INV SKE PI 26 27 020 DATE 04 SAMPATH BANK PLC 110 SIR JAMES PEIRIS MAWATHA',
          createdAt: '2026-04-21T11:00:00.000Z',
          updatedAt: '2026-04-21T11:00:00.000Z',
        },
        {
          id: payment2Id,
          irmNumber: '280426I049900891',
          senderReference: '2219800412SH',
          currency: 'USD',
          verifiedAmount: 18450.0,
          inrAmount: 1721016.0,
          exchangeRate: 93.28,
          valueDate: '2026-04-28',
          creditDate: '2026-04-29',
          fircIssueDate: '2026-04-29',
          bankId: bank1Id,
          purposeCode: 'P0103',
          remarks: 'Advance wire against export contracts for Shasvanth Impex Colombo',
          createdAt: '2026-04-29T10:00:00.000Z',
          updatedAt: '2026-04-29T10:00:00.000Z',
        },
      ],
      allocations: [
        {
          id: 'alloc-1',
          paymentId: payment1Id,
          shipmentId: shipment1Id,
          allocatedAmountUsd: 24025.65,
          notes: 'Full invoice realization of $24,025.65 USD via HDFC IRM 210426I049900457',
          allocatedAt: '2026-04-21T12:00:00.000Z',
          allocatedByUserId: adminId,
          allocatedByName: 'Pooja Verma',
        },
        {
          id: 'alloc-2',
          paymentId: payment2Id,
          shipmentId: shipment2Id,
          allocatedAmountUsd: 18450.0,
          notes: 'Full invoice realization of $18,450.00 USD via DBS Bank India',
          allocatedAt: '2026-04-29T11:00:00.000Z',
          allocatedByUserId: adminId,
          allocatedByName: 'Pooja Verma',
        },
      ],
      incentives: [
        {
          id: 'inc-dbk-1',
          shipmentId: shipment1Id,
          type: 'DRAWBACK',
          claimedAmount: 65291.0,
          status: 'RECEIVED',
          receivedAmount: 65291.0,
          receivedDate: '2026-05-15',
          scrollNumber: 'SCR-DBK-26-8819',
          createdAt: '2026-04-07T11:00:00.000Z',
          updatedAt: '2026-05-15T14:00:00.000Z',
        },
        {
          id: 'inc-rodtep-1',
          shipmentId: shipment1Id,
          type: 'RODTEP',
          claimedAmount: 26254.0,
          status: 'RECEIVED',
          receivedAmount: 26254.0,
          receivedDate: '2026-05-18',
          scrollNumber: 'SCR-ROD-26-1029',
          createdAt: '2026-04-07T11:00:00.000Z',
          updatedAt: '2026-05-18T15:00:00.000Z',
        },
        {
          id: 'inc-rosctl-1',
          shipmentId: shipment1Id,
          type: 'ROSCTL',
          claimedAmount: 49195.0,
          status: 'RECEIVED',
          receivedAmount: 49195.0,
          receivedDate: '2026-05-20',
          scrollNumber: 'SCR-ROS-26-4410',
          createdAt: '2026-04-07T11:00:00.000Z',
          updatedAt: '2026-05-20T11:00:00.000Z',
        },
        {
          id: 'inc-dbk-2',
          shipmentId: shipment2Id,
          type: 'DRAWBACK',
          claimedAmount: 50180.0,
          status: 'RECEIVED',
          receivedAmount: 50180.0,
          receivedDate: '2026-05-22',
          scrollNumber: 'SCR-DBK-26-9012',
          createdAt: '2026-04-19T10:00:00.000Z',
          updatedAt: '2026-05-22T10:00:00.000Z',
        },
        {
          id: 'inc-rodtep-2',
          shipmentId: shipment2Id,
          type: 'RODTEP',
          claimedAmount: 20400.0,
          status: 'PENDING',
          receivedAmount: 0,
          createdAt: '2026-04-19T10:00:00.000Z',
          updatedAt: '2026-04-19T10:00:00.000Z',
        },
        {
          id: 'inc-rosctl-2',
          shipmentId: shipment2Id,
          type: 'ROSCTL',
          claimedAmount: 37600.0,
          status: 'RECEIVED',
          receivedAmount: 37600.0,
          receivedDate: '2026-05-25',
          scrollNumber: 'SCR-ROS-26-4921',
          createdAt: '2026-04-19T10:00:00.000Z',
          updatedAt: '2026-05-25T10:00:00.000Z',
        },
      ],
      brcRecords: [
        {
          id: 'brc-1',
          shipmentId: shipment1Id,
          brcNumber: 'HDFC0000166A02685488',
          issueDate: '2026-09-02',
          realisationDate: '2026-04-20',
          realisedAmount: 24025.65,
          realisedCurrency: 'USD',
          uploadMode: 'SINGLE',
          statutoryDeadline: '2027-01-31',
          status: 'REALISED',
          remarks: 'DGFT Statement of Bank Realisation eBRC verified online.',
          createdAt: '2026-04-07T11:00:00.000Z',
          updatedAt: '2026-09-02T10:00:00.000Z',
        },
        {
          id: 'brc-2',
          shipmentId: shipment2Id,
          brcNumber: 'DBSS0IN0811A01948210',
          issueDate: '2026-09-15',
          realisationDate: '2026-04-29',
          realisedAmount: 18450.0,
          realisedCurrency: 'USD',
          uploadMode: 'SINGLE',
          statutoryDeadline: '2027-02-15',
          status: 'REALISED',
          remarks: 'eBRC received and recorded for Shasvanth Impex export',
          createdAt: '2026-04-19T10:00:00.000Z',
          updatedAt: '2026-09-15T14:00:00.000Z',
        },
      ],
      auditLogs: [
        {
          id: 'audit-init-1',
          userId: superAdminId,
          userName: 'Suresh Kumar (Owner)',
          action: 'LOGIN',
          entityType: 'SECURITY',
          ipAddress: '127.0.0.1',
          userAgent: 'Chrome on macOS',
          timestamp: '2026-05-12T09:00:00.000Z',
        },
        {
          id: 'audit-init-2',
          userId: adminId,
          userName: 'Pooja Verma (Sr. Accountant)',
          action: 'CREATE',
          entityType: 'SHIPMENT',
          entityId: shipment1Id,
          newValues: { invoiceNumber: 'SKE/26-27/020', normalizedInvoiceKey: 'SKE-26-27-020', invoiceValueUsd: 48500.0 },
          ipAddress: '127.0.0.1',
          userAgent: 'Chrome on Windows 11',
          timestamp: '2026-05-12T10:00:00.000Z',
        },
        {
          id: 'audit-init-3',
          userId: adminId,
          userName: 'Pooja Verma (Sr. Accountant)',
          action: 'CREATE',
          entityType: 'PAYMENT',
          entityId: payment1Id,
          newValues: { irmNumber: 'IRM26052026001', verifiedAmount: 50000.0 },
          ipAddress: '127.0.0.1',
          userAgent: 'Chrome on Windows 11',
          timestamp: '2026-05-20T11:00:00.000Z',
        },
        {
          id: 'audit-init-4',
          userId: adminId,
          userName: 'Pooja Verma (Sr. Accountant)',
          action: 'ALLOCATE',
          entityType: 'PAYMENT_ALLOCATION',
          entityId: 'alloc-1',
          newValues: { allocatedAmountUsd: 48500.0, shipmentInvoice: 'SKE/26-27/020', paymentIrm: 'IRM26052026001' },
          ipAddress: '127.0.0.1',
          userAgent: 'Chrome on Windows 11',
          timestamp: '2026-05-20T12:00:00.000Z',
        },
      ],
      settings: {
        statutoryBrcDays: 270,
        defaultPortCode: 'INNSA1',
        baseCurrency: 'USD',
        allowOverAllocation: false,
        companyName: 'S K Enterprises',
        iecNumber: '0308019921',
        panNumber: 'AAECS9812K',
      },
    };
  }
}

export const db = new DatabaseService();
