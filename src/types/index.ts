/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'VIEWER';

export type DocumentCategory =
  | 'COMMERCIAL_INVOICE'
  | 'SHIPPING_BILL'
  | 'FIRC_PAYMENT'
  | 'BILL_OF_LADING'
  | 'BRC_COPY_1'
  | 'BRC_COPY_2'
  | 'ADDITIONAL_DOC';

export type ReviewStatus =
  | 'EXTRACTED'
  | 'NEEDS_REVIEW'
  | 'CONFIRMED'
  | 'MANUALLY_ENTERED';

export type PaymentStatus =
  | 'UNPAID'
  | 'PART_PAID'
  | 'FULLY_PAID'
  | 'EXCESS_RECEIVED'
  | 'REVIEW_REQUIRED';

export type IncentiveType = 'DRAWBACK' | 'RODTEP' | 'ROSCTL';

export type IncentiveStatus = 'PENDING' | 'PART_RECEIVED' | 'RECEIVED';

export type BrcUploadMode = 'SINGLE' | 'MULTIPLE';

export type BrcStatus = 'PENDING' | 'ISSUED' | 'REALISED' | 'OVERDUE';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FinancialYear {
  id: string;
  label: string; // e.g. "2026-27"
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

export interface ConsigneeMaster {
  id: string;
  name: string;
  country: string;
  portOfDischarge: string;
  paymentTerms: string;
  currency: string;
  contactEmail?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BankMaster {
  id: string;
  name: string;
  branch: string;
  adCode: string;
  ifscCode: string;
  swiftCode: string;
  accountNumber: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceItem {
  id: string;
  shipmentId: string;
  description: string;
  hsnCode?: string;
  quantity: number;
  unit: string;
  rateUsd: number;
  amountUsd: number;
}

export interface DocumentRecord {
  id: string;
  shipmentId?: string;
  paymentId?: string;
  category: DocumentCategory;
  originalFilename: string;
  storedPath: string;
  mimeType: string;
  fileSizeBytes: number;
  version: number;
  isCurrent: boolean;
  reviewStatus: ReviewStatus;
  ocrApplied?: boolean;
  ocrConfidence?: number;
  ocrTextPreview?: string;
  extractionMethod?: 'PDF_TEXT' | 'LOCAL_OCR' | 'MANUAL';
  extractedFieldsJson?: string;
  extractedData?: Record<string, any>;
  uploadedByUserId: string;
  uploadedByName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedFieldResult {
  value: string | number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'MISSING';
  snippet?: string;
  sourceDoc?: string;
  pageNumber?: number;
  extractionMethod?: 'PDF_TEXT' | 'LOCAL_OCR' | 'MANUAL';
  rawSnippet?: string;
}

export interface ExtractionConflict {
  field: string;
  fieldName: string;
  severity: 'WARNING' | 'ERROR';
  message: string;
  sources: Record<string, any>;
  recommendedValue?: any;
}

export interface DocumentExtractionResult {
  category: DocumentCategory;
  rawText: string;
  pageCount: number;
  reviewStatus: ReviewStatus;
  fields: Record<string, ExtractedFieldResult>;
  snippets: string[];
  ocrApplied?: boolean;
  ocrConfidence?: number;
  ocrTextPreview?: string;
  extractionMethod?: 'PDF_TEXT' | 'LOCAL_OCR';
}

export interface MergedShipmentDraft {
  invoiceNumber?: string;
  invoiceDate?: string;
  consigneeName?: string;
  buyerName?: string;
  portCode?: string;
  packageCount?: number;
  invoiceValueUsd?: number;
  shippingBillNumber?: string;
  shippingBillDate?: string;
  sbExchangeRate?: number;
  fobValueInr?: number;
  blNumber?: string;
  blDate?: string;
  vesselName?: string;
  carrierName?: string;
  containerNumber?: string;
  grossWeightKg?: number;
  measurementCbm?: number;
  portOfLoading?: string;
  portOfDischarge?: string;
  fircIrmNumber?: string;
  fircSenderRef?: string;
  fircCreditDate?: string;
  fircValueDate?: string;
  fircAmountUsd?: number;
  fircExchangeRate?: number;
  fircInrAmount?: number;
  fircBankName?: string;
  brcNumber?: string;
  brcIssueDate?: string;
  brcRealisationDate?: string;
  brcRealisedAmount?: number;
  statutoryDeadline?: string;
  dbkClaimed?: number;
  rodtepClaimed?: number;
  rosctlClaimed?: number;
  extractedFields: Record<string, ExtractedFieldResult>;
  missingFields: string[];
  conflicts: ExtractionConflict[];
  lineItems?: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    totalUsd: number;
  }>;
}

export interface PaymentAllocation {
  id: string;
  paymentId: string;
  shipmentId: string;
  allocatedAmountUsd: number;
  notes?: string;
  allocatedAt: string;
  allocatedByUserId: string;
  allocatedByName?: string;
  // Denormalized for display
  paymentIrm?: string;
  shipmentInvoiceNo?: string;
}

export interface Payment {
  id: string;
  irmNumber: string;
  senderReference?: string;
  currency: string;
  verifiedAmount: number;
  inrAmount?: number;
  exchangeRate?: number;
  valueDate: string;
  creditDate: string;
  fircIssueDate?: string;
  bankId: string;
  bankName?: string;
  purposeCode?: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  documents?: DocumentRecord[];
  allocations?: PaymentAllocation[];
  // Calculated
  totalAllocatedUsd?: number;
  availableBalanceUsd?: number;
}

export interface IncentiveRecord {
  id: string;
  shipmentId: string;
  type: IncentiveType;
  claimedAmount: number;
  status: IncentiveStatus;
  receivedAmount: number;
  receivedDate?: string;
  scrollNumber?: string;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  // Calculated
  outstandingBalance?: number;
}

export interface BrcRecord {
  id: string;
  shipmentId: string;
  brcNumber?: string;
  issueDate?: string;
  realisationDate?: string;
  realisedAmount?: number;
  realisedCurrency?: string;
  uploadMode: BrcUploadMode;
  statutoryDeadline?: string;
  status: BrcStatus;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
  documents?: DocumentRecord[];
}

export interface Shipment {
  id: string;
  financialYearId: string;
  financialYearLabel?: string;
  invoiceNumber: string;
  normalizedInvoiceKey: string;
  invoiceDate: string;
  consigneeId: string;
  consigneeName?: string;
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

  paymentStatus: PaymentStatus;
  reviewStatus: ReviewStatus;
  remarks?: string;
  isArchived?: boolean;
  archivedAt?: string;
  archivedReason?: string;
  createdAt: string;
  updatedAt: string;

  items?: InvoiceItem[];
  documents?: DocumentRecord[];
  allocations?: PaymentAllocation[];
  incentives?: IncentiveRecord[];
  brcRecord?: BrcRecord;

  // Real-time calculated fields
  totalPaidUsd?: number;
  balanceDueUsd?: number;
  realisedInr?: number;
  averageRealisedRate?: number;
  hasFircEvidence?: boolean;
}

export type GstResult = 'GAIN' | 'LOSS' | 'NIL';

export interface GstEntry {
  id: string;
  entryNumber: string;
  entryDate: string; // YYYY-MM-DD
  consigneeId: string;
  consigneeName?: string;
  igst: number;
  cgst: number;
  sgst: number;
  totalGst: number;
  refundEligible: number;
  difference: number;
  result: GstResult;
  remarks?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GstSummary {
  totalEntries: number;
  totalIgst: number;
  totalCgst: number;
  totalSgst: number;
  totalGst: number;
  totalRefundEligible: number;
  netDifference: number;
  gainCount: number;
  lossCount: number;
  nilCount: number;
}

export interface AppSettings {
  id?: string;
  statutoryBrcDays: number;
  defaultPortCode: string;
  baseCurrency: string;
  allowOverAllocation: boolean;
  companyName: string;
  iecNumber: string;
  panNumber: string;
}

export interface DashboardMetrics {
  totalShipments: number;
  totalInvoiceValueUsd: number;
  totalRealisedUsd: number;
  totalOutstandingUsd: number;
  unpaidCount: number;
  partPaidCount: number;
  fullyPaidCount: number;
  excessCount: number;
  incentivesClaimedInr: number;
  incentivesReceivedInr: number;
  incentivesPendingInr: number;
  brcPendingCount: number;
  brcRealisedCount: number;
  brcOverdueCount: number;
  pendingReviewCount: number;
  recentGstEntries?: GstEntry[];
}

export interface ImportValidationReport {
  totalRowsRead: number;
  acceptedRows: number;
  rejectedRows: number;
  warningsCount: number;
  rejectionLog: Array<{
    rowNumber: number;
    invoiceNo: string;
    consignee: string;
    reason: string;
  }>;
  warnings: Array<{
    rowNumber: number;
    invoiceNo: string;
    message: string;
  }>;
  importedShipmentIds: string[];
}

export type OcrJobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface OcrJob {
  id: string;
  documentId?: string;
  originalFilename: string;
  fileSizeBytes: number;
  category: DocumentCategory;
  financialYearId?: string;
  status: OcrJobStatus;
  attempts: number;
  maxAttempts: number;
  error?: string;
  executionTimeMs?: number;
  ocrApplied?: boolean;
  ocrConfidence?: number;
  ocrTextPreview?: string;
  extractionMethod?: 'PDF_TEXT' | 'LOCAL_OCR';
  candidateFields?: Record<string, ExtractedFieldResult>;
  candidateDraft?: MergedShipmentDraft;
  lockedByWorkerId?: string;
  lockedAt?: string;
  leaseExpiresAt?: string;
  approvedAt?: string;
  approvedByUserId?: string;
  approvedByName?: string;
  targetShipmentId?: string;
  targetPaymentId?: string;
  createdAt: string;
  updatedAt: string;
}

