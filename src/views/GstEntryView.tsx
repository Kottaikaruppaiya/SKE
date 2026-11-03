/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Receipt,
  Plus,
  Search,
  Filter,
  FileSpreadsheet,
  Trash2,
  Edit2,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle2,
  X,
  AlertCircle,
  RefreshCw,
  Building2,
  Calendar,
  FileText,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { GstEntry, GstSummary, GstResult, ConsigneeMaster, Role } from '../types/index.ts';
import { api } from '../api/client.ts';
import { ConfirmationModal } from '../components/ConfirmationModal.tsx';

interface GstEntryViewProps {
  consignees: ConsigneeMaster[];
  userRole: Role;
  refreshKey?: number;
}

export const GstEntryView: React.FC<GstEntryViewProps> = ({ consignees, userRole, refreshKey = 0 }) => {
  const isViewer = userRole === 'VIEWER';

  // Data states
  const [entries, setEntries] = useState<GstEntry[]>([]);
  const [summary, setSummary] = useState<GstSummary>({
    totalEntries: 0,
    totalIgst: 0,
    totalCgst: 0,
    totalSgst: 0,
    totalGst: 0,
    totalRefundEligible: 0,
    netDifference: 0,
    gainCount: 0,
    lossCount: 0,
    nilCount: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters & search
  const [searchTerm, setSearchTerm] = useState('');
  const [filterConsigneeId, setFilterConsigneeId] = useState('');
  const [filterResult, setFilterResult] = useState<string>('ALL');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [sortBy, setSortBy] = useState<'entryDate' | 'totalGst' | 'refundEligible' | 'difference'>('entryDate');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  // Form modal (Create / Edit)
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<GstEntry | null>(null);
  const [formDate, setFormDate] = useState(new Date().toISOString().split('T')[0]);
  const [formConsigneeId, setFormConsigneeId] = useState(consignees[0]?.id || '');
  const [formIgst, setFormIgst] = useState<string>('0');
  const [formCgst, setFormCgst] = useState<string>('0');
  const [formSgst, setFormSgst] = useState<string>('0');
  const [formRefundEligible, setFormRefundEligible] = useState<string>('0');
  const [formRemarks, setFormRemarks] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Delete modal
  const [deletingEntry, setDeletingEntry] = useState<GstEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Load data
  const loadGstData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.getGstEntries({
        consigneeId: filterConsigneeId || undefined,
        result: filterResult !== 'ALL' ? filterResult : undefined,
        startDate: filterStartDate || undefined,
        endDate: filterEndDate || undefined,
        search: searchTerm || undefined,
        sortBy,
        sortOrder,
      });
      setEntries(res.entries);
      setSummary(res.summary);
    } catch (err: any) {
      console.error('Failed to load GST entries:', err);
      setError(err.message || 'Error fetching GST entries from server.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadGstData();
  }, [filterConsigneeId, filterResult, filterStartDate, filterEndDate, sortBy, sortOrder, refreshKey]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      loadGstData();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Live calculation for form
  const numIgst = Math.max(0, parseFloat(formIgst) || 0);
  const numCgst = Math.max(0, parseFloat(formCgst) || 0);
  const numSgst = Math.max(0, parseFloat(formSgst) || 0);
  const numRefund = Math.max(0, parseFloat(formRefundEligible) || 0);

  const formCalculatedTotalGst = Math.round((numIgst + numCgst + numSgst) * 100) / 100;
  const formCalculatedDiffCents = Math.round(numRefund * 100) - Math.round(formCalculatedTotalGst * 100);
  const formCalculatedDiff = formCalculatedDiffCents / 100;
  const formCalculatedResult: GstResult =
    formCalculatedDiffCents > 0 ? 'GAIN' : formCalculatedDiffCents < 0 ? 'LOSS' : 'NIL';

  const openNewEntryModal = () => {
    setEditingEntry(null);
    setFormDate(new Date().toISOString().split('T')[0]);
    setFormConsigneeId(consignees[0]?.id || '');
    setFormIgst('0');
    setFormCgst('0');
    setFormSgst('0');
    setFormRefundEligible('0');
    setFormRemarks('');
    setFormError(null);
    setIsFormOpen(true);
  };

  const openEditEntryModal = (entry: GstEntry) => {
    setEditingEntry(entry);
    setFormDate(entry.entryDate);
    setFormConsigneeId(entry.consigneeId);
    setFormIgst(entry.igst.toString());
    setFormCgst(entry.cgst.toString());
    setFormSgst(entry.sgst.toString());
    setFormRefundEligible(entry.refundEligible.toString());
    setFormRemarks(entry.remarks || '');
    setFormError(null);
    setIsFormOpen(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formConsigneeId) {
      setFormError('Please select a consignee from Consignee Master.');
      return;
    }

    if (numIgst < 0 || numCgst < 0 || numSgst < 0 || numRefund < 0) {
      setFormError('GST amounts and Refund Eligible cannot be negative values.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (editingEntry) {
        await api.updateGstEntry(editingEntry.id, {
          entryDate: formDate,
          consigneeId: formConsigneeId,
          igst: numIgst,
          cgst: numCgst,
          sgst: numSgst,
          refundEligible: numRefund,
          remarks: formRemarks,
        });
      } else {
        await api.createGstEntry({
          entryDate: formDate,
          consigneeId: formConsigneeId,
          igst: numIgst,
          cgst: numCgst,
          sgst: numSgst,
          refundEligible: numRefund,
          remarks: formRemarks,
        });
      }
      setIsFormOpen(false);
      await loadGstData();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save GST entry.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteEntry = async () => {
    if (!deletingEntry) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteGstEntry(deletingEntry.id);
      setDeletingEntry(null);
      await loadGstData();
    } catch (err: any) {
      setDeleteError(err.message || 'Failed to delete GST entry.');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleExcelExport = () => {
    const url = api.getGstExportUrl({
      consigneeId: filterConsigneeId || undefined,
      result: filterResult !== 'ALL' ? filterResult : undefined,
      startDate: filterStartDate || undefined,
      endDate: filterEndDate || undefined,
      search: searchTerm || undefined,
    });
    window.open(url, '_blank');
  };

  const formatCurrency = (val: number) => {
    const isNegative = val < 0;
    const formatted = Math.abs(val).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${isNegative ? '-' : ''}₹ ${formatted}`;
  };

  // Pagination slice
  const paginatedEntries = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return entries.slice(start, start + pageSize);
  }, [entries, currentPage]);

  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Top Banner Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-2xs">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center font-bold">
              <Receipt size={22} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">GST Entry & Refund Tracker</h1>
              <p className="text-xs text-slate-500">
                Consignee-wise statutory GST ledger & automated Refund Eligible reconciliation (GAIN / LOSS / NIL)
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={handleExcelExport}
            className="h-9 px-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl text-xs inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Download GST records as Excel workbook"
          >
            <FileSpreadsheet size={15} className="text-emerald-700" />
            <span>Export Excel</span>
          </button>

          {!isViewer && (
            <button
              onClick={openNewEntryModal}
              className="h-9 px-4 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-xs inline-flex items-center gap-1.5 shadow-2xs transition-colors cursor-pointer"
            >
              <Plus size={16} />
              <span>New GST Entry</span>
            </button>
          )}

          <button
            onClick={loadGstData}
            className="h-9 w-9 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl flex items-center justify-center transition-colors cursor-pointer"
            title="Refresh table"
          >
            <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Summary Cards Top Section */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
        {/* 1. Total GST Entries */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Total Entries</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{summary.totalEntries}</div>
          <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
            <span>Filtered count: {entries.length}</span>
          </div>
        </div>

        {/* 2. Total IGST */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Total IGST</div>
          <div className="text-lg sm:text-xl font-black text-slate-900 mt-1">{formatCurrency(summary.totalIgst)}</div>
          <div className="text-[10px] text-slate-400 mt-1">Inter-state / Export</div>
        </div>

        {/* 3. Total CGST */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Total CGST</div>
          <div className="text-lg sm:text-xl font-black text-slate-900 mt-1">{formatCurrency(summary.totalCgst)}</div>
          <div className="text-[10px] text-slate-400 mt-1">Central Tax</div>
        </div>

        {/* 4. Total SGST */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Total SGST</div>
          <div className="text-lg sm:text-xl font-black text-slate-900 mt-1">{formatCurrency(summary.totalSgst)}</div>
          <div className="text-[10px] text-slate-400 mt-1">State / UT Tax</div>
        </div>

        {/* 5. Combined Total GST */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <div className="text-[11px] font-bold text-blue-700 uppercase tracking-wider">Total GST (Gross)</div>
          <div className="text-lg sm:text-xl font-black text-blue-900 mt-1">{formatCurrency(summary.totalGst)}</div>
          <div className="text-[10px] text-blue-600/80 mt-1">IGST + CGST + SGST</div>
        </div>

        {/* 6. Refund Eligible */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <div className="text-[11px] font-bold text-purple-700 uppercase tracking-wider">Refund Eligible</div>
          <div className="text-lg sm:text-xl font-black text-purple-900 mt-1">{formatCurrency(summary.totalRefundEligible)}</div>
          <div className="text-[10px] text-purple-600/80 mt-1">Statutory refund basis</div>
        </div>

        {/* 7. Net Difference */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs col-span-2 sm:col-span-1">
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Net Difference</div>
          <div
            className={`text-lg sm:text-xl font-black mt-1 ${
              summary.netDifference > 0
                ? 'text-emerald-700'
                : summary.netDifference < 0
                ? 'text-rose-700'
                : 'text-slate-700'
            }`}
          >
            {formatCurrency(summary.netDifference)}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 font-semibold">
            {summary.netDifference > 0 ? 'NET REFUND GAIN' : summary.netDifference < 0 ? 'NET REFUND LOSS' : 'NIL VARIANCE'}
          </div>
        </div>

        {/* 8. GAIN Count */}
        <div className="bg-emerald-50/80 border border-emerald-200 p-4 rounded-xl shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-emerald-800 uppercase tracking-wider">GAIN Entries</span>
            <TrendingUp size={16} className="text-emerald-600" />
          </div>
          <div className="text-2xl font-black text-emerald-900 mt-1">{summary.gainCount}</div>
          <div className="text-[10px] text-emerald-700 mt-1 font-medium">Refund &gt; Total GST</div>
        </div>

        {/* 9. LOSS Count */}
        <div className="bg-rose-50/80 border border-rose-200 p-4 rounded-xl shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-rose-800 uppercase tracking-wider">LOSS Entries</span>
            <TrendingDown size={16} className="text-rose-600" />
          </div>
          <div className="text-2xl font-black text-rose-900 mt-1">{summary.lossCount}</div>
          <div className="text-[10px] text-rose-700 mt-1 font-medium">Refund &lt; Total GST</div>
        </div>

        {/* 10. NIL Count */}
        <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-slate-700 uppercase tracking-wider">NIL Entries</span>
            <Minus size={16} className="text-slate-500" />
          </div>
          <div className="text-2xl font-black text-slate-800 mt-1">{summary.nilCount}</div>
          <div className="text-[10px] text-slate-600 mt-1 font-medium">Refund == Total GST</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          {/* Search */}
          <div className="relative lg:col-span-2">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search Consignee, Remarks, Entry ID..."
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-900 focus:bg-white focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Consignee Filter */}
          <div>
            <select
              value={filterConsigneeId}
              onChange={(e) => setFilterConsigneeId(e.target.value)}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:bg-white focus:ring-1 focus:ring-blue-500"
            >
              <option value="">All Consignees</option>
              {consignees.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Result Filter */}
          <div>
            <select
              value={filterResult}
              onChange={(e) => setFilterResult(e.target.value)}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:bg-white focus:ring-1 focus:ring-blue-500"
            >
              <option value="ALL">All Results (GAIN / LOSS / NIL)</option>
              <option value="GAIN">GAIN Only</option>
              <option value="LOSS">LOSS Only</option>
              <option value="NIL">NIL Only</option>
            </select>
          </div>

          {/* Date range From */}
          <div>
            <input
              type="date"
              value={filterStartDate}
              onChange={(e) => setFilterStartDate(e.target.value)}
              placeholder="From Date"
              title="From Entry Date"
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:bg-white focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Date range To */}
          <div>
            <input
              type="date"
              value={filterEndDate}
              onChange={(e) => setFilterEndDate(e.target.value)}
              placeholder="To Date"
              title="To Entry Date"
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:bg-white focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Sorting & Reset Actions */}
        <div className="flex flex-wrap items-center justify-between text-xs pt-1 border-t border-slate-100 gap-2">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 font-medium">Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-transparent font-bold text-slate-700 py-1 text-xs cursor-pointer focus:outline-none"
            >
              <option value="entryDate">Entry Date</option>
              <option value="totalGst">Total GST</option>
              <option value="refundEligible">Refund Eligible</option>
              <option value="difference">Difference</option>
            </select>
            <button
              onClick={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
              className="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[10px] cursor-pointer"
            >
              {sortOrder === 'asc' ? 'ASC ↑' : 'DESC ↓'}
            </button>
          </div>

          {(searchTerm || filterConsigneeId || filterResult !== 'ALL' || filterStartDate || filterEndDate) && (
            <button
              onClick={() => {
                setSearchTerm('');
                setFilterConsigneeId('');
                setFilterResult('ALL');
                setFilterStartDate('');
                setFilterEndDate('');
              }}
              className="text-blue-600 hover:text-blue-800 font-semibold text-xs cursor-pointer"
            >
              Clear All Filters
            </button>
          )}
        </div>
      </div>

      {/* Main Records Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-bold uppercase tracking-wider text-[11px]">
              <tr>
                <th className="p-3.5">Entry ID</th>
                <th className="p-3.5">Entry Date</th>
                <th className="p-3.5">Consignee</th>
                <th className="p-3.5 text-right">IGST (₹)</th>
                <th className="p-3.5 text-right">CGST (₹)</th>
                <th className="p-3.5 text-right">SGST (₹)</th>
                <th className="p-3.5 text-right">Total GST (₹)</th>
                <th className="p-3.5 text-right">Refund Eligible (₹)</th>
                <th className="p-3.5 text-right">Difference (₹)</th>
                <th className="p-3.5 text-center">Result</th>
                <th className="p-3.5">Remarks</th>
                {!isViewer && <th className="p-3.5 text-center">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                <tr>
                  <td colSpan={isViewer ? 11 : 12} className="p-10 text-center text-slate-400">
                    <div className="flex items-center justify-center gap-2">
                      <RefreshCw size={16} className="animate-spin text-blue-600" />
                      <span>Loading GST records...</span>
                    </div>
                  </td>
                </tr>
              ) : paginatedEntries.length === 0 ? (
                <tr>
                  <td colSpan={isViewer ? 11 : 12} className="p-12 text-center text-slate-400">
                    <Receipt size={32} className="mx-auto text-slate-300 mb-2" />
                    <div className="font-bold text-slate-700 text-sm">No GST entries found</div>
                    <p className="text-xs text-slate-400 mt-1">
                      {searchTerm || filterConsigneeId || filterResult !== 'ALL'
                        ? 'Try clearing active search or filters to see all records.'
                        : isViewer
                        ? 'No GST records have been entered into the system yet.'
                        : 'Click "New GST Entry" above to record consignee-wise GST amounts.'}
                    </p>
                  </td>
                </tr>
              ) : (
                paginatedEntries.map((e) => {
                  const isGain = e.result === 'GAIN';
                  const isLoss = e.result === 'LOSS';

                  return (
                    <tr key={e.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="p-3.5 font-mono font-bold text-slate-900">{e.entryNumber}</td>
                      <td className="p-3.5 text-slate-700">{e.entryDate}</td>
                      <td className="p-3.5 font-medium text-slate-900 max-w-xs truncate" title={e.consigneeName}>
                        {e.consigneeName}
                      </td>
                      <td className="p-3.5 text-right font-mono text-slate-700">{formatCurrency(e.igst)}</td>
                      <td className="p-3.5 text-right font-mono text-slate-700">{formatCurrency(e.cgst)}</td>
                      <td className="p-3.5 text-right font-mono text-slate-700">{formatCurrency(e.sgst)}</td>
                      <td className="p-3.5 text-right font-mono font-bold text-blue-900 bg-blue-50/40">
                        {formatCurrency(e.totalGst)}
                      </td>
                      <td className="p-3.5 text-right font-mono font-bold text-purple-900 bg-purple-50/40">
                        {formatCurrency(e.refundEligible)}
                      </td>
                      <td
                        className={`p-3.5 text-right font-mono font-bold ${
                          isGain ? 'text-emerald-700 bg-emerald-50/40' : isLoss ? 'text-rose-700 bg-rose-50/40' : 'text-slate-700 bg-slate-50/50'
                        }`}
                      >
                        {formatCurrency(e.difference)}
                      </td>
                      <td className="p-3.5 text-center">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase ${
                            isGain
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                              : isLoss
                              ? 'bg-rose-100 text-rose-800 border border-rose-300'
                              : 'bg-slate-100 text-slate-700 border border-slate-300'
                          }`}
                        >
                          {isGain && <TrendingUp size={11} />}
                          {isLoss && <TrendingDown size={11} />}
                          {e.result === 'NIL' && <Minus size={11} />}
                          <span>{e.result}</span>
                        </span>
                      </td>
                      <td className="p-3.5 text-slate-500 max-w-xs truncate" title={e.remarks || ''}>
                        {e.remarks || '—'}
                      </td>
                      {!isViewer && (
                        <td className="p-3.5 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => openEditEntryModal(e)}
                              className="p-1.5 text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors cursor-pointer"
                              title="Edit GST entry"
                            >
                              <Edit2 size={13} />
                            </button>
                            <button
                              onClick={() => setDeletingEntry(e)}
                              className="p-1.5 text-rose-600 hover:text-rose-800 hover:bg-rose-50 rounded transition-colors cursor-pointer"
                              title="Delete GST entry"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination & Footer */}
        <div className="p-4 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-3">
          <div>
            Showing <span className="font-bold text-slate-800">{entries.length > 0 ? (currentPage - 1) * pageSize + 1 : 0}</span> to{' '}
            <span className="font-bold text-slate-800">{Math.min(currentPage * pageSize, entries.length)}</span> of{' '}
            <span className="font-bold text-slate-800">{entries.length}</span> total entries
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              className="px-2.5 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="px-3 py-1 font-semibold text-slate-700">
              Page {currentPage} of {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              className="px-2.5 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Modal: Create / Edit GST Entry */}
      {isFormOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-xl w-full border border-slate-200 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-5 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-bold">
                  <Receipt size={18} />
                </div>
                <div>
                  <h3 className="font-bold text-sm tracking-tight">
                    {editingEntry ? `Edit GST Entry — ${editingEntry.entryNumber}` : 'New GST Entry & Refund Calculation'}
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Calculates Difference = Refund Eligible - Total GST and determines statutory Result
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsFormOpen(false)}
                className="text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="p-6 space-y-4 text-xs">
              {formError && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg flex items-center gap-2 font-medium">
                  <AlertCircle size={15} className="shrink-0 text-rose-600" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Entry ID */}
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Entry ID</label>
                  <input
                    type="text"
                    disabled
                    value={editingEntry ? editingEntry.entryNumber : 'Auto-generated on Save (e.g. GST-26-27-XXX)'}
                    className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg font-mono text-slate-500 font-semibold"
                  />
                </div>

                {/* Entry Date */}
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    Entry Date <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={formDate}
                    onChange={(e) => setFormDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 font-medium focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Consignee */}
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Consignee (from Consignee Master) <span className="text-rose-500">*</span>
                </label>
                <select
                  required
                  value={formConsigneeId}
                  onChange={(e) => setFormConsigneeId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 font-medium focus:ring-1 focus:ring-blue-500"
                >
                  <option value="" disabled>
                    -- Select Consignee --
                  </option>
                  {consignees.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.country})
                    </option>
                  ))}
                </select>
              </div>

              {/* GST Amounts Row: IGST, CGST, SGST */}
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                <div className="text-[11px] font-bold text-slate-800 uppercase tracking-wider flex items-center justify-between">
                  <span>Goods &amp; Services Tax Components</span>
                  <span className="text-blue-700 font-mono font-bold">
                    Total GST: {formatCurrency(formCalculatedTotalGst)}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">IGST (₹)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={formIgst}
                      onChange={(e) => setFormIgst(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 font-mono font-semibold focus:ring-1 focus:ring-blue-500 bg-white"
                      placeholder="0.00"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">CGST (₹)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={formCgst}
                      onChange={(e) => setFormCgst(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 font-mono font-semibold focus:ring-1 focus:ring-blue-500 bg-white"
                      placeholder="0.00"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">SGST (₹)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={formSgst}
                      onChange={(e) => setFormSgst(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 font-mono font-semibold focus:ring-1 focus:ring-blue-500 bg-white"
                      placeholder="0.00"
                    />
                  </div>
                </div>
              </div>

              {/* Refund Eligible & Difference Calculation Card */}
              <div className="p-4 bg-purple-50/60 border border-purple-200 rounded-xl space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
                  <div>
                    <label className="block text-[11px] font-bold text-purple-950 mb-1">
                      Refund Eligible Amount (₹) <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={formRefundEligible}
                      onChange={(e) => setFormRefundEligible(e.target.value)}
                      className="w-full px-3 py-2 border border-purple-300 rounded-lg text-purple-950 font-mono font-bold bg-white focus:ring-1 focus:ring-purple-500"
                      placeholder="0.00"
                    />
                  </div>

                  <div className="space-y-1 bg-white p-3 rounded-lg border border-purple-200">
                    <div className="text-[10px] text-slate-500 font-semibold uppercase">Reconciliation Outcome</div>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold text-slate-800">
                        Diff: {formatCurrency(formCalculatedDiff)}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase ${
                          formCalculatedResult === 'GAIN'
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                            : formCalculatedResult === 'LOSS'
                            ? 'bg-rose-100 text-rose-800 border border-rose-300'
                            : 'bg-slate-100 text-slate-700 border border-slate-300'
                        }`}
                      >
                        {formCalculatedResult === 'GAIN' && <TrendingUp size={11} />}
                        {formCalculatedResult === 'LOSS' && <TrendingDown size={11} />}
                        {formCalculatedResult === 'NIL' && <Minus size={11} />}
                        <span>{formCalculatedResult}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Remarks */}
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Remarks (Optional)</label>
                <textarea
                  rows={2}
                  value={formRemarks}
                  onChange={(e) => setFormRemarks(e.target.value)}
                  placeholder="Additional notes, statutory refund application references..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-slate-900 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              {/* Actions */}
              <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsFormOpen(false)}
                  className="px-4 py-2 text-slate-600 hover:text-slate-800 font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl shadow-2xs transition-colors cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? 'Saving...' : editingEntry ? 'Update Entry' : 'Create GST Entry'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Modal: Delete Entry */}
      {deletingEntry && (
        <ConfirmationModal
          isOpen={true}
          title="Delete GST Entry"
          itemName={deletingEntry.entryNumber}
          itemType={`GST Entry (${deletingEntry.consigneeName})`}
          isArchiveOnly={false}
          isLoading={isDeleting}
          errorMessage={deleteError}
          onConfirm={handleDeleteEntry}
          onClose={() => {
            setDeletingEntry(null);
            setDeleteError(null);
          }}
        />
      )}
    </div>
  );
};
