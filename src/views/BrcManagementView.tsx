/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { FileCheck2, Calendar, AlertTriangle, CheckCircle2, Clock, Upload, ArrowRight, Eye } from 'lucide-react';
import { Shipment, Role } from '../types/index.ts';
import { api } from '../api/client.ts';

interface BrcManagementViewProps {
  selectedFyId: string;
  onSelectShipment: (id: string) => void;
  onOpenUpload: (shipment: Shipment) => void;
  userRole: Role;
}

export const BrcManagementView: React.FC<BrcManagementViewProps> = ({
  selectedFyId,
  onSelectShipment,
  onOpenUpload,
  userRole,
}) => {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingBrcShipment, setEditingBrcShipment] = useState<Shipment | null>(null);

  // Edit BRC Form State
  const [brcNumber, setBrcNumber] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [realisationDate, setRealisationDate] = useState('');
  const [uploadMode, setUploadMode] = useState<'SINGLE' | 'MULTIPLE'>('SINGLE');
  const [statutoryDeadline, setStatutoryDeadline] = useState('');
  const [status, setStatus] = useState<any>('PENDING');
  const [remarks, setRemarks] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      const list = await api.getShipments({ financialYearId: selectedFyId });
      setShipments(list);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [selectedFyId]);

  const openEditBrc = (s: Shipment) => {
    setEditingBrcShipment(s);
    setBrcNumber(s.brcRecord?.brcNumber || '');
    setIssueDate(s.brcRecord?.issueDate || '');
    setRealisationDate(s.brcRecord?.realisationDate || '');
    setUploadMode(s.brcRecord?.uploadMode || 'SINGLE');
    setStatutoryDeadline(s.brcRecord?.statutoryDeadline || '');
    setStatus(s.brcRecord?.status || 'PENDING');
    setRemarks(s.brcRecord?.remarks || '');
  };

  const handleSaveBrc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBrcShipment || !editingBrcShipment.brcRecord) return;

    try {
      await api.updateBrc(editingBrcShipment.brcRecord.id, {
        brcNumber,
        issueDate: issueDate || undefined,
        realisationDate: realisationDate || undefined,
        uploadMode,
        statutoryDeadline: statutoryDeadline || undefined,
        status,
        remarks,
      });
      setEditingBrcShipment(null);
      loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to update BRC');
    }
  };

  const isViewer = userRole === 'VIEWER';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <FileCheck2 size={20} className="text-blue-600" />
            <span>Bank Realisation Certificates (BRC / eBRC) Console</span>
          </h2>
          <p className="text-xs text-slate-500">
            DGFT statement tracking, statutory deadline compliance, and dual-mode document management
          </p>
        </div>
      </div>

      {/* BRC Table */}
      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
        <div className="overflow-x-auto max-h-[calc(100vh-280px)]">
          <table className="w-full min-w-[1050px] text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-900 text-slate-200 text-[11px] uppercase tracking-wider font-semibold sticky top-0 z-10">
              <tr>
                <th className="p-3">Invoice No.</th>
                <th className="p-3">Buyer (Consignee)</th>
                <th className="p-3">Shipping Bill Date</th>
                <th className="p-3">BRC Reference No.</th>
                <th className="p-3">BRC Issue Date</th>
                <th className="p-3">Realisation Date</th>
                <th className="p-3">Upload Mode</th>
                <th className="p-3">Statutory Deadline</th>
                <th className="p-3 text-center">BRC Status</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr>
                  <td colSpan={10} className="p-12 text-center text-slate-400 animate-pulse">
                    Loading BRC compliance records...
                  </td>
                </tr>
              )}

              {!loading &&
                shipments.map((s) => {
                  const brc = s.brcRecord;
                  const isOverdue =
                    brc?.status === 'PENDING' &&
                    brc?.statutoryDeadline &&
                    new Date(brc.statutoryDeadline) < new Date();

                  return (
                    <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3 font-bold text-slate-900">{s.invoiceNumber}</td>
                      <td className="p-3 font-medium text-slate-700">{s.consigneeName}</td>
                      <td className="p-3 text-slate-600">{s.shippingBillDate}</td>
                      <td className="p-3 font-mono font-semibold text-blue-700">
                        {brc?.brcNumber || <span className="text-slate-400 font-normal">Pending Issuance</span>}
                      </td>
                      <td className="p-3 text-slate-600">{brc?.issueDate || '—'}</td>
                      <td className="p-3 text-slate-600">{brc?.realisationDate || '—'}</td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 bg-slate-100 rounded text-[10px] font-medium text-slate-700">
                          {brc?.uploadMode === 'SINGLE' ? 'Single (1 File)' : 'Multiple (2 Files)'}
                        </span>
                      </td>
                      <td className="p-3 font-medium">
                        <span className={isOverdue ? 'text-red-600 font-bold' : 'text-slate-700'}>
                          {brc?.statutoryDeadline || '—'}
                        </span>
                      </td>
                      <td className="p-3 text-center">
                        <span
                          className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                            brc?.status === 'REALISED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : isOverdue
                              ? 'bg-red-100 text-red-800'
                              : brc?.status === 'ISSUED'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {isOverdue ? 'OVERDUE' : brc?.status || 'PENDING'}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end space-x-2">
                          {!isViewer && (
                            <>
                              <button
                                onClick={() => openEditBrc(s)}
                                className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded font-medium text-[11px] transition-colors"
                              >
                                Update BRC
                              </button>
                              <button
                                onClick={() => onOpenUpload(s)}
                                title="Upload BRC File"
                                className="px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded font-medium text-[11px] flex items-center gap-1 transition-colors"
                              >
                                <Upload size={12} />
                                <span>Attach</span>
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => onSelectShipment(s.id)}
                            className="p-1 text-slate-400 hover:text-slate-700 transition-colors"
                          >
                            <Eye size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit BRC Modal */}
      {editingBrcShipment && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg rounded-xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">
                Update BRC Record — {editingBrcShipment.invoiceNumber}
              </h3>
              <button
                onClick={() => setEditingBrcShipment(null)}
                className="p-1 text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveBrc} className="p-6 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="font-semibold text-slate-700 block mb-1">BRC Reference Number</label>
                  <input
                    type="text"
                    placeholder="e.g. BRC-DGFT-2026-8841"
                    value={brcNumber}
                    onChange={(e) => setBrcNumber(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 font-mono font-semibold"
                  />
                </div>

                <div>
                  <label className="font-semibold text-slate-700 block mb-1">BRC Issue Date</label>
                  <input
                    type="date"
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2"
                  />
                </div>

                <div>
                  <label className="font-semibold text-slate-700 block mb-1">Bank Realisation Date</label>
                  <input
                    type="date"
                    value={realisationDate}
                    onChange={(e) => setRealisationDate(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2"
                  />
                </div>

                <div>
                  <label className="font-semibold text-slate-700 block mb-1">Upload Mode (Section 7)</label>
                  <select
                    value={uploadMode}
                    onChange={(e) => setUploadMode(e.target.value as any)}
                    className="w-full border border-slate-300 rounded-lg p-2 bg-white font-medium"
                  >
                    <option value="SINGLE">Single Mode (Exactly 1 File)</option>
                    <option value="MULTIPLE">Multiple Mode (Exactly 2 Separate Files)</option>
                  </select>
                </div>

                <div>
                  <label className="font-semibold text-slate-700 block mb-1">Statutory Deadline</label>
                  <input
                    type="date"
                    value={statutoryDeadline}
                    onChange={(e) => setStatutoryDeadline(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 font-semibold text-amber-700"
                  />
                </div>

                <div className="col-span-2">
                  <label className="font-semibold text-slate-700 block mb-1">BRC Status</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 bg-white font-bold"
                  >
                    <option value="PENDING">PENDING (Awaiting Issuance)</option>
                    <option value="ISSUED">ISSUED (Statement Generated)</option>
                    <option value="REALISED">REALISED (Realisation Settled)</option>
                    <option value="OVERDUE">OVERDUE (Statutory Limit Exceeded)</option>
                  </select>
                </div>

                <div className="col-span-2">
                  <label className="font-semibold text-slate-700 block mb-1">Remarks</label>
                  <textarea
                    rows={2}
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2"
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setEditingBrcShipment(null)}
                  className="px-4 py-2 border border-slate-300 rounded-lg font-semibold text-slate-600 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold shadow-sm"
                >
                  Save BRC Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
