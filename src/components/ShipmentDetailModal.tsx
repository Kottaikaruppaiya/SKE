/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  X,
  Download,
  AlertTriangle,
  CheckCircle2,
  FileText,
  DollarSign,
  Award,
  FileCheck,
  History,
  ExternalLink,
  Edit,
  Plus,
  Trash2,
} from 'lucide-react';
import { Shipment, Role } from '../types/index.ts';
import { api } from '../api/client.ts';

interface ShipmentDetailModalProps {
  shipmentId: string | null;
  onClose: () => void;
  onOpenEdit: (shipment: Shipment) => void;
  onOpenAllocate: (shipment: Shipment) => void;
  onOpenUpload: (shipment: Shipment) => void;
  onDeleted?: () => void;
  userRole: Role;
}

export const ShipmentDetailModal: React.FC<ShipmentDetailModalProps> = ({
  shipmentId,
  onClose,
  onOpenEdit,
  onOpenAllocate,
  onOpenUpload,
  onDeleted,
  userRole,
}) => {
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'documents' | 'payments' | 'brc' | 'incentives' | 'audit'>('overview');

  const loadData = async () => {
    if (!shipmentId) return;
    setLoading(true);
    try {
      const data = await api.getShipmentById(shipmentId);
      setShipment(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [shipmentId]);

  if (!shipmentId) return null;

  const isViewer = userRole === 'VIEWER';

  // Cross-document validation checks per Section 10
  const validationWarnings: string[] = [];
  if (shipment) {
    if (!shipment.hasFircEvidence) {
      validationWarnings.push('MANDATORY FIRC WARNING: No Foreign Inward Remittance Certificate (FIRC) is linked to this shipment.');
    }
    const expectedFob = shipment.invoiceValueUsd * shipment.sbExchangeRate;
    if (Math.abs(expectedFob - shipment.fobValueInr) > 100) {
      validationWarnings.push(
        `FOB Discrepancy: Custom SB FOB INR (₹${shipment.fobValueInr.toLocaleString()}) differs from USD × SB Rate (₹${expectedFob.toLocaleString()}).`
      );
    }
    if (shipment.invoiceDate > shipment.shippingBillDate) {
      validationWarnings.push('Date Sequence Discrepancy: Invoice Date is after Shipping Bill Date.');
    }
  }

  const handleDeleteShipment = async () => {
    if (!shipment) return;
    const ok = window.confirm(
      `Permanently delete export shipment "${shipment.invoiceNumber}"?\n\nThis will remove all associated payment allocations, invoice items, and documents.`
    );
    if (!ok) return;

    try {
      await api.deleteShipment(shipment.id);
      if (onDeleted) onDeleted();
      onClose();
    } catch (err: any) {
      alert(err.message || 'Failed to delete shipment.');
    }
  };

  const handleDeleteDocument = async (docId: string, filename: string) => {
    const ok = window.confirm(`Permanently delete document "${filename}"?`);
    if (!ok) return;

    try {
      await api.deleteDocument(docId);
      loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to delete document.');
    }
  };

  // BRC Edit state
  const [isEditingBrc, setIsEditingBrc] = useState(false);
  const [brcNumber, setBrcNumber] = useState('');
  const [brcStatus, setBrcStatus] = useState<'PENDING' | 'ISSUED' | 'REALISED'>('PENDING');
  const [brcIssueDate, setBrcIssueDate] = useState('');
  const [brcRealisationDate, setBrcRealisationDate] = useState('');
  const [brcUploadMode, setBrcUploadMode] = useState<'SINGLE' | 'MULTIPLE'>('SINGLE');
  const [brcRemarks, setBrcRemarks] = useState('');

  // Incentive Edit / Add state
  const [editingIncentive, setEditingIncentive] = useState<any | null>(null);
  const [isAddingIncentive, setIsAddingIncentive] = useState(false);
  const [incType, setIncType] = useState<'DRAWBACK' | 'RODTEP' | 'ROSCTL'>('DRAWBACK');
  const [incClaimed, setIncClaimed] = useState<number>(0);
  const [incStatus, setIncStatus] = useState<string>('CLAIMED');
  const [incReceived, setIncReceived] = useState<number>(0);
  const [incReceivedDate, setIncReceivedDate] = useState<string>('');
  const [incScrollNo, setIncScrollNo] = useState<string>('');
  const [incRemarks, setIncRemarks] = useState<string>('');

  const openEditBrc = () => {
    setBrcNumber(shipment?.brcRecord?.brcNumber || '');
    setBrcStatus((shipment?.brcRecord?.status as any) || 'PENDING');
    setBrcIssueDate(shipment?.brcRecord?.issueDate || '');
    setBrcRealisationDate(shipment?.brcRecord?.realisationDate || '');
    setBrcUploadMode(shipment?.brcRecord?.uploadMode || 'SINGLE');
    setBrcRemarks(shipment?.brcRecord?.remarks || '');
    setIsEditingBrc(true);
  };

  const handleSaveBrc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shipment) return;
    try {
      await api.updateBrc(shipment.brcRecord?.id || shipment.id, {
        brcNumber,
        status: brcStatus,
        issueDate: brcIssueDate || undefined,
        realisationDate: brcRealisationDate || undefined,
        uploadMode: brcUploadMode,
        remarks: brcRemarks || undefined,
      });
      setIsEditingBrc(false);
      await loadData();
      if (onDeleted) onDeleted();
    } catch (err: any) {
      alert(err.message || 'Failed to save BRC');
    }
  };

  const handleResetBrc = async () => {
    if (!shipment) return;
    if (!window.confirm(`Reset BRC status to PENDING and clear BRC issuance details for invoice ${shipment.invoiceNumber}?`)) return;
    try {
      await api.resetBrc(shipment.brcRecord?.id || shipment.id);
      setIsEditingBrc(false);
      await loadData();
      if (onDeleted) onDeleted();
    } catch (err: any) {
      alert(err.message || 'Failed to reset BRC');
    }
  };

  const openEditIncentive = (inc: any) => {
    setEditingIncentive(inc);
    setIncType(inc.type);
    setIncClaimed(inc.claimedAmount || 0);
    setIncStatus(inc.status || 'CLAIMED');
    setIncReceived(inc.receivedAmount || 0);
    setIncReceivedDate(inc.receivedDate || '');
    setIncScrollNo(inc.scrollNumber || '');
    setIncRemarks(inc.remarks || '');
  };

  const handleSaveIncentive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingIncentive) return;
    try {
      await api.updateIncentive(editingIncentive.id, {
        status: incStatus as any,
        claimedAmount: Number(incClaimed),
        receivedAmount: Number(incReceived),
        receivedDate: incReceivedDate || undefined,
        scrollNumber: incScrollNo || undefined,
        remarks: incRemarks || undefined,
      });
      setEditingIncentive(null);
      await loadData();
      if (onDeleted) onDeleted();
    } catch (err: any) {
      alert(err.message || 'Failed to update incentive');
    }
  };

  const handleDeleteIncentive = async (incId: string, incTypeName: string) => {
    if (!window.confirm(`Are you sure you want to delete ${incTypeName} incentive claim?`)) return;
    try {
      await api.deleteIncentive(incId);
      await loadData();
      if (onDeleted) onDeleted();
    } catch (err: any) {
      alert(err.message || 'Failed to delete incentive');
    }
  };

  const openCreateIncentive = () => {
    setIsAddingIncentive(true);
    setIncType('DRAWBACK');
    setIncClaimed(0);
    setIncStatus('CLAIMED');
    setIncReceived(0);
    setIncReceivedDate('');
    setIncScrollNo('');
    setIncRemarks('');
  };

  const handleCreateIncentive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shipment) return;
    try {
      await api.createIncentive({
        shipmentId: shipment.id,
        type: incType,
        claimedAmount: Number(incClaimed),
        receivedAmount: Number(incReceived),
        status: incStatus as any,
        receivedDate: incReceivedDate || undefined,
        scrollNumber: incScrollNo || undefined,
        remarks: incRemarks || undefined,
      });
      setIsAddingIncentive(false);
      await loadData();
      if (onDeleted) onDeleted();
    } catch (err: any) {
      alert(err.message || 'Failed to create incentive');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-5xl rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-lg">
              EXP
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-lg font-bold text-white tracking-tight">
                  {shipment?.invoiceNumber || 'Shipment Details'}
                </h2>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                  {shipment?.normalizedInvoiceKey}
                </span>
                <span
                  className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                    shipment?.paymentStatus === 'FULLY_PAID'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : shipment?.paymentStatus === 'PART_PAID'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      : 'bg-red-500/20 text-red-300 border border-red-500/40'
                  }`}
                >
                  {shipment?.paymentStatus}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Buyer: <strong>{shipment?.consigneeName}</strong> | Shipping Bill: <strong>{shipment?.shippingBillNumber}</strong>
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {!isViewer && shipment && (
              <>
                <button
                  onClick={() => onOpenEdit(shipment)}
                  className="flex items-center space-x-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium border border-slate-700 transition-colors"
                >
                  <Edit size={14} />
                  <span>Edit Record</span>
                </button>
                <button
                  onClick={() => onOpenAllocate(shipment)}
                  className="flex items-center space-x-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium shadow-sm transition-colors"
                >
                  <Plus size={14} />
                  <span>Allocate Payment</span>
                </button>
                <button
                  onClick={handleDeleteShipment}
                  title="Delete this shipment"
                  className="flex items-center space-x-1.5 px-3 py-1.5 bg-red-950/80 hover:bg-red-900 text-red-300 rounded-lg text-xs font-medium border border-red-800/60 transition-colors"
                >
                  <Trash2 size={14} />
                  <span>Delete</span>
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex border-b border-slate-200 bg-slate-50 px-6 text-xs font-medium">
          <button
            onClick={() => setActiveTab('overview')}
            className={`py-3 px-4 border-b-2 font-semibold transition-colors ${
              activeTab === 'overview'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            1. Invoice & Shipping Overview
          </button>
          <button
            onClick={() => setActiveTab('documents')}
            className={`py-3 px-4 border-b-2 font-semibold transition-colors ${
              activeTab === 'documents'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            2. Original Documents ({shipment?.documents?.length || 0})
          </button>
          <button
            onClick={() => setActiveTab('payments')}
            className={`py-3 px-4 border-b-2 font-semibold transition-colors ${
              activeTab === 'payments'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            3. FIRC & Allocations
          </button>
          <button
            onClick={() => setActiveTab('brc')}
            className={`py-3 px-4 border-b-2 font-semibold transition-colors ${
              activeTab === 'brc'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            4. BRC / eBRC Tracking
          </button>
          <button
            onClick={() => setActiveTab('incentives')}
            className={`py-3 px-4 border-b-2 font-semibold transition-colors ${
              activeTab === 'incentives'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            5. Incentives (DBK/RoDTEP)
          </button>
        </div>

        {/* Body Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading && (
            <div className="py-20 text-center text-xs text-slate-400 animate-pulse">
              Loading shipment records...
            </div>
          )}

          {!loading && shipment && (
            <>
              {/* Discrepancy & Validation Warnings Bar */}
              {validationWarnings.length > 0 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-1">
                  <div className="flex items-center space-x-2 text-xs font-bold text-amber-800">
                    <AlertTriangle size={15} />
                    <span>System Validation Discrepancies ({validationWarnings.length})</span>
                  </div>
                  {validationWarnings.map((warn, i) => (
                    <p key={i} className="text-xs text-amber-700 ml-6">
                      • {warn}
                    </p>
                  ))}
                </div>
              )}

              {/* TAB 1: OVERVIEW */}
              {activeTab === 'overview' && (
                <div className="space-y-6">
                  {/* Financial KPI Summary Cards */}
                  <div className="grid grid-cols-4 gap-4">
                    <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
                      <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                        Invoice Value
                      </span>
                      <div className="text-xl font-bold text-slate-900 mt-1">
                        ${shipment.invoiceValueUsd.toLocaleString()}
                      </div>
                      <span className="text-[11px] text-slate-400">USD Standard Value</span>
                    </div>

                    <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                      <span className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider">
                        Realised Amount
                      </span>
                      <div className="text-xl font-bold text-emerald-700 mt-1">
                        ${(shipment.totalPaidUsd || 0).toLocaleString()}
                      </div>
                      <span className="text-[11px] text-emerald-600">
                        {((shipment.totalPaidUsd || 0) / shipment.invoiceValueUsd * 100).toFixed(1)}% Realised
                      </span>
                    </div>

                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
                      <span className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider">
                        Outstanding Balance
                      </span>
                      <div className="text-xl font-bold text-amber-700 mt-1">
                        ${(shipment.balanceDueUsd || 0).toLocaleString()}
                      </div>
                      <span className="text-[11px] text-amber-600">Balance USD Due</span>
                    </div>

                    <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
                      <span className="text-[11px] font-semibold text-blue-700 uppercase tracking-wider">
                        Customs FOB Value
                      </span>
                      <div className="text-xl font-bold text-blue-700 mt-1">
                        ₹{shipment.fobValueInr.toLocaleString()}
                      </div>
                      <span className="text-[11px] text-blue-600">Rate: ₹{shipment.sbExchangeRate} / USD</span>
                    </div>
                  </div>

                  {/* Shipment Data Grid */}
                  <div className="grid grid-cols-2 gap-6">
                    {/* Commercial Data */}
                    <div className="p-4 border border-slate-200 rounded-xl space-y-3 bg-white">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 border-b border-slate-100 pb-2">
                        Commercial Invoice Data
                      </h3>
                      <div className="grid grid-cols-2 gap-y-2 text-xs">
                        <span className="text-slate-500">Invoice Number:</span>
                        <span className="font-semibold text-slate-900">{shipment.invoiceNumber}</span>

                        <span className="text-slate-500">Normalized Identity:</span>
                        <span className="font-mono text-slate-800">{shipment.normalizedInvoiceKey}</span>

                        <span className="text-slate-500">Invoice Date:</span>
                        <span className="font-medium text-slate-800">{shipment.invoiceDate}</span>

                        <span className="text-slate-500">Buyer / Consignee:</span>
                        <span className="font-semibold text-slate-800">{shipment.consigneeName}</span>

                        <span className="text-slate-500">Port of Loading:</span>
                        <span className="font-medium text-slate-800">{shipment.portCode}</span>

                        <span className="text-slate-500">Total Packages:</span>
                        <span className="font-medium text-slate-800">{shipment.packageCount || 'N/A'}</span>

                        <span className="text-slate-500">Review Status:</span>
                        <span className="font-semibold text-blue-700">{shipment.reviewStatus}</span>
                      </div>
                    </div>

                    {/* Customs & Shipping Data */}
                    <div className="p-4 border border-slate-200 rounded-xl space-y-3 bg-white">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 border-b border-slate-100 pb-2">
                        Customs & Transport Data
                      </h3>
                      <div className="grid grid-cols-2 gap-y-2 text-xs">
                        <span className="text-slate-500">Shipping Bill No:</span>
                        <span className="font-semibold text-slate-900">{shipment.shippingBillNumber}</span>

                        <span className="text-slate-500">Shipping Bill Date:</span>
                        <span className="font-medium text-slate-800">{shipment.shippingBillDate}</span>

                        <span className="text-slate-500">CBIC Customs Rate:</span>
                        <span className="font-medium text-slate-800">₹{shipment.sbExchangeRate}</span>

                        <span className="text-slate-500">FOB Value (INR):</span>
                        <span className="font-semibold text-slate-800">₹{shipment.fobValueInr.toLocaleString()}</span>

                        <span className="text-slate-500">Bill of Lading No:</span>
                        <span className="font-medium text-slate-800">{shipment.blNumber || 'Pending'}</span>

                        <span className="text-slate-500">Vessel / Voyage:</span>
                        <span className="font-medium text-slate-800">{shipment.vesselName || 'Pending'}</span>

                        <span className="text-slate-500">Mandatory FIRC Evidence:</span>
                        <span className={shipment.hasFircEvidence ? 'text-emerald-700 font-bold' : 'text-red-600 font-bold'}>
                          {shipment.hasFircEvidence ? 'Linked & Verified' : 'Missing (Action Required)'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Remarks */}
                  {shipment.remarks && (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                      <strong>Remarks:</strong> {shipment.remarks}
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: DOCUMENTS */}
              {activeTab === 'documents' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">Original Stored Documents</h3>
                      <p className="text-xs text-slate-500">
                        Files stored privately in <code className="bg-slate-100 px-1 py-0.5 rounded font-mono">storage/FY{shipment.financialYearLabel}/{shipment.normalizedInvoiceKey}</code>
                      </p>
                    </div>
                    {!isViewer && (
                      <button
                        onClick={() => onOpenUpload(shipment)}
                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium shadow-sm transition-colors flex items-center space-x-1.5"
                      >
                        <Plus size={14} />
                        <span>Upload Document</span>
                      </button>
                    )}
                  </div>

                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                        <tr>
                          <th className="p-3">Category</th>
                          <th className="p-3">Original Filename</th>
                          <th className="p-3">Version</th>
                          <th className="p-3">Size</th>
                          <th className="p-3">Review Status</th>
                          <th className="p-3">Uploaded By</th>
                          <th className="p-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {shipment.documents?.map((doc) => (
                          <tr key={doc.id} className="hover:bg-slate-50/80">
                            <td className="p-3 font-semibold text-slate-900">
                              <span className="px-2 py-0.5 bg-slate-100 rounded text-slate-700 text-[11px]">
                                {doc.category.replace(/_/g, ' ')}
                              </span>
                            </td>
                            <td className="p-3 text-slate-700 font-mono text-[11px]">{doc.originalFilename}</td>
                            <td className="p-3 text-slate-600">v{doc.version}</td>
                            <td className="p-3 text-slate-500">{(doc.fileSizeBytes / 1024).toFixed(1)} KB</td>
                            <td className="p-3">
                              <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-full font-medium text-[10px]">
                                {doc.reviewStatus}
                              </span>
                            </td>
                            <td className="p-3 text-slate-600">{doc.uploadedByName}</td>
                            <td className="p-3 text-right">
                              <div className="flex items-center justify-end space-x-1.5">
                                <a
                                  href={api.getDocumentDownloadUrl(doc.id)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center space-x-1 text-blue-600 hover:text-blue-800 font-medium px-2 py-1 bg-blue-50 rounded"
                                >
                                  <Download size={13} />
                                  <span>Download</span>
                                </a>
                                {!isViewer && (
                                  <button
                                    onClick={() => handleDeleteDocument(doc.id, doc.originalFilename)}
                                    title="Delete Document"
                                    className="p-1 rounded hover:bg-red-50 text-red-600 hover:text-red-800"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                        {(!shipment.documents || shipment.documents.length === 0) && (
                          <tr>
                            <td colSpan={7} className="p-8 text-center text-slate-400">
                              No documents uploaded yet for this shipment.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* TAB 3: PAYMENTS & ALLOCATIONS */}
              {activeTab === 'payments' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">Linked Inward Payments (FIRC)</h3>
                      <p className="text-xs text-slate-500">
                        Allocated foreign currency remittances against Invoice {shipment.invoiceNumber}
                      </p>
                    </div>
                    {!isViewer && (
                      <button
                        onClick={() => onOpenAllocate(shipment)}
                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-medium shadow-sm transition-colors flex items-center space-x-1.5"
                      >
                        <Plus size={14} />
                        <span>Allocate Another Payment</span>
                      </button>
                    )}
                  </div>

                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                        <tr>
                          <th className="p-3">IRM Reference No</th>
                          <th className="p-3">Allocated USD</th>
                          <th className="p-3">Allocated Date</th>
                          <th className="p-3">Allocated By</th>
                          <th className="p-3">Notes</th>
                          {!isViewer && <th className="p-3 text-right">Action</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {shipment.allocations?.map((alloc) => (
                          <tr key={alloc.id} className="hover:bg-slate-50">
                            <td className="p-3 font-mono font-semibold text-blue-700">{alloc.paymentIrm}</td>
                            <td className="p-3 font-bold text-slate-900">${alloc.allocatedAmountUsd.toLocaleString()}</td>
                            <td className="p-3 text-slate-600">{alloc.allocatedAt.split('T')[0]}</td>
                            <td className="p-3 text-slate-600">{alloc.allocatedByName}</td>
                            <td className="p-3 text-slate-500">{alloc.notes || '—'}</td>
                            {!isViewer && (
                              <td className="p-3 text-right">
                                <button
                                  onClick={async () => {
                                    if (confirm('Reverse this payment allocation?')) {
                                      await api.deallocatePayment(alloc.id);
                                      loadData();
                                    }
                                  }}
                                  className="text-red-600 hover:text-red-800 font-medium px-2 py-1 bg-red-50 rounded"
                                >
                                  Deallocate
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                        {(!shipment.allocations || shipment.allocations.length === 0) && (
                          <tr>
                            <td colSpan={6} className="p-8 text-center text-slate-400">
                              No payments allocated to this invoice yet.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* TAB 4: BRC */}
              {activeTab === 'brc' && (
                <div className="space-y-4">
                  <div className="p-4 border border-slate-200 rounded-xl bg-white space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">Bank Realisation Certificate (BRC) Status</h3>
                        <p className="text-xs text-slate-500">DGFT Statement of Bank Realisation / eBRC</p>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span
                          className={`px-3 py-1 rounded-full text-xs font-semibold ${
                            shipment.brcRecord?.status === 'REALISED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : shipment.brcRecord?.status === 'ISSUED'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {shipment.brcRecord?.status || 'PENDING'}
                        </span>
                        {!isViewer && !isEditingBrc && (
                          <div className="flex items-center space-x-1.5 ml-2">
                            <button
                              onClick={openEditBrc}
                              className="px-2.5 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold rounded transition-colors"
                            >
                              Edit BRC Details
                            </button>
                            {(shipment.brcRecord?.status === 'ISSUED' || shipment.brcRecord?.status === 'REALISED') && (
                              <button
                                onClick={handleResetBrc}
                                className="px-2.5 py-1 bg-red-50 hover:bg-red-100 text-red-600 text-xs font-semibold rounded transition-colors"
                              >
                                Reset BRC
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {isEditingBrc ? (
                      <form onSubmit={handleSaveBrc} className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-4 text-xs">
                        <div className="font-bold text-slate-800 text-sm">Update Bank Realisation Certificate</div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="font-semibold text-slate-700 block mb-1">BRC Reference Number</label>
                            <input
                              type="text"
                              value={brcNumber}
                              onChange={(e) => setBrcNumber(e.target.value)}
                              placeholder="e.g. BRC-2026-08892"
                              className="w-full border border-slate-300 rounded-lg p-2 font-mono"
                            />
                          </div>
                          <div>
                            <label className="font-semibold text-slate-700 block mb-1">BRC Realisation Status</label>
                            <select
                              value={brcStatus}
                              onChange={(e) => setBrcStatus(e.target.value as any)}
                              className="w-full border border-slate-300 rounded-lg p-2 bg-white font-semibold"
                            >
                              <option value="PENDING">PENDING</option>
                              <option value="ISSUED">ISSUED</option>
                              <option value="REALISED">REALISED</option>
                            </select>
                          </div>
                          <div>
                            <label className="font-semibold text-slate-700 block mb-1">Certificate Issue Date</label>
                            <input
                              type="date"
                              value={brcIssueDate}
                              onChange={(e) => setBrcIssueDate(e.target.value)}
                              className="w-full border border-slate-300 rounded-lg p-2"
                            />
                          </div>
                          <div>
                            <label className="font-semibold text-slate-700 block mb-1">Bank Realisation Date</label>
                            <input
                              type="date"
                              value={brcRealisationDate}
                              onChange={(e) => setBrcRealisationDate(e.target.value)}
                              className="w-full border border-slate-300 rounded-lg p-2"
                            />
                          </div>
                          <div>
                            <label className="font-semibold text-slate-700 block mb-1">Upload Mode</label>
                            <select
                              value={brcUploadMode}
                              onChange={(e) => setBrcUploadMode(e.target.value as any)}
                              className="w-full border border-slate-300 rounded-lg p-2 bg-white"
                            >
                              <option value="SINGLE">SINGLE (1 File Mode)</option>
                              <option value="MULTIPLE">MULTIPLE (2 Files Mode)</option>
                            </select>
                          </div>
                          <div>
                            <label className="font-semibold text-slate-700 block mb-1">Remarks / Bank EDPMS Notes</label>
                            <input
                              type="text"
                              value={brcRemarks}
                              onChange={(e) => setBrcRemarks(e.target.value)}
                              placeholder="Optional remarks"
                              className="w-full border border-slate-300 rounded-lg p-2"
                            />
                          </div>
                        </div>
                        <div className="flex justify-end space-x-2 pt-2 border-t border-slate-200">
                          <button
                            type="button"
                            onClick={() => setIsEditingBrc(false)}
                            className="px-3 py-1.5 border border-slate-300 rounded-lg font-semibold text-slate-600 hover:bg-slate-200"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold shadow-sm"
                          >
                            Save BRC Details
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="grid grid-cols-2 gap-4 text-xs">
                        <div>
                          <span className="text-slate-500 block">BRC Reference Number:</span>
                          <span className="font-mono font-semibold text-slate-900 text-sm">
                            {shipment.brcRecord?.brcNumber || 'Awaiting issuance'}
                          </span>
                        </div>

                        <div>
                          <span className="text-slate-500 block">Upload Mode:</span>
                          <span className="font-semibold text-slate-800">
                            {shipment.brcRecord?.uploadMode === 'SINGLE' ? 'Single BRC Mode (1 File)' : 'Multiple Mode (2 Files)'}
                          </span>
                        </div>

                        <div>
                          <span className="text-slate-500 block">Issue Date:</span>
                          <span className="font-medium text-slate-800">{shipment.brcRecord?.issueDate || '—'}</span>
                        </div>

                        <div>
                          <span className="text-slate-500 block">Bank Realisation Date:</span>
                          <span className="font-medium text-slate-800">{shipment.brcRecord?.realisationDate || '—'}</span>
                        </div>

                        <div>
                          <span className="text-slate-500 block">Statutory Realisation Deadline:</span>
                          <span className="font-semibold text-amber-700">{shipment.brcRecord?.statutoryDeadline || '—'}</span>
                        </div>

                        <div>
                          <span className="text-slate-500 block">Net Realised USD:</span>
                          <span className="font-bold text-slate-900">
                            ${(shipment.brcRecord?.realisedAmount || shipment.totalPaidUsd || 0).toLocaleString()}
                          </span>
                        </div>

                        {shipment.brcRecord?.remarks && (
                          <div className="col-span-2 pt-2 border-t border-slate-100">
                            <span className="text-slate-500 block">BRC Notes:</span>
                            <span className="text-slate-800">{shipment.brcRecord.remarks}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 5: INCENTIVES */}
              {activeTab === 'incentives' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900">Export Incentives & Subsidies</h3>
                      <p className="text-xs text-slate-500">
                        Government incentive claims (Duty Drawback DBK, RoDTEP, RoSCTL) for Invoice {shipment.invoiceNumber}
                      </p>
                    </div>
                    {!isViewer && (
                      <button
                        onClick={openCreateIncentive}
                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold shadow-sm flex items-center space-x-1.5"
                      >
                        <Plus size={14} />
                        <span>Add Incentive</span>
                      </button>
                    )}
                  </div>

                  {/* Add Incentive Form Drawer */}
                  {isAddingIncentive && (
                    <form onSubmit={handleCreateIncentive} className="p-4 bg-blue-50/50 rounded-xl border border-blue-200 space-y-3 text-xs">
                      <div className="font-bold text-slate-900 text-sm">Add New Incentive Claim</div>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Scheme Type *</label>
                          <select
                            value={incType}
                            onChange={(e) => setIncType(e.target.value as any)}
                            className="w-full border border-slate-300 rounded-lg p-2 bg-white font-semibold"
                          >
                            <option value="DRAWBACK">Duty Drawback (DBK)</option>
                            <option value="RODTEP">RoDTEP</option>
                            <option value="ROSCTL">RoSCTL</option>
                          </select>
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Claimed Amount (INR) *</label>
                          <input
                            type="number"
                            required
                            min={0}
                            value={incClaimed || ''}
                            onChange={(e) => setIncClaimed(Number(e.target.value))}
                            className="w-full border border-slate-300 rounded-lg p-2 font-mono font-semibold"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Status</label>
                          <select
                            value={incStatus}
                            onChange={(e) => setIncStatus(e.target.value)}
                            className="w-full border border-slate-300 rounded-lg p-2 bg-white"
                          >
                            <option value="CLAIMED">CLAIMED</option>
                            <option value="PART_RECEIVED">PART_RECEIVED</option>
                            <option value="RECEIVED">RECEIVED</option>
                            <option value="REJECTED">REJECTED</option>
                          </select>
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Received (INR)</label>
                          <input
                            type="number"
                            min={0}
                            value={incReceived || ''}
                            onChange={(e) => setIncReceived(Number(e.target.value))}
                            className="w-full border border-slate-300 rounded-lg p-2 font-mono text-emerald-700 font-semibold"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Scroll Number / Ref</label>
                          <input
                            type="text"
                            value={incScrollNo}
                            onChange={(e) => setIncScrollNo(e.target.value)}
                            placeholder="e.g. SCROLL/2026/0991"
                            className="w-full border border-slate-300 rounded-lg p-2 font-mono"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Receipt Date</label>
                          <input
                            type="date"
                            value={incReceivedDate}
                            onChange={(e) => setIncReceivedDate(e.target.value)}
                            className="w-full border border-slate-300 rounded-lg p-2"
                          />
                        </div>
                      </div>
                      <div className="flex justify-end space-x-2 pt-2 border-t border-blue-200">
                        <button
                          type="button"
                          onClick={() => setIsAddingIncentive(false)}
                          className="px-3 py-1.5 border border-slate-300 rounded-lg font-semibold text-slate-600 bg-white hover:bg-slate-100"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold shadow-sm"
                        >
                          Save Incentive
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Edit Incentive Form Drawer */}
                  {editingIncentive && (
                    <form onSubmit={handleSaveIncentive} className="p-4 bg-amber-50/50 rounded-xl border border-amber-200 space-y-3 text-xs">
                      <div className="font-bold text-slate-900 text-sm">
                        Edit Incentive: {editingIncentive.type === 'DRAWBACK' ? 'Duty Drawback (DBK)' : editingIncentive.type}
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Claimed Amount (INR)</label>
                          <input
                            type="number"
                            min={0}
                            value={incClaimed}
                            onChange={(e) => setIncClaimed(Number(e.target.value))}
                            className="w-full border border-slate-300 rounded-lg p-2 font-mono font-semibold"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Claim Status</label>
                          <select
                            value={incStatus}
                            onChange={(e) => setIncStatus(e.target.value)}
                            className="w-full border border-slate-300 rounded-lg p-2 bg-white font-semibold"
                          >
                            <option value="CLAIMED">CLAIMED</option>
                            <option value="PART_RECEIVED">PART_RECEIVED</option>
                            <option value="RECEIVED">RECEIVED</option>
                            <option value="REJECTED">REJECTED</option>
                          </select>
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Received Amount (INR)</label>
                          <input
                            type="number"
                            min={0}
                            value={incReceived}
                            onChange={(e) => setIncReceived(Number(e.target.value))}
                            className="w-full border border-slate-300 rounded-lg p-2 font-mono text-emerald-700 font-semibold"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Credit / Receipt Date</label>
                          <input
                            type="date"
                            value={incReceivedDate}
                            onChange={(e) => setIncReceivedDate(e.target.value)}
                            className="w-full border border-slate-300 rounded-lg p-2"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Scroll Number</label>
                          <input
                            type="text"
                            value={incScrollNo}
                            onChange={(e) => setIncScrollNo(e.target.value)}
                            placeholder="e.g. SCR-2026-443"
                            className="w-full border border-slate-300 rounded-lg p-2 font-mono"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700 block mb-1">Remarks</label>
                          <input
                            type="text"
                            value={incRemarks}
                            onChange={(e) => setIncRemarks(e.target.value)}
                            placeholder="Optional notes"
                            className="w-full border border-slate-300 rounded-lg p-2"
                          />
                        </div>
                      </div>
                      <div className="flex justify-end space-x-2 pt-2 border-t border-amber-200">
                        <button
                          type="button"
                          onClick={() => setEditingIncentive(null)}
                          className="px-3 py-1.5 border border-slate-300 rounded-lg font-semibold text-slate-600 bg-white hover:bg-slate-100"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold shadow-sm"
                        >
                          Save Changes
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                        <tr>
                          <th className="p-3">Incentive Type</th>
                          <th className="p-3">Claimed (INR)</th>
                          <th className="p-3">Status</th>
                          <th className="p-3">Received (INR)</th>
                          <th className="p-3">Received Date</th>
                          <th className="p-3">Pending Balance</th>
                          <th className="p-3">Scroll No</th>
                          {!isViewer && <th className="p-3 text-right">Actions</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {shipment.incentives?.map((inc) => (
                          <tr key={inc.id} className="hover:bg-slate-50">
                            <td className="p-3 font-semibold text-slate-900">
                              {inc.type === 'DRAWBACK' ? 'Duty Drawback (DBK)' : inc.type}
                            </td>
                            <td className="p-3 font-medium text-slate-800">₹{inc.claimedAmount.toLocaleString()}</td>
                            <td className="p-3">
                              <span
                                className={`px-2 py-0.5 rounded-full font-semibold text-[10px] ${
                                  inc.status === 'RECEIVED'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : inc.status === 'PART_RECEIVED'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-slate-100 text-slate-700'
                                }`}
                              >
                                {inc.status}
                              </span>
                            </td>
                            <td className="p-3 font-bold text-emerald-700">₹{inc.receivedAmount.toLocaleString()}</td>
                            <td className="p-3 text-slate-600">{inc.receivedDate || '—'}</td>
                            <td className="p-3 font-semibold text-amber-700">₹{(inc.outstandingBalance || 0).toLocaleString()}</td>
                            <td className="p-3 font-mono text-slate-600">{inc.scrollNumber || '—'}</td>
                            {!isViewer && (
                              <td className="p-3 text-right">
                                <div className="inline-flex items-center space-x-1.5">
                                  <button
                                    onClick={() => openEditIncentive(inc)}
                                    className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[11px] font-semibold transition-colors"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    onClick={() => handleDeleteIncentive(inc.id, inc.type)}
                                    className="p-1 text-red-600 hover:bg-red-50 rounded transition-colors"
                                    title="Delete incentive claim"
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                        {(!shipment.incentives || shipment.incentives.length === 0) && (
                          <tr>
                            <td colSpan={isViewer ? 7 : 8} className="p-8 text-center text-slate-400">
                              No export incentives recorded for this shipment.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
