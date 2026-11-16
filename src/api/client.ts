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
  GstEntry,
  GstSummary,
  GstResult,
  AppSettings,
  DashboardMetrics,
  Role,
  OcrJob,
  Supplier,
  B2bInvoice,
  B2bMonthlySummary,
  B2bDashboardMetrics,
  ImportBatch,
  B2bImportPreview,
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

  async logout(): Promise<void> {
    try {
      await this.request<{ success: boolean }>('/auth/logout', { method: 'POST' });
    } catch {}
    this.clearToken();
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
  async login(email: string, password: string): Promise<{ token: string; user: User; mustChangePassword?: boolean }> {
    const res = await this.request<{ token: string; user: User; mustChangePassword?: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.setToken(res.token);
    return res;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<{
    success: boolean;
    message: string;
    token: string;
    user: User;
  }> {
    const res = await this.request<{
      success: boolean;
      message: string;
      token: string;
      user: User;
    }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (res.token) {
      this.setToken(res.token);
    }
    return res;
  },

  async getDownloadTicket(fileId?: string): Promise<string> {
    const q = fileId ? `?fileId=${encodeURIComponent(fileId)}` : '';
    const res = await this.request<{ ticket: string }>(`/auth/download-ticket${q}`);
    return res.ticket;
  },

  async downloadAuthenticated(apiPathWithQuery: string, fallbackFilename: string): Promise<void> {
    const token = this.getToken();
    const headers = new Headers();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const normalizedPath = apiPathWithQuery.startsWith('/api') ? apiPathWithQuery : `/api${apiPathWithQuery}`;
    const response = await fetch(normalizedPath, { headers });
    if (!response.ok) {
      let errMsg = `Download failed (${response.status})`;
      try {
        const json = await response.json();
        if (json?.error) errMsg = json.error;
      } catch {}
      throw new Error(errMsg);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] ? decodeURIComponent(match[1]) : fallbackFilename;

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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

  async archiveShipment(id: string, reason?: string): Promise<Shipment> {
    return this.request<Shipment>(`/shipments/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  async restoreShipment(id: string): Promise<Shipment> {
    return this.request<Shipment>(`/shipments/${id}/restore`, {
      method: 'POST',
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
  async createIncentive(data: any): Promise<IncentiveRecord> {
    return this.request<IncentiveRecord>('/incentives', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

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

  async resetBrc(id: string): Promise<BrcRecord> {
    return this.request<BrcRecord>(`/brc/${id}/reset`, {
      method: 'POST',
    });
  },

  // Documents
  async uploadDocument(formData: FormData): Promise<{ document: DocumentRecord; extraction: any }> {
    return this.request<{ document: DocumentRecord; extraction: any }>('/documents/upload', {
      method: 'POST',
      body: formData,
    });
  },

  getDocumentDownloadUrl(id: string, ticket?: string): string {
    return `/api/documents/${id}/download${ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''}`;
  },

  async downloadDocument(id: string, filename = 'document.pdf'): Promise<void> {
    return this.downloadAuthenticated(`/documents/${id}/download`, filename);
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

  async extractDocumentsBatch(formData: FormData): Promise<{
    success: boolean;
    totalFilesParsed: number;
    mergedDraft: any;
    extractions: Record<string, any>;
    conflicts?: any[];
  }> {
    return this.request<any>('/documents/extract-batch', {
      method: 'POST',
      body: formData,
    });
  },

  // Excel & CSV
  getExportUrl(financialYearId?: string): string {
    const q = new URLSearchParams();
    if (financialYearId) q.append('financialYearId', financialYearId);
    const qs = q.toString();
    return `/api/excel/export${qs ? `?${qs}` : ''}`;
  },

  async downloadExportExcel(financialYearId?: string): Promise<void> {
    const q = new URLSearchParams();
    if (financialYearId) q.append('financialYearId', financialYearId);
    const qs = q.toString();
    return this.downloadAuthenticated(`/excel/export${qs ? `?${qs}` : ''}`, 'SKE_Export_Tracker.xlsx');
  },

  getExportCsvUrl(sheetName: string, financialYearId?: string): string {
    const q = new URLSearchParams();
    q.append('sheet', sheetName);
    if (financialYearId) q.append('financialYearId', financialYearId);
    return `/api/excel/export-csv?${q.toString()}`;
  },

  async downloadExportCsv(sheetName: string, financialYearId?: string): Promise<void> {
    const q = new URLSearchParams();
    q.append('sheet', sheetName);
    if (financialYearId) q.append('financialYearId', financialYearId);
    const safeName = sheetName.replace(/[^a-zA-Z0-9_\-]/g, '_');
    return this.downloadAuthenticated(`/excel/export-csv?${q.toString()}`, `SKE_${safeName}.csv`);
  },

  async importExcel(formData: FormData): Promise<any> {
    return this.request<any>('/excel/import', {
      method: 'POST',
      body: formData,
    });
  },

  // OCR Background Queue & Staging
  async getOcrJobs(status?: string, category?: string): Promise<{ jobs: OcrJob[]; concurrency: { activeJobs: number; maxConcurrency: number } }> {
    const q = new URLSearchParams();
    if (status) q.append('status', status);
    if (category) q.append('category', category);
    return this.request<{ jobs: OcrJob[]; concurrency: { activeJobs: number; maxConcurrency: number } }>(`/ocr/jobs?${q.toString()}`);
  },

  async getOcrJob(id: string): Promise<OcrJob> {
    return this.request<OcrJob>(`/ocr/jobs/${id}`);
  },

  async queueOcrJob(formData: FormData): Promise<{ success: boolean; message: string; job: OcrJob }> {
    return this.request<{ success: boolean; message: string; job: OcrJob }>('/ocr/jobs', {
      method: 'POST',
      body: formData,
    });
  },

  async retryOcrJob(id: string): Promise<OcrJob> {
    return this.request<OcrJob>(`/ocr/jobs/${id}/retry`, {
      method: 'POST',
    });
  },

  async deleteOcrJob(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/ocr/jobs/${id}`, {
      method: 'DELETE',
    });
  },

  async approveOcrJob(id: string, reviewedValues: Record<string, any>): Promise<{ success: boolean; message: string; shipment?: Shipment; payment?: Payment; job: OcrJob }> {
    return this.request<{ success: boolean; message: string; shipment?: Shipment; payment?: Payment; job: OcrJob }>(`/ocr/jobs/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reviewedValues }),
    });
  },

  // GST Entries
  async getGstEntries(params?: {
    consigneeId?: string;
    result?: GstResult | string;
    search?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ entries: GstEntry[]; total: number; summary: GstSummary }> {
    const q = new URLSearchParams();
    if (params?.consigneeId) q.set('consigneeId', params.consigneeId);
    if (params?.result) q.set('result', params.result);
    if (params?.search) q.set('search', params.search);
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.sortBy) q.set('sortBy', params.sortBy);
    if (params?.sortOrder) q.set('sortOrder', params.sortOrder);

    const queryString = q.toString();
    return this.request<{ entries: GstEntry[]; total: number; summary: GstSummary }>(
      `/gst-entries${queryString ? `?${queryString}` : ''}`
    );
  },

  async getGstSummary(params?: { consigneeId?: string; startDate?: string; endDate?: string }): Promise<GstSummary> {
    const q = new URLSearchParams();
    if (params?.consigneeId) q.set('consigneeId', params.consigneeId);
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    const queryString = q.toString();
    return this.request<GstSummary>(`/gst-entries/summary${queryString ? `?${queryString}` : ''}`);
  },

  getGstExportUrl(params?: {
    consigneeId?: string;
    result?: string;
    search?: string;
    startDate?: string;
    endDate?: string;
  }): string {
    const q = new URLSearchParams();
    if (params?.consigneeId && params.consigneeId !== 'ALL') q.set('consigneeId', params.consigneeId);
    if (params?.result && params.result !== 'ALL') q.set('result', params.result);
    if (params?.search) q.set('search', params.search);
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    const queryString = q.toString();
    return `/api/gst-entries/export${queryString ? `?${queryString}` : ''}`;
  },

  async downloadGstExport(params?: {
    consigneeId?: string;
    result?: string;
    search?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<void> {
    const q = new URLSearchParams();
    if (params?.consigneeId && params.consigneeId !== 'ALL') q.set('consigneeId', params.consigneeId);
    if (params?.result && params.result !== 'ALL') q.set('result', params.result);
    if (params?.search) q.set('search', params.search);
    if (params?.startDate) q.set('startDate', params.startDate);
    if (params?.endDate) q.set('endDate', params.endDate);
    const queryString = q.toString();
    return this.downloadAuthenticated(`/gst-entries/export${queryString ? `?${queryString}` : ''}`, 'SKE_GST_Entries.xlsx');
  },

  async createGstEntry(data: {
    entryDate: string;
    consigneeId: string;
    igst: number;
    cgst: number;
    sgst: number;
    refundEligible: number;
    remarks?: string;
  }): Promise<GstEntry> {
    return this.request<GstEntry>('/gst-entries', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateGstEntry(
    id: string,
    data: Partial<{
      entryDate: string;
      consigneeId: string;
      igst: number;
      cgst: number;
      sgst: number;
      refundEligible: number;
      remarks?: string;
    }>
  ): Promise<GstEntry> {
    return this.request<GstEntry>(`/gst-entries/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteGstEntry(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/gst-entries/${id}`, {
      method: 'DELETE',
    });
  },

  // --- B2B GST Management Module ---
  async getB2bDashboard(financialYear?: string): Promise<B2bDashboardMetrics> {
    const query = financialYear ? `?financialYear=${encodeURIComponent(financialYear)}` : '';
    return this.request<B2bDashboardMetrics>(`/b2b/dashboard${query}`);
  },

  async getB2bMonthlySummaries(financialYear?: string): Promise<B2bMonthlySummary[]> {
    const query = financialYear ? `?financialYear=${encodeURIComponent(financialYear)}` : '';
    return this.request<B2bMonthlySummary[]>(`/b2b/monthly${query}`);
  },

  async getB2bMonthDetail(periodKey: string): Promise<{
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
  }> {
    return this.request(`/b2b/monthly/${encodeURIComponent(periodKey)}`);
  },

  async getB2bInvoices(filters?: {
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
  }): Promise<{
    data: B2bInvoice[];
    total: number;
    page: number;
    limit: number;
    totalTaxableValue: number;
    totalGst: number;
    totalInvoiceValue: number;
  }> {
    const params = new URLSearchParams();
    if (filters?.periodKey && filters.periodKey !== 'ALL') params.set('periodKey', filters.periodKey);
    if (filters?.financialYear && filters.financialYear !== 'ALL') params.set('financialYear', filters.financialYear);
    if (filters?.supplierGstin && filters.supplierGstin !== 'ALL') params.set('supplierGstin', filters.supplierGstin);
    if (filters?.invoiceType && filters.invoiceType !== 'ALL') params.set('invoiceType', filters.invoiceType);
    if (filters?.reverseCharge && filters.reverseCharge !== 'ALL') params.set('reverseCharge', filters.reverseCharge);
    if (filters?.itcAvailability && filters.itcAvailability !== 'ALL') params.set('itcAvailability', filters.itcAvailability);
    if (filters?.search) params.set('search', filters.search);
    if (filters?.page) params.set('page', String(filters.page));
    if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
    if (filters?.sortBy) params.set('sortBy', filters.sortBy);
    if (filters?.sortOrder) params.set('sortOrder', filters.sortOrder);

    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/b2b/invoices${qs}`);
  },

  async getB2bInvoiceById(id: string): Promise<B2bInvoice> {
    return this.request<B2bInvoice>(`/b2b/invoices/${id}`);
  },

  async createB2bInvoice(data: any): Promise<B2bInvoice> {
    return this.request<B2bInvoice>('/b2b/invoices', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateB2bInvoice(id: string, data: any): Promise<B2bInvoice> {
    return this.request<B2bInvoice>(`/b2b/invoices/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteB2bInvoice(id: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/b2b/invoices/${id}`, {
      method: 'DELETE',
    });
  },

  async getB2bSuppliers(search?: string): Promise<Supplier[]> {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    return this.request<Supplier[]>(`/b2b/suppliers${query}`);
  },

  async getB2bSupplierById(id: string): Promise<Supplier> {
    return this.request<Supplier>(`/b2b/suppliers/${id}`);
  },

  async createB2bSupplier(data: {
    gstin: string;
    legalName: string;
    tradeName?: string;
    address?: string;
    state?: string;
  }): Promise<Supplier> {
    return this.request<Supplier>('/b2b/suppliers', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateB2bSupplier(id: string, data: Partial<Supplier>): Promise<Supplier> {
    return this.request<Supplier>(`/b2b/suppliers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteB2bSupplier(id: string): Promise<{ success: boolean; message: string }> {
    return this.request<{ success: boolean; message: string }>(`/b2b/suppliers/${id}`, {
      method: 'DELETE',
    });
  },

  async previewB2bImport(file: File): Promise<B2bImportPreview> {
    const formData = new FormData();
    formData.append('file', file);
    return this.request<B2bImportPreview>('/b2b/import/preview', {
      method: 'POST',
      body: formData,
    });
  },

  async commitB2bImport(
    previewData: B2bImportPreview,
    mode: 'SKIP_EXISTING' | 'OVERWRITE_EXISTING' | 'INSERT_ALL',
    fileName: string,
    fileSizeBytes?: number
  ): Promise<{ batchId: string; totalProcessed: number; inserted: number; updated: number; skipped: number }> {
    return this.request('/b2b/import/commit', {
      method: 'POST',
      body: JSON.stringify({ previewData, mode, fileName, fileSizeBytes }),
    });
  },

  async getB2bImportBatches(): Promise<ImportBatch[]> {
    return this.request<ImportBatch[]>('/b2b/import/batches');
  },

  getB2bExportUrl(params?: {
    reportType?: string;
    periodKey?: string;
    financialYear?: string;
    supplierGstin?: string;
  }): string {
    const qs = new URLSearchParams();
    if (params?.reportType) qs.set('reportType', params.reportType);
    if (params?.periodKey && params.periodKey !== 'ALL') qs.set('periodKey', params.periodKey);
    if (params?.financialYear && params.financialYear !== 'ALL') qs.set('financialYear', params.financialYear);
    if (params?.supplierGstin && params.supplierGstin !== 'ALL') qs.set('supplierGstin', params.supplierGstin);
    return `/api/b2b/export?${qs.toString()}`;
  },

  async downloadB2bExport(params?: {
    reportType?: string;
    periodKey?: string;
    financialYear?: string;
    supplierGstin?: string;
  }): Promise<void> {
    const qs = new URLSearchParams();
    if (params?.reportType) qs.set('reportType', params.reportType);
    if (params?.periodKey && params.periodKey !== 'ALL') qs.set('periodKey', params.periodKey);
    if (params?.financialYear && params.financialYear !== 'ALL') qs.set('financialYear', params.financialYear);
    if (params?.supplierGstin && params.supplierGstin !== 'ALL') qs.set('supplierGstin', params.supplierGstin);
    return this.downloadAuthenticated(`/b2b/export?${qs.toString()}`, 'SKE_B2B_Export.xlsx');
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

  async deleteUser(id: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/users/${id}`, {
      method: 'DELETE',
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

  // System Data Purge
  async clearAllRecords(): Promise<{ success: boolean; cleared: Record<string, number> }> {
    return this.request<{ success: boolean; cleared: Record<string, number> }>('/system/clear-records', {
      method: 'POST',
    });
  },
};
