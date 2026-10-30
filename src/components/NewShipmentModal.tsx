/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Upload,
  AlertCircle,
  CheckCircle2,
  FileText,
  FileSpreadsheet,
  Ship,
  Award,
  DollarSign,
  FilePlus,
  Trash2,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Info,
  Calendar,
  Layers,
  KeyRound,
  ShieldCheck,
  Check,
} from 'lucide-react';
import { ConsigneeMaster, BankMaster, FinancialYear } from '../types/index.ts';
import { api } from '../api/client.ts';
import { normalizeInvoiceKey } from '../../server/normalizer.ts';

interface NewShipmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  selectedFyId: string;
  financialYears: FinancialYear[];
  consignees: ConsigneeMaster[];
  banks: BankMaster[];
}

type BrcMode = 'SINGLE' | 'MULTIPLE';

interface SelectedFileItem {
  file: File;
  name: string;
  size: string;
}

export const NewShipmentModal: React.FC<NewShipmentModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  selectedFyId,
  financialYears,
  consignees,
  banks,
}) => {
  // 1. Financial Year (default 2026-2027)
  const defaultFy = financialYears.find(
    (f) => f.label.includes('2026') || f.id.includes('2026') || f.isCurrent
  )?.id || selectedFyId || 'fy-2026-27';

  const [fyId, setFyId] = useState(defaultFy);

  // 2. Invoice Number (Unique, Primary)
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [normalizedKey, setNormalizedKey] = useState('');
  const [isCheckingUnique, setIsCheckingUnique] = useState(false);
  const [isUnique, setIsUnique] = useState<boolean | null>(null);
  const [existingInvoiceNumber, setExistingInvoiceNumber] = useState<string | null>(null);

  // 3. Document Files (All in one form)
  const [invoiceFile, setInvoiceFile] = useState<SelectedFileItem | null>(null);
  const [sbFile, setSbFile] = useState<SelectedFileItem | null>(null);
  const [blFile, setBlFile] = useState<SelectedFileItem | null>(null);
  
  // BRC Copy: Single (max 1 file) vs Multiple (max 2 files)
  const [brcMode, setBrcMode] = useState<BrcMode>('SINGLE');
  const [brcFile1, setBrcFile1] = useState<SelectedFileItem | null>(null);
  const [brcFile2, setBrcFile2] = useState<SelectedFileItem | null>(null);

  const [fircFile, setFircFile] = useState<SelectedFileItem | null>(null);
  const [additionalFile, setAdditionalFile] = useState<SelectedFileItem | null>(null);

  // 4. Remarks (Optional Text)
  const [remarks, setRemarks] = useState('');

  // 5. Optional Commercial Details (Collapsible drawer with auto-extracted/smart defaults)
  const [showOptionalDetails, setShowOptionalDetails] = useState(false);
  const [consigneeId, setConsigneeId] = useState(consignees[0]?.id || '');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
  const [invoiceValueUsd, setInvoiceValueUsd] = useState<number | ''>('');
  const [shippingBillNumber, setShippingBillNumber] = useState('');
  const [shippingBillDate, setShippingBillDate] = useState(new Date().toISOString().split('T')[0]);
  const [sbExchangeRate, setSbExchangeRate] = useState<number>(84.5);
  const [fobValueInr, setFobValueInr] = useState<number | ''>('');
  const [blNumber, setBlNumber] = useState('');
  const [blDate, setBlDate] = useState('');
  const [vesselName, setVesselName] = useState('');
  const [portCode, setPortCode] = useState('INNSA1');
  const [packageCount, setPackageCount] = useState<number | ''>('');

  // UI State
  const [submitting, setSubmitting] = useState(false);
  const [submitProgressText, setSubmitProgressText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState(false);

  // Hidden input refs for reliable click triggering
  const invoiceInputRef = useRef<HTMLInputElement>(null);
  const sbInputRef = useRef<HTMLInputElement>(null);
  const blInputRef = useRef<HTMLInputElement>(null);
  const brc1InputRef = useRef<HTMLInputElement>(null);
  const brc2InputRef = useRef<HTMLInputElement>(null);
  const fircInputRef = useRef<HTMLInputElement>(null);
  const additionalInputRef = useRef<HTMLInputElement>(null);

  // Sync initial financial year when modal opens
  useEffect(() => {
    if (isOpen) {
      const match = financialYears.find(
        (f) => f.label.includes('2026') || f.id.includes('2026') || f.isCurrent
      )?.id;
      setFyId(match || selectedFyId || 'fy-2026-27');
      if (consignees[0]?.id && !consigneeId) {
        setConsigneeId(consignees[0].id);
      }
    }
  }, [isOpen, financialYears, selectedFyId]);

  // Real-time debounced uniqueness check for Invoice Number
  useEffect(() => {
    if (!invoiceNumber.trim()) {
      setNormalizedKey('');
      setIsUnique(null);
      setExistingInvoiceNumber(null);
      return;
    }

    const nKey = normalizeInvoiceKey(invoiceNumber);
    setNormalizedKey(nKey);
    setIsCheckingUnique(true);

    const timer = setTimeout(async () => {
      try {
        const res = await api.checkInvoiceUnique(invoiceNumber.trim(), fyId);
        setIsUnique(res.isUnique);
        setExistingInvoiceNumber(res.existingInvoiceNumber || null);
      } catch (e) {
        console.warn('Uniqueness check error:', e);
      } finally {
        setIsCheckingUnique(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [invoiceNumber, fyId]);

  // Auto-calculate FOB INR when USD or rate changes
  useEffect(() => {
    if (typeof invoiceValueUsd === 'number' && invoiceValueUsd > 0) {
      const calcFob = Math.round(invoiceValueUsd * (sbExchangeRate || 84.5) * 100) / 100;
      setFobValueInr(calcFob);
    }
  }, [invoiceValueUsd, sbExchangeRate]);

  // Clean helper to format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleFileSelect = (
    e: React.ChangeEvent<HTMLInputElement>,
    setter: (item: SelectedFileItem | null) => void,
    categoryType?: string
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setter({
      file,
      name: file.name,
      size: formatFileSize(file.size),
    });

    // Auto-detect invoice number if not already entered
    if (categoryType === 'INVOICE' && !invoiceNumber) {
      const nameParts = file.name.replace(/\.[^/.]+$/, '').split(/[-_ ]+/);
      const possibleNum = nameParts.find((p) => /\d{2,}/.test(p));
      if (possibleNum) {
        setInvoiceNumber(`SKE/26-27/${possibleNum.padStart(3, '0')}`);
      }
    }
    // Reset the input value so selecting the same file again triggers change
    e.target.value = '';
  };

  // Submit all in one page
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!invoiceNumber.trim()) {
      setError('Invoice Number is required and acts as the unique primary key.');
      return;
    }

    if (isUnique === false) {
      setError(
        `Invoice number "${invoiceNumber}" is not unique in Financial Year ${financialYears.find((f) => f.id === fyId)?.label || fyId}. Existing invoice: ${existingInvoiceNumber}.`
      );
      return;
    }

    setSubmitting(true);
    setSubmitProgressText('Creating shipment record & uploading documents...');

    try {
      const formData = new FormData();
      formData.append('financialYearId', fyId);
      formData.append('invoiceNumber', invoiceNumber.trim());
      formData.append('brcUploadMode', brcMode);
      if (remarks.trim()) formData.append('remarks', remarks.trim());

      // Optional/Commercial fields
      if (consigneeId) formData.append('consigneeId', consigneeId);
      if (invoiceDate) formData.append('invoiceDate', invoiceDate);
      if (invoiceValueUsd !== '') formData.append('invoiceValueUsd', String(invoiceValueUsd));
      if (shippingBillNumber.trim()) formData.append('shippingBillNumber', shippingBillNumber.trim());
      if (shippingBillDate) formData.append('shippingBillDate', shippingBillDate);
      if (sbExchangeRate) formData.append('sbExchangeRate', String(sbExchangeRate));
      if (fobValueInr !== '') formData.append('fobValueInr', String(fobValueInr));
      if (blNumber.trim()) formData.append('blNumber', blNumber.trim());
      if (blDate) formData.append('blDate', blDate);
      if (vesselName.trim()) formData.append('vesselName', vesselName.trim());
      if (portCode.trim()) formData.append('portCode', portCode.trim());
      if (packageCount !== '') formData.append('packageCount', String(packageCount));

      // Append document files
      if (invoiceFile?.file) formData.append('invoiceDoc', invoiceFile.file);
      if (sbFile?.file) formData.append('shippingBillDoc', sbFile.file);
      if (blFile?.file) formData.append('blDoc', blFile.file);

      // BRC files according to selected mode
      if (brcFile1?.file) formData.append('brcDoc1', brcFile1.file);
      if (brcMode === 'MULTIPLE' && brcFile2?.file) {
        formData.append('brcDoc2', brcFile2.file);
      }

      if (fircFile?.file) formData.append('fircDoc', fircFile.file);
      if (additionalFile?.file) formData.append('additionalDoc', additionalFile.file);

      setSubmitProgressText('Uploading document vault to server...');
      await api.createShipmentWithDocuments(formData);

      setSuccessToast(true);
      setTimeout(() => {
        onSuccess();
        onClose();
        resetForm();
      }, 700);
    } catch (err: any) {
      console.error('Shipment creation error:', err);
      setError(err.message || 'Failed to create shipment and upload documents.');
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setInvoiceNumber('');
    setNormalizedKey('');
    setIsUnique(null);
    setInvoiceFile(null);
    setSbFile(null);
    setBlFile(null);
    setBrcMode('SINGLE');
    setBrcFile1(null);
    setBrcFile2(null);
    setFircFile(null);
    setAdditionalFile(null);
    setRemarks('');
    setError(null);
    setSuccessToast(false);
  };

  // Count total attached files
  const attachedFileCount = [
    invoiceFile,
    sbFile,
    blFile,
    brcFile1,
    brcMode === 'MULTIPLE' ? brcFile2 : null,
    fircFile,
    additionalFile,
  ].filter(Boolean).length;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <div className="bg-white w-full max-w-4xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in zoom-in-95 duration-150">
        {/* Header Bar */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-sm font-bold">
              <Upload size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-tight">New Export Shipment</h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/20 text-blue-300 border border-blue-400/30">
                  Single-Page Form
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Choose financial year, enter unique invoice number, and upload documents in one place
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            type="button"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 p-6 space-y-6">
          {/* Error Banner */}
          {error && (
            <div className="p-3.5 bg-red-50 border border-red-200 text-red-800 rounded-xl text-xs flex items-start space-x-2.5">
              <AlertCircle size={18} className="text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-bold text-red-900">Submission Error</p>
                <p className="mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {/* Success Banner */}
          {successToast && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-300 text-emerald-900 rounded-xl text-xs flex items-center space-x-2">
              <CheckCircle2 size={18} className="text-emerald-600 flex-shrink-0" />
              <span className="font-bold">Shipment successfully created and documents registered!</span>
            </div>
          )}

          {/* SECTION 1: FINANCIAL YEAR & INVOICE NUMBER */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4.5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
              <div className="flex items-center gap-2">
                <KeyRound size={16} className="text-blue-600" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  1. Financial Year & Primary Identification
                </h3>
              </div>
              <span className="text-[11px] text-slate-500 font-medium">Step 1 of 1 (Unified)</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Financial Year Selector (default 2026-2027) */}
              <div>
                <label className="flex items-center justify-between text-xs font-semibold text-slate-700 mb-1.5">
                  <span className="flex items-center gap-1.5">
                    <Calendar size={14} className="text-blue-600" />
                    Financial Year <span className="text-red-500">*</span>
                  </span>
                  <span className="text-[10px] text-blue-700 font-semibold bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200">
                    Default 2026-2027
                  </span>
                </label>
                <select
                  value={fyId}
                  onChange={(e) => setFyId(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2.5 bg-white text-xs font-semibold text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  {financialYears.map((fy) => (
                    <option key={fy.id} value={fy.id}>
                      FY {fy.label} {fy.isCurrent ? '(Current Fiscal Year)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  Export transactions and statutory realization deadlines are organized by fiscal year.
                </p>
              </div>

              {/* Invoice Number (Unique, Primary Key) */}
              <div>
                <label className="flex items-center justify-between text-xs font-semibold text-slate-700 mb-1.5">
                  <span className="flex items-center gap-1.5">
                    <FileText size={14} className="text-blue-600" />
                    Invoice No. (Unique, Primary) <span className="text-red-500">*</span>
                  </span>
                  <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                    Primary Key
                  </span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    required
                    placeholder="e.g. SKE/26-27/025"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    className={`w-full border rounded-lg p-2.5 bg-white text-xs font-bold text-slate-900 tracking-wide focus:outline-hidden focus:ring-2 ${
                      isUnique === false
                        ? 'border-red-400 focus:ring-red-500 bg-red-50/30'
                        : isUnique === true
                        ? 'border-emerald-400 focus:ring-emerald-500 bg-emerald-50/20'
                        : 'border-slate-300 focus:ring-blue-500'
                    }`}
                  />
                  {isCheckingUnique && (
                    <span className="absolute right-3 top-2.5 text-[11px] text-slate-400 animate-pulse">
                      Checking...
                    </span>
                  )}
                </div>

                {/* Uniqueness Feedback Badge */}
                <div className="mt-1 flex items-center justify-between text-[11px]">
                  {normalizedKey ? (
                    <span className="font-mono text-slate-500">
                      Key: <strong className="text-slate-700">{normalizedKey}</strong>
                    </span>
                  ) : (
                    <span className="text-slate-400">Must be unique within selected Financial Year</span>
                  )}

                  {isUnique === true && (
                    <span className="text-emerald-700 font-semibold flex items-center gap-1 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                      <Check size={12} className="text-emerald-600" />
                      Unique in this FY
                    </span>
                  )}
                  {isUnique === false && (
                    <span className="text-red-700 font-bold flex items-center gap-1 bg-red-50 px-1.5 py-0.5 rounded border border-red-200">
                      <AlertCircle size={12} className="text-red-600" />
                      Duplicate: already exists ({existingInvoiceNumber})
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* SECTION 2: DOCUMENT VAULT UPLOAD (ALL IN ONE PAGE) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers size={16} className="text-blue-600" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  2. Document Vault Upload (Single Page)
                </h3>
              </div>
              <span className="text-[11px] font-semibold text-slate-500">
                {attachedFileCount} file{attachedFileCount === 1 ? '' : 's'} staged
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {/* 1. Commercial Invoice (Max 1 file) */}
              <DocumentUploadCard
                title="Invoice"
                badgeText="Max 1 file"
                categoryBadge="Commercial Invoice"
                icon={<FileText size={18} className="text-blue-600" />}
                accentColor="blue"
                selectedFile={invoiceFile}
                onSelectClick={() => invoiceInputRef.current?.click()}
                onRemove={() => setInvoiceFile(null)}
                subtitle="Exports Invoice No, USD Value, Packages"
              />
              <input
                ref={invoiceInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                className="hidden"
                onChange={(e) => handleFileSelect(e, setInvoiceFile, 'INVOICE')}
              />

              {/* 2. Shipping Bill (Max 1 file) */}
              <DocumentUploadCard
                title="Shipping Bill"
                badgeText="Max 1 file"
                categoryBadge="Customs SB"
                icon={<FileSpreadsheet size={18} className="text-indigo-600" />}
                accentColor="indigo"
                selectedFile={sbFile}
                onSelectClick={() => sbInputRef.current?.click()}
                onRemove={() => setSbFile(null)}
                subtitle="Customs SB No, Date, CBIC Rate, FOB INR"
              />
              <input
                ref={sbInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                className="hidden"
                onChange={(e) => handleFileSelect(e, setSbFile, 'SB')}
              />

              {/* 3. BL Copy (Max 1 file) */}
              <DocumentUploadCard
                title="BL Copy"
                badgeText="Max 1 file"
                categoryBadge="Bill of Lading"
                icon={<Ship size={18} className="text-cyan-600" />}
                accentColor="cyan"
                selectedFile={blFile}
                onSelectClick={() => blInputRef.current?.click()}
                onRemove={() => setBlFile(null)}
                subtitle="Carrier Bill of Lading, Container, Vessel"
              />
              <input
                ref={blInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                className="hidden"
                onChange={(e) => handleFileSelect(e, setBlFile, 'BL')}
              />

              {/* 4. BRC Copy - Single (max 1 file) or Multiple (max 2 files) */}
              <div className="border border-slate-200 rounded-xl p-3.5 bg-white shadow-xs flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
                        <Award size={18} />
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-slate-800">BRC Copy</h4>
                        <span className="text-[10px] text-slate-400">eBRC Realisation Record</span>
                      </div>
                    </div>
                  </div>

                  {/* Mode Selector Toggle: Single vs Multiple */}
                  <div className="bg-slate-100 p-1 rounded-lg flex items-center justify-between text-[11px] font-semibold mb-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        setBrcMode('SINGLE');
                        setBrcFile2(null);
                      }}
                      className={`flex-1 py-1 rounded-md text-center transition-all ${
                        brcMode === 'SINGLE'
                          ? 'bg-white text-blue-700 shadow-xs font-bold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Single (Max 1 file)
                    </button>
                    <button
                      type="button"
                      onClick={() => setBrcMode('MULTIPLE')}
                      className={`flex-1 py-1 rounded-md text-center transition-all ${
                        brcMode === 'MULTIPLE'
                          ? 'bg-white text-blue-700 shadow-xs font-bold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Multiple (Max 2 files)
                    </button>
                  </div>

                  {/* Slots for BRC upload */}
                  <div className="space-y-2">
                    {/* BRC Slot 1 */}
                    <div className="p-2 border border-slate-200 rounded-lg bg-slate-50/70 text-xs flex items-center justify-between">
                      <div className="min-w-0 flex-1 pr-2">
                        <span className="text-[10px] font-bold text-slate-500 uppercase block">
                          {brcMode === 'MULTIPLE' ? 'BRC Copy 1 (Part 1)' : 'BRC Copy (Single)'}
                        </span>
                        {brcFile1 ? (
                          <span className="font-semibold text-slate-800 truncate block text-[11px]">
                            {brcFile1.name} ({brcFile1.size})
                          </span>
                        ) : (
                          <span className="text-slate-400 text-[11px]">No file selected</span>
                        )}
                      </div>
                      {brcFile1 ? (
                        <button
                          type="button"
                          onClick={() => setBrcFile1(null)}
                          className="p-1 text-slate-400 hover:text-red-600 rounded"
                        >
                          <Trash2 size={13} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => brc1InputRef.current?.click()}
                          className="px-2 py-1 bg-white border border-slate-300 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-100 flex items-center gap-1"
                        >
                          <Upload size={11} /> Browse
                        </button>
                      )}
                    </div>

                    {/* BRC Slot 2 (Only active when Multiple mode is selected) */}
                    {brcMode === 'MULTIPLE' && (
                      <div className="p-2 border border-slate-200 rounded-lg bg-slate-50/70 text-xs flex items-center justify-between animate-in fade-in duration-150">
                        <div className="min-w-0 flex-1 pr-2">
                          <span className="text-[10px] font-bold text-slate-500 uppercase block">
                            BRC Copy 2 (Part 2)
                          </span>
                          {brcFile2 ? (
                            <span className="font-semibold text-slate-800 truncate block text-[11px]">
                              {brcFile2.name} ({brcFile2.size})
                            </span>
                          ) : (
                            <span className="text-slate-400 text-[11px]">No file selected</span>
                          )}
                        </div>
                        {brcFile2 ? (
                          <button
                            type="button"
                            onClick={() => setBrcFile2(null)}
                            className="p-1 text-slate-400 hover:text-red-600 rounded"
                          >
                            <Trash2 size={13} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => brc2InputRef.current?.click()}
                            className="px-2 py-1 bg-white border border-slate-300 rounded text-[11px] font-semibold text-slate-700 hover:bg-slate-100 flex items-center gap-1"
                          >
                            <Upload size={11} /> Browse
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-100">
                  {brcMode === 'SINGLE'
                    ? 'Single BRC advice from bank'
                    : 'Split realisations with multiple eBRC certificates'}
                </div>
              </div>
              <input
                ref={brc1InputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                className="hidden"
                onChange={(e) => handleFileSelect(e, setBrcFile1, 'BRC1')}
              />
              <input
                ref={brc2InputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                className="hidden"
                onChange={(e) => handleFileSelect(e, setBrcFile2, 'BRC2')}
              />

              {/* 5. FIRC Copy (Max 1 file) */}
              <DocumentUploadCard
                title="FIRC Copy"
                badgeText="Max 1 file"
                categoryBadge="Inward Remittance"
                icon={<DollarSign size={18} className="text-emerald-600" />}
                accentColor="emerald"
                selectedFile={fircFile}
                onSelectClick={() => fircInputRef.current?.click()}
                onRemove={() => setFircFile(null)}
                subtitle="Foreign Inward Remittance Certificate / IRM"
              />
              <input
                ref={fircInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                className="hidden"
                onChange={(e) => handleFileSelect(e, setFircFile, 'FIRC')}
              />

              {/* 6. Additional Documents (Max 1 file) (optional) */}
              <DocumentUploadCard
                title="Additional Documents"
                badgeText="Max 1 file (optional)"
                categoryBadge="Supplementary"
                icon={<FilePlus size={18} className="text-purple-600" />}
                accentColor="purple"
                selectedFile={additionalFile}
                onSelectClick={() => additionalInputRef.current?.click()}
                onRemove={() => setAdditionalFile(null)}
                subtitle="Packing list, Certificate of Origin, Test Report"
                optional={true}
              />
              <input
                ref={additionalInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                className="hidden"
                onChange={(e) => handleFileSelect(e, setAdditionalFile, 'ADDITIONAL')}
              />
            </div>
          </div>

          {/* SECTION 3: REMARKS (TEXT) (OPTIONAL) */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4.5 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                <Info size={14} className="text-blue-600" />
                3. Remarks <span className="text-slate-400 text-[11px] font-normal lowercase">(text) (optional)</span>
              </label>
              <span className="text-[11px] text-slate-400 font-medium">Internal Notes & Banking References</span>
            </div>
            <textarea
              rows={2}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Enter any optional internal notes, buyer instructions, LC terms, or container details..."
              className="w-full border border-slate-300 rounded-lg p-2.5 bg-white text-xs text-slate-800 placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* SECTION 4: OPTIONAL COMMERCIAL & CUSTOMS DETAILS ACCORDION */}
          <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
            <button
              type="button"
              onClick={() => setShowOptionalDetails(!showOptionalDetails)}
              className="w-full px-4.5 py-3 bg-slate-50 hover:bg-slate-100/80 transition-colors flex items-center justify-between text-xs font-semibold text-slate-700"
            >
              <div className="flex items-center gap-2">
                <Sparkles size={15} className="text-blue-600" />
                <span>Commercial & Customs Details (Auto-extracted or Manual Override)</span>
                <span className="text-[10px] text-slate-400 font-normal">
                  — Consignee, Values, Dates, Shipping Bill details
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-slate-500">
                <span className="text-[11px]">{showOptionalDetails ? 'Hide' : 'Expand'}</span>
                {showOptionalDetails ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </div>
            </button>

            {showOptionalDetails && (
              <div className="p-4.5 border-t border-slate-200 space-y-4 text-xs animate-in fade-in duration-150">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5">
                  {/* Consignee */}
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Consignee (Buyer)</label>
                    <select
                      value={consigneeId}
                      onChange={(e) => setConsigneeId(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 bg-white"
                    >
                      {consignees.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.country})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Invoice Date */}
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Invoice Date</label>
                    <input
                      type="date"
                      value={invoiceDate}
                      onChange={(e) => setInvoiceDate(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2"
                    />
                  </div>

                  {/* Invoice Value USD */}
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Invoice Value (USD)</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 25000"
                      value={invoiceValueUsd}
                      onChange={(e) =>
                        setInvoiceValueUsd(e.target.value ? parseFloat(e.target.value) : '')
                      }
                      className="w-full border border-slate-300 rounded-lg p-2 font-semibold text-slate-800"
                    />
                  </div>

                  {/* Shipping Bill Number */}
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Shipping Bill No.</label>
                    <input
                      type="text"
                      placeholder="e.g. 7845120"
                      value={shippingBillNumber}
                      onChange={(e) => setShippingBillNumber(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2"
                    />
                  </div>

                  {/* Shipping Bill Date */}
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Shipping Bill Date</label>
                    <input
                      type="date"
                      value={shippingBillDate}
                      onChange={(e) => setShippingBillDate(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2"
                    />
                  </div>

                  {/* Exchange Rate */}
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Customs Ex. Rate (INR/USD)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={sbExchangeRate}
                      onChange={(e) => setSbExchangeRate(parseFloat(e.target.value) || 84.5)}
                      className="w-full border border-slate-300 rounded-lg p-2"
                    />
                  </div>

                  {/* Calculated FOB INR */}
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">FOB Value (INR)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={fobValueInr}
                      onChange={(e) =>
                        setFobValueInr(e.target.value ? parseFloat(e.target.value) : '')
                      }
                      placeholder="Auto-calculated (USD × Rate)"
                      className="w-full border border-slate-300 rounded-lg p-2 bg-slate-50 font-semibold"
                    />
                  </div>

                  {/* BL Number */}
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">BL Number</label>
                    <input
                      type="text"
                      placeholder="e.g. MAEU12345678"
                      value={blNumber}
                      onChange={(e) => setBlNumber(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2"
                    />
                  </div>

                  {/* Port Code */}
                  <div>
                    <label className="font-semibold text-slate-700 block mb-1">Customs Port Code</label>
                    <input
                      type="text"
                      value={portCode}
                      onChange={(e) => setPortCode(e.target.value)}
                      placeholder="e.g. INNSA1"
                      className="w-full border border-slate-300 rounded-lg p-2"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Modal Footer Controls */}
          <div className="pt-2 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3">
            <div className="text-xs text-slate-500 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              <span>
                Ready to commit: <strong>{attachedFileCount}</strong> document{attachedFileCount === 1 ? '' : 's'} attached
              </span>
            </div>

            <div className="flex items-center gap-2.5 w-full sm:w-auto">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="flex-1 sm:flex-initial px-4 py-2.5 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || isUnique === false || !invoiceNumber.trim()}
                className="flex-1 sm:flex-initial px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-xs font-bold shadow-md transition-all flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>{submitProgressText || 'Saving Shipment & Files...'}</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={16} />
                    <span>Create Shipment & Upload Documents</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

// Reusable Document Card Component
interface DocumentUploadCardProps {
  title: string;
  badgeText: string;
  categoryBadge: string;
  icon: React.ReactNode;
  accentColor: 'blue' | 'indigo' | 'cyan' | 'amber' | 'emerald' | 'purple';
  selectedFile: SelectedFileItem | null;
  onSelectClick: () => void;
  onRemove: () => void;
  subtitle: string;
  optional?: boolean;
}

const DocumentUploadCard: React.FC<DocumentUploadCardProps> = ({
  title,
  badgeText,
  categoryBadge,
  icon,
  accentColor,
  selectedFile,
  onSelectClick,
  onRemove,
  subtitle,
  optional = false,
}) => {
  const colorMap = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    cyan: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
  };

  return (
    <div
      className={`border rounded-xl p-3.5 bg-white shadow-xs flex flex-col justify-between transition-all ${
        selectedFile ? 'border-emerald-300 ring-1 ring-emerald-200 bg-emerald-50/10' : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${colorMap[accentColor]}`}>
              {icon}
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h4 className="text-xs font-bold text-slate-800">{title}</h4>
                {optional && (
                  <span className="text-[10px] text-slate-400 font-normal">(opt)</span>
                )}
              </div>
              <span className="text-[10px] text-slate-400 block">{categoryBadge}</span>
            </div>
          </div>
          <span
            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
              optional ? 'bg-slate-100 text-slate-600 border-slate-200' : 'bg-blue-50 text-blue-700 border-blue-200'
            }`}
          >
            {badgeText}
          </span>
        </div>

        {/* Selected file preview or upload button */}
        {selectedFile ? (
          <div className="p-2.5 rounded-lg bg-emerald-50/60 border border-emerald-200 text-xs flex items-center justify-between space-x-2 my-2">
            <div className="min-w-0 flex-1">
              <span className="font-bold text-slate-800 truncate block text-[11px]">
                {selectedFile.name}
              </span>
              <span className="text-[10px] text-emerald-700 font-medium">
                {selectedFile.size} • Ready to upload
              </span>
            </div>
            <button
              type="button"
              onClick={onRemove}
              className="p-1 text-slate-400 hover:text-red-600 rounded transition-colors"
              title="Remove file"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ) : (
          <div
            onClick={onSelectClick}
            className="border border-dashed border-slate-300 hover:border-blue-500 rounded-lg p-3 text-center cursor-pointer transition-colors bg-slate-50/50 hover:bg-blue-50/40 my-2 group"
          >
            <Upload size={16} className="mx-auto text-slate-400 group-hover:text-blue-600 mb-1 transition-colors" />
            <span className="text-[11px] font-semibold text-slate-700 group-hover:text-blue-700 block">
              Choose or Drop File
            </span>
            <span className="text-[10px] text-slate-400">PDF, JPG, PNG (Max 25MB)</span>
          </div>
        )}
      </div>

      <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-100 flex items-center justify-between">
        <span className="truncate">{subtitle}</span>
        {selectedFile && (
          <span className="text-emerald-600 font-bold flex items-center gap-0.5 text-[10px]">
            <Check size={11} /> Attached
          </span>
        )}
      </div>
    </div>
  );
};
