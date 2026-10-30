/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  User,
  FinancialYear,
  ConsigneeMaster,
  BankMaster,
  Shipment,
  Payment,
  PaymentAllocation,
  IncentiveRecord,
  BrcRecord,
  DocumentRecord,
  AuditLog,
  AppSettings,
  DashboardMetrics,
  Role,
} from '../types/index.ts';

const TOKEN_KEY = 'ske_auth_token';

export const api = {
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },

  setToken(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
  },

  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  },

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = this.getToken();
    const headers = new Headers(options.headers || {});
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(`/api${endpoint}`, {
      ...options,
      headers,
    });

    const text = await response.text();

    if (!response.ok) {
      let errMsg = `Error ${response.status}: ${response.statusText}`;
      try {
        const errorJson = JSON.parse(text);
        if (errorJson.error) errMsg = errorJson.error;
      } catch {
        // not json
      }
      throw new Error(errMsg);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Unexpected non-JSON response from server for /api${endpoint}`);
    }
  },

  // Auth
  async login(email: string, password?: string): Promise<{ token: string; user: User }> {
    const res = await this.request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.setToken(res.token);
    return res;
  },

  async switchRole(role: Role): Promise<{ token: string; user: User }> {
    const res = await this.request<{ token: string; user: User }>('/auth/switch-role', {
      method: 'POST',
      body: JSON.stringify({ role }),
    });
    this.setToken(res.token);
    return res;
  },

  async getCurrentUser(): Promise<User> {
    const res = await this.request<{ user: User }>('/auth/me');
    return res.user;
  },

  // Financial Years & Dashboard
  async getFinancialYears(): Promise<FinancialYear[]> {
    return this.request<FinancialYear[]>('/financial-years');
  },

  async getDashboardMetrics(financialYearId?: string): Promise<DashboardMetrics> {
    const q = financialYearId ? `?financialYearId=${encodeURIComponent(financialYearId)}` : '';
    return this.request<DashboardMetrics>(`/dashboard${q}`);
  },

  // Shipments
  async getShipments(params?: {
    financialYearId?: string;
    consigneeId?: string;
    paymentStatus?: string;
    reviewStatus?: string;
    search?: string;
  }): Promise<Shipment[]> {
    const q = new URLSearchParams();
    if (params?.financialYearId) q.append('financialYearId', params.financialYearId);
    if (params?.consigneeId) q.append('consigneeId', params.consigneeId);
    if (params?.paymentStatus) q.append('paymentStatus', params.paymentStatus);
    if (params?.reviewStatus) q.append('reviewStatus', params.reviewStatus);
    if (params?.search) q.append('search', params.search);
    return this.request<Shipment[]>(`/shipments?${q.toString()}`);
  },

  async getShipmentById(id: string): Promise<Shipment> {
    return this.request<Shipment>(`/shipments/${id}`);
  },

  async lookupShipments(query: string, financialYearId?: string): Promise<{ normalizedQueryKey: string; matches: Shipment[] }> {
    const q = new URLSearchParams({ q: query });
    if (financialYearId) q.append('financialYearId', financialYearId);
    return this.request<{ normalizedQueryKey: string; matches: Shipment[] }>(`/shipments/lookup?${q.toString()}`);
  },

  async checkInvoiceUnique(
    invoiceNumber: string,
    financialYearId: string
  ): Promise<{ isUnique: boolean; normalizedKey: string; existingInvoiceNumber?: string }> {
    const q = new URLSearchParams({ invoiceNumber, financialYearId });
    return this.request<{ isUnique: boolean; normalizedKey: string; existingInvoiceNumber?: string }>(
      `/shipments/check-unique?${q.toString()}`
    );
  },

  async createShipmentWithDocuments(formData: FormData): Promise<Shipment> {
    return this.request<Shipment>('/shipments/create-with-documents', {
      method: 'POST',
      body: formData,
    });
  },

  async createShipment(data: any): Promise<Shipment> {
    return this.request<Shipment>('/shipments', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateShipment(id: string, updates: Partial<Shipment>): Promise<Shipment> {
    return this.request<Shipment>(`/shipments/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async deleteShipment(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/shipments/${id}`, {
      method: 'DELETE',
    });
  },

  // Payments & Allocations
  async getPayments(): Promise<Payment[]> {
    return this.request<Payment[]>('/payments');
  },

  async getPaymentById(id: string): Promise<Payment> {
    return this.request<Payment>(`/payments/${id}`);
  },

  async createPayment(data: any): Promise<Payment> {
    return this.request<Payment>('/payments', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updatePayment(id: string, updates: Partial<Payment>): Promise<Payment> {
    return this.request<Payment>(`/payments/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  async deletePayment(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/payments/${id}`, {
      method: 'DELETE',
    });
  },

  async allocatePayment(data: {
    paymentId: string;
    shipmentId: string;
    allocatedAmountUsd: number;
    notes?: string;
  }): Promise<PaymentAllocation> {
    return this.request<PaymentAllocation>('/allocations', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async deallocatePayment(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/allocations/${id}`, {
      method: 'DELETE',
    });
  },

  // Incentives & BRC
  async updateIncentive(id: string, data: any): Promise<IncentiveRecord> {
    return this.request<IncentiveRecord>(`/incentives/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteIncentive(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/incentives/${id}`, {
      method: 'DELETE',
    });
  },

  async updateBrc(id: string, data: any): Promise<BrcRecord> {
    return this.request<BrcRecord>(`/brc/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  // Documents
  async uploadDocument(formData: FormData): Promise<{ document: DocumentRecord; extraction: any }> {
    return this.request<{ document: DocumentRecord; extraction: any }>('/documents/upload', {
      method: 'POST',
      body: formData,
    });
  },

  getDocumentDownloadUrl(id: string): string {
    const token = this.getToken();
    return `/api/documents/${id}/download${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  },

  async reviewDocument(id: string, reviewStatus: string): Promise<DocumentRecord> {
    return this.request<DocumentRecord>(`/documents/${id}/review`, {
      method: 'PUT',
      body: JSON.stringify({ reviewStatus }),
    });
  },

  async deleteDocument(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/documents/${id}`, {
      method: 'DELETE',
    });
  },

  // Masters
  async getConsignees(): Promise<ConsigneeMaster[]> {
    return this.request<ConsigneeMaster[]>('/masters/consignees');
  },

  async createConsignee(data: any): Promise<ConsigneeMaster> {
    return this.request<ConsigneeMaster>('/masters/consignees', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateConsignee(id: string, data: any): Promise<ConsigneeMaster> {
    return this.request<ConsigneeMaster>(`/masters/consignees/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteConsignee(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/masters/consignees/${id}`, {
      method: 'DELETE',
    });
  },

  async getBanks(): Promise<BankMaster[]> {
    return this.request<BankMaster[]>('/masters/banks');
  },

  async createBank(data: any): Promise<BankMaster> {
    return this.request<BankMaster>('/masters/banks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateBank(id: string, data: any): Promise<BankMaster> {
    return this.request<BankMaster>(`/masters/banks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteBank(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/masters/banks/${id}`, {
      method: 'DELETE',
    });
  },

  // Excel
  getExportUrl(financialYearId?: string): string {
    const token = this.getToken();
    const q = new URLSearchParams();
    if (financialYearId) q.append('financialYearId', financialYearId);
    if (token) q.append('token', token);
    return `/api/excel/export?${q.toString()}`;
  },

  async importExcel(formData: FormData): Promise<any> {
    return this.request<any>('/excel/import', {
      method: 'POST',
      body: formData,
    });
  },

  // Audit
  async getAuditLogs(limit = 100): Promise<AuditLog[]> {
    return this.request<AuditLog[]>(`/audit?limit=${limit}`);
  },

  // Users (Super Admin)
  async getUsers(): Promise<User[]> {
    return this.request<User[]>('/users');
  },

  async createUser(data: any): Promise<User> {
    return this.request<User>('/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateUser(id: string, data: any): Promise<User> {
    return this.request<User>(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  // Settings
  async getSettings(): Promise<AppSettings> {
    return this.request<AppSettings>('/settings');
  },

  async updateSettings(data: Partial<AppSettings>): Promise<AppSettings> {
    return this.request<AppSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },
};
