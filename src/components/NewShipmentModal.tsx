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
  Zap,
  FolderOpen,
  Building2,
  FileCheck,
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
  // 1. Financial Year (dynamic current or selected FY)
  const defaultFy =
    selectedFyId ||
    financialYears.find((f) => f.isCurrent)?.id ||
    financialYears[0]?.id ||
    '';

  const [fyId, setFyId] = useState(defaultFy);

  // 2. Invoice Number (Unique, Primary)
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [normalizedKey, setNormalizedKey] = useState('');
  const [isCheckingUnique, setIsCheckingUnique] = useState(false);
  const [isUnique, setIsUnique] = useState<boolean | null>(null);
  const [existingInvoiceNumber, setExistingInvoiceNumber] = useState<string | null>(null);

  // 3. Document Files (All in one form - up to 7 documents)
  const [invoiceFile, setInvoiceFile] = useState<SelectedFileItem | null>(null);
  const [sbFile, setSbFile] = useState<SelectedFileItem | null>(null);
  const [blFile, setBlFile] = useState<SelectedFileItem | null>(null);

  // BRC Copy: Single (max 1 file) vs Multiple (max 2 files)
  const [brcMode, setBrcMode] = useState<BrcMode>('SINGLE');
  const [brcFile1, setBrcFile1] = useState<SelectedFileItem | null>(null);
  const [brcFile2, setBrcFile2] = useState<SelectedFileItem | null>(null);

  const [fircFile, setFircFile] = useState<SelectedFileItem | null>(null);
  const [additionalFile, setAdditionalFile] = useState<SelectedFileItem | null>(null);

  // 4. Remarks (Text) - Saved across all views
  const [remarks, setRemarks] = useState('');

  // 5. Commercial Details (Pre-filled via auto-extraction or user-editable)
  const [showOptionalDetails, setShowOptionalDetails] = useState(true);
  const [consigneeId, setConsigneeId] = useState(consignees[0]?.id || '');
  const [bankId, setBankId] = useState(banks[0]?.id || '');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
  const [invoiceValueUsd, setInvoiceValueUsd] = useState<number | ''>('');
  const [shippingBillNumber, setShippingBillNumber] = useState('');
  const [shippingBillDate, setShippingBillDate] = useState(new Date().toISOString().split('T')[0]);
  const [sbExchangeRate, setSbExchangeRate] = useState<number>(92.1);
  const [fobValueInr, setFobValueInr] = useState<number | ''>('');
  const [blNumber, setBlNumber] = useState('');
  const [blDate, setBlDate] = useState('');
  const [vesselName, setVesselName] = useState('');
  const [portCode, setPortCode] = useState('INMAA1');
  const [packageCount, setPackageCount] = useState<number | ''>('');

  // Extraction tracking state
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState('');
  const [extractionResult, setExtractionResult] = useState<{
    fieldsExtracted: number;
    missingFields: string[];
    docCount: number;
    summaryText?: string;
  } | null>(null);
  const [extractedSources, setExtractedSources] = useState<Record<string, string>>({});

  // UI State
  const [submitting, setSubmitting] = useState(false);
  const [submitProgressText, setSubmitProgressText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState(false);
  const [isDragOverBatch, setIsDragOverBatch] = useState(false);

  // Hidden input refs
  const batchInputRef = useRef<HTMLInputElement>(null);
  const invoiceInputRef = useRef<HTMLInputElement>(null);
  const sbInputRef = useRef<HTMLInputElement>(null);
  const blInputRef = useRef<HTMLInputElement>(null);
  const brc1InputRef = useRef<HTMLInputElement>(null);
  const brc2InputRef = useRef<HTMLInputElement>(null);
  const fircInputRef = useRef<HTMLInputElement>(null);
  const additionalInputRef = useRef<HTMLInputElement>(null);

  // Sync initial financial year & masters when modal opens
  useEffect(() => {
    if (isOpen) {
      const match =
        selectedFyId ||
        financialYears.find((f) => f.isCurrent)?.id ||
        financialYears[0]?.id ||
        '';
      setFyId(match);
      if (consignees[0]?.id && !consigneeId) {
        setConsigneeId(consignees[0].id);
      }
      if (banks[0]?.id && !bankId) {
        setBankId(banks[0].id);
      }
    }
  }, [isOpen, financialYears, selectedFyId, consignees, banks, consigneeId, bankId]);

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
      const rate = typeof sbExchangeRate === 'number' && sbExchangeRate > 0 ? sbExchangeRate : 92.1;
      const calcFob = Math.round(invoiceValueUsd * rate * 100) / 100;
      setFobValueInr(calcFob);
    }
  }, [invoiceValueUsd, sbExchangeRate]);

  // Suggest Next Invoice Number based on existing records
  const handleSuggestNextInvoice = async () => {
    try {
      const all = await api.getShipments({ financialYearId: fyId });
      let maxNum = 0;
      for (const s of all) {
        const m = s.invoiceNumber.match(/(\d+)$/);
        if (m) {
          const val = parseInt(m[1], 10);
          if (val > maxNum) maxNum = val;
        }
      }
      const nextNum = maxNum > 0 ? maxNum + 1 : 1;
      const padded = String(nextNum).padStart(3, '0');
      setInvoiceNumber(`SKE/26-27/${padded}`);
    } catch (e) {
      setInvoiceNumber('SKE/26-27/271');
    }
  };

  // Auto-pad single number input (e.g. 269 -> SKE/26-27/269)
  const handleAutoPadInput = (raw: string) => {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const padded = trimmed.padStart(3, '0');
      setInvoiceNumber(`SKE/26-27/${padded}`);
    } else {
      setInvoiceNumber(raw);
    }
  };

  // Reset/Clear Form action
  const handleClearForm = () => {
    setInvoiceNumber('');
    setInvoiceDate(new Date().toISOString().split('T')[0]);
    setShippingBillNumber('');
    setShippingBillDate(new Date().toISOString().split('T')[0]);
    setInvoiceValueUsd('');
    setSbExchangeRate(92.1);
    setFobValueInr('');
    setBlNumber('');
    setBlDate('');
    setVesselName('');
    setRemarks('');
    setPortCode('INMAA1');
    setPackageCount('');
    setInvoiceFile(null);
    setSbFile(null);
    setBlFile(null);
    setBrcFile1(null);
    setBrcFile2(null);
    setFircFile(null);
    setAdditionalFile(null);
    setError(null);
    setExtractionResult(null);
  };

  // Clean helper to format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Run batch extraction on provided or staged files
  const runBatchExtraction = async (explicitFiles?: {
    inv?: File | null;
    sb?: File | null;
    bl?: File | null;
    brc1?: File | null;
    brc2?: File | null;
    firc?: File | null;
    add?: File | null;
  }) => {
    const fInv = explicitFiles?.inv !== undefined ? explicitFiles.inv : invoiceFile?.file;
    const fSb = explicitFiles?.sb !== undefined ? explicitFiles.sb : sbFile?.file;
    const fBl = explicitFiles?.bl !== undefined ? explicitFiles.bl : blFile?.file;
    const fBrc1 = explicitFiles?.brc1 !== undefined ? explicitFiles.brc1 : brcFile1?.file;
    const fBrc2 = explicitFiles?.brc2 !== undefined ? explicitFiles.brc2 : brcFile2?.file;
    const fFirc = explicitFiles?.firc !== undefined ? explicitFiles.firc : fircFile?.file;
    const fAdd = explicitFiles?.add !== undefined ? explicitFiles.add : additionalFile?.file;

    const filesToUpload = [fInv, fSb, fBl, fBrc1, fBrc2, fFirc, fAdd].filter(Boolean) as File[];
    if (filesToUpload.length === 0) {
      setError('Please select or drop at least one document PDF to extract.');
      return;
    }

    setIsExtracting(true);
    setError(null);
    setExtractionProgress(`Analyzing ${filesToUpload.length} document${filesToUpload.length > 1 ? 's' : ''}...`);

    try {
      const formData = new FormData();
      if (fInv) formData.append('invoiceDoc', fInv);
      if (fSb) formData.append('shippingBillDoc', fSb);
      if (fBl) formData.append('blDoc', fBl);
      if (fBrc1) formData.append('brcDoc1', fBrc1);
      if (fBrc2) formData.append('brcDoc2', fBrc2);
      if (fFirc) formData.append('fircDoc', fFirc);
      if (fAdd) formData.append('additionalDoc', fAdd);

      const res = await api.extractDocumentsBatch(formData);

      if (res.success && res.mergedDraft) {
        const draft = res.mergedDraft;
        const sources: Record<string, string> = {};

        if (draft.invoiceNumber) {
          setInvoiceNumber(draft.invoiceNumber);
          sources.invoiceNumber = 'Commercial Invoice';
        }
        if (draft.invoiceDate) {
          setInvoiceDate(draft.invoiceDate);
          sources.invoiceDate = 'Commercial Invoice';
        }
        if (typeof draft.invoiceValueUsd === 'number') {
          setInvoiceValueUsd(draft.invoiceValueUsd);
          sources.invoiceValueUsd = 'Commercial Invoice / FIRC';
        }
        if (typeof draft.packageCount === 'number') {
          setPackageCount(draft.packageCount);
          sources.packageCount = 'Commercial Invoice / BL';
        }
        if (draft.shippingBillNumber) {
          setShippingBillNumber(draft.shippingBillNumber);
          sources.shippingBillNumber = 'Shipping Bill';
        }
        if (draft.shippingBillDate) {
          setShippingBillDate(draft.shippingBillDate);
          sources.shippingBillDate = 'Shipping Bill';
        }
        if (typeof draft.sbExchangeRate === 'number') {
          setSbExchangeRate(draft.sbExchangeRate);
          sources.sbExchangeRate = 'Shipping Bill (CBIC Rate)';
        }
        if (typeof draft.fobValueInr === 'number') {
          setFobValueInr(draft.fobValueInr);
          sources.fobValueInr = 'Shipping Bill Customs FOB';
        }
        if (draft.portCode) {
          setPortCode(draft.portCode);
          sources.portCode = 'Shipping Bill';
        }
        if (draft.blNumber) {
          setBlNumber(draft.blNumber);
          sources.blNumber = 'Bill of Lading';
        }
        if (draft.blDate) {
          setBlDate(draft.blDate);
          sources.blDate = 'Bill of Lading';
        }
        if (draft.vesselName) {
          setVesselName(draft.vesselName);
          sources.vesselName = 'Shipping Bill / BL';
        }

        // Match consignee (e.g. S K Global Ventures Private Limited)
        if (draft.consigneeName) {
          const match = consignees.find((c) =>
            c.name.toLowerCase().includes(draft.consigneeName.toLowerCase().slice(0, 10)) ||
            draft.consigneeName.toLowerCase().includes(c.name.toLowerCase().slice(0, 10))
          );
          if (match) {
            setConsigneeId(match.id);
            sources.consigneeId = `Matched: ${match.name}`;
          }
        }

        // Match bank (e.g. HDFC Bank)
        if (draft.bankName) {
          const matchBank = banks.find((b) =>
            b.name.toLowerCase().includes(draft.bankName.toLowerCase().slice(0, 4)) ||
            draft.bankName.toLowerCase().includes(b.name.toLowerCase().slice(0, 4))
          );
          if (matchBank) {
            setBankId(matchBank.id);
            sources.bankId = `Matched: ${matchBank.name}`;
          }
        }

        setExtractedSources(sources);
        const count = Object.keys(draft.extractedFields || {}).length;
        const missing = draft.missingFields || [];
        setExtractionResult({
          fieldsExtracted: count,
          missingFields: missing,
          docCount: filesToUpload.length,
          summaryText: `Extracted ${count} fields across ${filesToUpload.length} document(s).`,
        });

        // Ensure commercial details drawer is open to inspect
        setShowOptionalDetails(true);
      }
    } catch (err: any) {
      setError(`Batch extraction error: ${err.message || 'Unable to extract PDF content'}`);
    } finally {
      setIsExtracting(false);
      setExtractionProgress('');
    }
  };

  // Process batch dropped/selected files (up to 7 documents)
  const processBatchFileList = (files: FileList | File[]) => {
    const fileList = Array.from(files).slice(0, 7);
    if (fileList.length === 0) return;

    let newInv = invoiceFile;
    let newSb = sbFile;
    let newBl = blFile;
    let newBrc1 = brcFile1;
    let newBrc2 = brcFile2;
    let newFirc = fircFile;
    let newAdd = additionalFile;

    for (const f of fileList) {
      const fn = f.name.toLowerCase();
      const item: SelectedFileItem = {
        file: f,
        name: f.name,
        size: formatFileSize(f.size),
      };

      if (fn.includes('invoice') || fn.includes('inv_') || fn.includes('commercial')) {
        newInv = item;
      } else if (fn.includes('shipping') || fn.includes('sb_') || fn.includes('shipping_bill')) {
        newSb = item;
      } else if (fn.includes('bl_') || fn.includes('bl ') || fn.includes('lading') || fn.startsWith('bl')) {
        newBl = item;
      } else if (fn.includes('firc') || fn.includes('irm') || fn.includes('remittance') || fn.includes('payment')) {
        newFirc = item;
      } else if (fn.includes('brc') || fn.includes('ebrc')) {
        if (!newBrc1) {
          newBrc1 = item;
        } else {
          newBrc2 = item;
          setBrcMode('MULTIPLE');
        }
      } else {
        newAdd = item;
      }
    }

    if (newInv) setInvoiceFile(newInv);
    if (newSb) setSbFile(newSb);
    if (newBl) setBlFile(newBl);
    if (newBrc1) setBrcFile1(newBrc1);
    if (newBrc2) setBrcFile2(newBrc2);
    if (newFirc) setFircFile(newFirc);
    if (newAdd) setAdditionalFile(newAdd);

    // Run extraction automatically
    runBatchExtraction({
      inv: newInv?.file,
      sb: newSb?.file,
      bl: newBl?.file,
      brc1: newBrc1?.file,
      brc2: newBrc2?.file,
      firc: newFirc?.file,
      add: newAdd?.file,
    });
  };

  const handleFileSelect = (
    e: React.ChangeEvent<HTMLInputElement>,
    setter: (item: SelectedFileItem | null) => void,
    categoryType?: string
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const item: SelectedFileItem = {
      file,
      name: file.name,
      size: formatFileSize(file.size),
    };
    setter(item);

    // Auto-detect invoice number if not already entered
    if (categoryType === 'INVOICE' && !invoiceNumber) {
      const nameParts = file.name.replace(/\.[^/.]+$/, '').split(/[-_ ]+/);
      const possibleNum = nameParts.find((p) => /\d{2,}/.test(p));
      if (possibleNum) {
        setInvoiceNumber(`SKE/26-27/${possibleNum.padStart(3, '0')}`);
      }
    }

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
        `Invoice number "${invoiceNumber}" is not unique in Financial Year ${
          financialYears.find((f) => f.id === fyId)?.label || fyId
        }. Existing invoice: ${existingInvoiceNumber}.`
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

      // Commercial fields
      if (consigneeId) formData.append('consigneeId', consigneeId);
      if (bankId) formData.append('bankId', bankId);
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

      // Append document files (up to 7)
      if (invoiceFile?.file) formData.append('invoiceDoc', invoiceFile.file);
      if (sbFile?.file) formData.append('shippingBillDoc', sbFile.file);
      if (blFile?.file) formData.append('blDoc', blFile.file);
      if (brcFile1?.file) formData.append('brcDoc1', brcFile1.file);
      if (brcMode === 'MULTIPLE' && brcFile2?.file) {
        formData.append('brcDoc2', brcFile2.file);
      }
      if (fircFile?.file) formData.append('fircDoc', fircFile.file);
      if (additionalFile?.file) formData.append('additionalDoc', additionalFile.file);

      setSubmitProgressText('Saving files to vault & syncing ledgers...');
      await api.createShipmentWithDocuments(formData);

      setSuccessToast(true);
      setTimeout(() => {
        resetForm();
        onSuccess();
        onClose();
      }, 900);
    } catch (err: any) {
      setError(err.message || 'Failed to create shipment. Please verify data fields.');
    } finally {
      setSubmitting(false);
      setSubmitProgressText('');
    }
  };

  const resetForm = () => {
    setInvoiceNumber('');
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
    setExtractionResult(null);
    setExtractedSources({});
  };

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
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                  Auto-Extraction Enabled
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Upload up to 7 documents, auto-extract all ledger fields, edit missing values, and record Remarks
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            type="button"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors cursor-pointer"
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

          {/* SMART BATCH UPLOAD DROPZONE (Up to 7 files at once) */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOverBatch(true);
            }}
            onDragLeave={() => setIsDragOverBatch(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOverBatch(false);
              if (e.dataTransfer.files) {
                processBatchFileList(e.dataTransfer.files);
              }
            }}
            className={`border-2 border-dashed rounded-2xl p-5 text-center transition-all ${
              isDragOverBatch
                ? 'border-blue-500 bg-blue-50/70 scale-[1.01]'
                : 'border-slate-300 bg-gradient-to-b from-slate-50 to-white hover:border-blue-400'
            }`}
          >
            <input
              ref={batchInputRef}
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) {
                  processBatchFileList(e.target.files);
                }
              }}
            />
            <div className="max-w-xl mx-auto flex flex-col items-center">
              <div className="w-12 h-12 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center mb-2.5 shadow-xs">
                <Zap size={24} />
              </div>
              <h3 className="text-sm font-bold text-slate-800">
                Drop Up to 7 Export Documents Here for Complete Auto-Extraction
              </h3>
              <p className="text-xs text-slate-500 mt-1 mb-3">
                Drop Invoice, Shipping Bill, BL, FIRC, BRC 1, BRC 2, &amp; Additional documents simultaneously. The system extracts all fields with zero data loss.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => batchInputRef.current?.click()}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <FolderOpen size={14} /> Select Multiple Files (Up to 7)
                </button>
                {attachedFileCount > 0 && (
                  <button
                    type="button"
                    disabled={isExtracting}
                    onClick={() => runBatchExtraction()}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold shadow-xs transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    {isExtracting ? (
                      <>
                        <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        <span>Extracting Data...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={14} />
                        <span>Auto-Extract from Staged Files ({attachedFileCount})</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* EXTRACTION STATUS & AUDIT BOX */}
          {extractionResult && (
            <div className="p-4 bg-emerald-50/70 border border-emerald-200 rounded-xl text-xs space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-600" />
                  <span className="font-bold text-emerald-950">
                    Auto-Extraction Complete: {extractionResult.fieldsExtracted} fields pre-filled from {extractionResult.docCount} documents
                  </span>
                </div>
                {extractionResult.missingFields.length === 0 ? (
                  <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 font-bold rounded-full text-[10px] border border-emerald-300">
                    100% Extracted • 0 Missing Fields
                  </span>
                ) : (
                  <span className="px-2 py-0.5 bg-amber-100 text-amber-800 font-bold rounded-full text-[10px] border border-amber-300">
                    {extractionResult.missingFields.length} Field(s) Require User Input
                  </span>
                )}
              </div>

              {extractionResult.missingFields.length > 0 && (
                <div className="text-[11px] text-amber-900 bg-amber-50 p-2 rounded-lg border border-amber-200">
                  <strong>Notice:</strong> Some documents did not contain:{' '}
                  {extractionResult.missingFields.join(', ')}. You can easily type these details into the editable form fields below!
                </div>
              )}
            </div>
          )}

          {/* SECTION 1: FINANCIAL YEAR & INVOICE NUMBER */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4.5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
              <div className="flex items-center gap-2">
                <KeyRound size={16} className="text-blue-600" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  1. Financial Year &amp; Primary Identification
                </h3>
              </div>
              <span className="text-[11px] text-slate-500 font-medium">Unique Primary Key</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Financial Year Selector */}
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
                  Organizes export trackers, BRC deadlines, and statutory realization.
                </p>
              </div>

              {/* Invoice Number (Unique, Primary Key) */}
              <div>
                <label className="flex items-center justify-between text-xs font-semibold text-slate-700 mb-1.5">
                  <span className="flex items-center gap-1.5">
                    <FileText size={14} className="text-blue-600" />
                    Invoice No. (Unique, Primary) <span className="text-red-500">*</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleSuggestNextInvoice}
                      className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 transition-colors cursor-pointer"
                    >
                      Suggest Next #
                    </button>
                    {extractedSources.invoiceNumber ? (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300">
                        Extracted from Invoice
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                        Primary Key
                      </span>
                    )}
                  </div>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    required
                    placeholder="e.g. SKE/26-27/020 (or type number e.g. 271)"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    onBlur={(e) => handleAutoPadInput(e.target.value)}
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
                    <span className="text-slate-400">Unique identifier across fiscal year</span>
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

          {/* SECTION 2: DOCUMENT VAULT UPLOAD (UP TO 7 FILES) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers size={16} className="text-blue-600" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  2. Document Vault Upload (Up to 7 Individual Slots)
                </h3>
              </div>
              <span className="text-[11px] font-semibold text-slate-500">
                {attachedFileCount} of 7 slots attached
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {/* 1. Commercial Invoice */}
              <DocumentUploadCard
                title="Commercial Invoice"
                badgeText="Slot 1"
                categoryBadge="Invoice & Line Items"
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

              {/* 2. Shipping Bill */}
              <DocumentUploadCard
                title="Shipping Bill"
                badgeText="Slot 2"
                categoryBadge="Customs SB Document"
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

              {/* 3. BL Copy */}
              <DocumentUploadCard
                title="Bill of Lading"
                badgeText="Slot 3"
                categoryBadge="Carrier / MTD Document"
                icon={<Ship size={18} className="text-cyan-600" />}
                accentColor="cyan"
                selectedFile={blFile}
                onSelectClick={() => blInputRef.current?.click()}
                onRemove={() => setBlFile(null)}
                subtitle="Carrier BL No, Date, Vessel, Container"
              />
              <input
                ref={blInputRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                className="hidden"
                onChange={(e) => handleFileSelect(e, setBlFile, 'BL')}
              />

              {/* 4. BRC Copy - Single (Slot 4) or Multiple (Slot 4 & 5) */}
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

                  {/* Mode Selector Toggle */}
                  <div className="bg-slate-100 p-1 rounded-lg grid grid-cols-2 gap-1 text-[11px] font-semibold mb-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        setBrcMode('SINGLE');
                        setBrcFile2(null);
                      }}
                      className={`h-7 px-2 rounded-md text-center transition-all cursor-pointer flex items-center justify-center ${
                        brcMode === 'SINGLE'
                          ? 'bg-white text-blue-700 shadow-xs font-bold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Single (1 BRC)
                    </button>
                    <button
                      type="button"
                      onClick={() => setBrcMode('MULTIPLE')}
                      className={`h-7 px-2 rounded-md text-center transition-all cursor-pointer flex items-center justify-center ${
                        brcMode === 'MULTIPLE'
                          ? 'bg-white text-blue-700 shadow-xs font-bold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Multiple (2 BRCs)
                    </button>
                  </div>

                  <div className="space-y-2">
                    {/* BRC Slot 1 */}
                    <div className="p-2 border border-slate-200 rounded-lg bg-slate-50/70 text-xs flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <span className="text-[10px] font-bold text-slate-500 uppercase block truncate">
                          {brcMode === 'MULTIPLE' ? 'BRC Slot 4 (Part 1)' : 'BRC Slot 4 (Single)'}
                        </span>
                        {brcFile1 ? (
                          <span className="font-semibold text-slate-800 truncate block text-[11px]">
                            {brcFile1.name} ({brcFile1.size})
                          </span>
                        ) : (
                          <span className="text-slate-400 text-[11px] block">No file selected</span>
                        )}
                      </div>
                      {brcFile1 ? (
                        <button
                          type="button"
                          onClick={() => setBrcFile1(null)}
                          className="w-7 h-7 flex items-center justify-center shrink-0 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                        >
                          <Trash2 size={13} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => brc1InputRef.current?.click()}
                          className="h-7 px-2.5 bg-white border border-slate-300 rounded-lg text-[11px] font-semibold text-slate-700 hover:bg-slate-100 flex items-center gap-1 shrink-0 cursor-pointer shadow-2xs"
                        >
                          <Upload size={11} /> Browse
                        </button>
                      )}
                    </div>

                    {/* BRC Slot 2 */}
                    {brcMode === 'MULTIPLE' && (
                      <div className="p-2 border border-slate-200 rounded-lg bg-slate-50/70 text-xs flex items-center justify-between gap-2 animate-in fade-in duration-150">
                        <div className="min-w-0 flex-1">
                          <span className="text-[10px] font-bold text-slate-500 uppercase block truncate">
                            BRC Slot 5 (Part 2)
                          </span>
                          {brcFile2 ? (
                            <span className="font-semibold text-slate-800 truncate block text-[11px]">
                              {brcFile2.name} ({brcFile2.size})
                            </span>
                          ) : (
                            <span className="text-slate-400 text-[11px] block">No file selected</span>
                          )}
                        </div>
                        {brcFile2 ? (
                          <button
                            type="button"
                            onClick={() => setBrcFile2(null)}
                            className="w-7 h-7 flex items-center justify-center shrink-0 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                          >
                            <Trash2 size={13} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => brc2InputRef.current?.click()}
                            className="h-7 px-2.5 bg-white border border-slate-300 rounded-lg text-[11px] font-semibold text-slate-700 hover:bg-slate-100 flex items-center gap-1 shrink-0 cursor-pointer shadow-2xs"
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
                    ? 'Single bank realisation eBRC'
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

              {/* 5. FIRC Copy (Slot 6) */}
              <DocumentUploadCard
                title="FIRC / Payment Receipt"
                badgeText="Slot 6"
                categoryBadge="Inward Remittance Advice"
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

              {/* 6. Additional Document (Slot 7) */}
              <DocumentUploadCard
                title="Additional Documents"
                badgeText="Slot 7"
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

          {/* SECTION 3: TEXT REMARKS */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4.5 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                <Info size={14} className="text-blue-600" />
                3. Text Remarks <span className="text-slate-400 text-[11px] font-normal">(Synced across all views &amp; exports)</span>
              </label>
              <span className="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 font-semibold">
                Exported to Invoice Lookup &amp; Ledgers
              </span>
            </div>
            <textarea
              rows={2}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Enter custom remarks, special buyer terms, container numbers, LC references, or statutory notes..."
              className="w-full border border-slate-300 rounded-lg p-2.5 bg-white text-xs text-slate-800 placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* SECTION 4: EDITABLE COMMERCIAL PARAMETERS & AUTO-EXTRACTED DATA */}
          <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
            <button
              type="button"
              onClick={() => setShowOptionalDetails(!showOptionalDetails)}
              className="w-full px-4.5 py-3.5 bg-slate-50 hover:bg-slate-100/80 transition-colors flex items-center justify-between text-xs font-semibold text-slate-700 cursor-pointer"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-6 h-6 rounded-md bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                  <Sparkles size={14} />
                </div>
                <div className="text-left">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-800">
                      4. Commercial &amp; Customs Ledger Fields
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-800">
                      Editable • Synchronizes with All Ledgers
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 font-normal mt-0.5">
                    Pre-filled from uploaded documents; review or enter missing data below before saving
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-slate-500 shrink-0">
                <span className="text-[11px] font-medium">
                  {showOptionalDetails ? 'Hide' : 'Expand Form'}
                </span>
                {showOptionalDetails ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </div>
            </button>

            {showOptionalDetails && (
              <div className="p-4.5 border-t border-slate-200 space-y-4 text-xs animate-in fade-in duration-150">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3.5">
                  {/* Consignee */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>Consignee (Buyer)</span>
                      {extractedSources.consigneeId ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-400">Select</span>
                      )}
                    </label>
                    <select
                      value={consigneeId}
                      onChange={(e) => setConsigneeId(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 bg-white text-xs font-medium"
                    >
                      {consignees.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.country})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Authorized Dealer Bank */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>AD Bank</span>
                      {extractedSources.bankId ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-400">Select</span>
                      )}
                    </label>
                    <select
                      value={bankId}
                      onChange={(e) => setBankId(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 bg-white text-xs font-medium"
                    >
                      {banks.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} ({b.adCode || b.ifscCode})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Invoice Date */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>Invoice Date</span>
                      {extractedSources.invoiceDate ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : (
                        <span className="text-[10px] text-amber-600 font-bold">Input Required</span>
                      )}
                    </label>
                    <input
                      type="date"
                      value={invoiceDate}
                      onChange={(e) => setInvoiceDate(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-xs"
                    />
                  </div>

                  {/* Invoice Value USD */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>Invoice Value (USD)</span>
                      {extractedSources.invoiceValueUsd ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : (
                        <span className="text-[10px] text-amber-600 font-bold">Input Required</span>
                      )}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="e.g. 24025.65"
                      value={invoiceValueUsd}
                      onChange={(e) =>
                        setInvoiceValueUsd(e.target.value ? parseFloat(e.target.value) : '')
                      }
                      className="w-full border border-slate-300 rounded-lg p-2 font-bold text-slate-900 text-xs"
                    />
                  </div>

                  {/* Package Count */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>Packages</span>
                      {extractedSources.packageCount ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : null}
                    </label>
                    <input
                      type="number"
                      placeholder="e.g. 88"
                      value={packageCount}
                      onChange={(e) =>
                        setPackageCount(e.target.value ? parseInt(e.target.value, 10) : '')
                      }
                      className="w-full border border-slate-300 rounded-lg p-2 text-xs"
                    />
                  </div>

                  {/* Shipping Bill Number */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>Shipping Bill No.</span>
                      {extractedSources.shippingBillNumber ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : (
                        <span className="text-[10px] text-amber-600 font-bold">Input Required</span>
                      )}
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 2173318"
                      value={shippingBillNumber}
                      onChange={(e) => setShippingBillNumber(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 font-medium text-xs"
                    />
                  </div>

                  {/* Shipping Bill Date */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>Shipping Bill Date</span>
                      {extractedSources.shippingBillDate ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : null}
                    </label>
                    <input
                      type="date"
                      value={shippingBillDate}
                      onChange={(e) => setShippingBillDate(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-xs"
                    />
                  </div>

                  {/* Exchange Rate */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>Customs Ex. Rate (INR/USD)</span>
                      {extractedSources.sbExchangeRate ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : null}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={sbExchangeRate}
                      onChange={(e) => setSbExchangeRate(parseFloat(e.target.value) || 92.1)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-xs font-semibold"
                    />
                  </div>

                  {/* Calculated FOB INR */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>FOB Value (INR)</span>
                      {extractedSources.fobValueInr ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-400">USD × Rate</span>
                      )}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={fobValueInr}
                      onChange={(e) =>
                        setFobValueInr(e.target.value ? parseFloat(e.target.value) : '')
                      }
                      placeholder="Auto-calculated"
                      className="w-full border border-slate-300 rounded-lg p-2 bg-slate-50 font-bold text-xs"
                    />
                  </div>

                  {/* BL Number */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>BL Number</span>
                      {extractedSources.blNumber ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : null}
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 736116000605"
                      value={blNumber}
                      onChange={(e) => setBlNumber(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-xs"
                    />
                  </div>

                  {/* BL Date */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>BL Date</span>
                      {extractedSources.blDate ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : null}
                    </label>
                    <input
                      type="date"
                      value={blDate}
                      onChange={(e) => setBlDate(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-xs"
                    />
                  </div>

                  {/* Vessel Name */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>Vessel Name</span>
                      {extractedSources.vesselName ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : null}
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. ZHONG GU GUI YANG"
                      value={vesselName}
                      onChange={(e) => setVesselName(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-xs"
                    />
                  </div>

                  {/* Customs Port Code */}
                  <div>
                    <label className="font-semibold text-slate-700 flex items-center justify-between mb-1">
                      <span>Port Code</span>
                      {extractedSources.portCode ? (
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-1 rounded">
                          Extracted
                        </span>
                      ) : null}
                    </label>
                    <input
                      type="text"
                      value={portCode}
                      onChange={(e) => setPortCode(e.target.value)}
                      placeholder="e.g. INMAA1"
                      className="w-full border border-slate-300 rounded-lg p-2 text-xs"
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
                onClick={handleClearForm}
                disabled={submitting}
                className="px-3.5 py-2.5 border border-slate-300 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                Clear Form
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="flex-1 sm:flex-initial px-4 py-2.5 border border-slate-300 rounded-xl text-xs font-semibold text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || isUnique === false || !invoiceNumber.trim()}
                className="flex-1 sm:flex-initial px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-xs font-bold shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                {submitting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>{submitProgressText || 'Saving Shipment & Files...'}</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={16} />
                    <span>Create Shipment &amp; Sync Ledgers</span>
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
        <div className="my-2 min-h-[72px] flex flex-col justify-center">
          {selectedFile ? (
            <div className="p-2.5 rounded-lg bg-emerald-50/70 border border-emerald-200 text-xs flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <span className="font-bold text-slate-800 truncate block text-[11px]">
                  {selectedFile.name}
                </span>
                <span className="text-[10px] text-emerald-700 font-medium block truncate">
                  {selectedFile.size} • Ready to upload
                </span>
              </div>
              <button
                type="button"
                onClick={onRemove}
                className="w-7 h-7 flex items-center justify-center shrink-0 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                title="Remove file"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onSelectClick}
              className="w-full h-full border border-dashed border-slate-300 hover:border-blue-500 rounded-lg p-3 text-center cursor-pointer transition-colors bg-slate-50/60 hover:bg-blue-50/50 group flex flex-col items-center justify-center"
            >
              <Upload size={16} className="text-slate-400 group-hover:text-blue-600 mb-1 transition-colors" />
              <span className="text-[11px] font-semibold text-slate-700 group-hover:text-blue-700 block">
                Choose or Drop File
              </span>
              <span className="text-[10px] text-slate-400">PDF, JPG, PNG (Max 25MB)</span>
            </button>
          )}
        </div>
      </div>

      <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-100 flex items-center justify-between">
        <span className="truncate">{subtitle}</span>
        {selectedFile && (
          <span className="text-emerald-600 font-bold flex items-center gap-0.5 text-[10px] shrink-0 ml-1">
            <Check size={11} /> Attached
          </span>
        )}
      </div>
    </div>
  );
};
