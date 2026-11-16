/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Calendar,
  FileText,
  Building2,
  TrendingUp,
  Download,
  Plus,
  RefreshCw,
  ArrowRight,
  ShieldCheck,
  ChevronRight,
  Layers,
  Search,
  X,
  Filter,
  CheckCircle2,
} from 'lucide-react';
import { api } from '../../api/client.ts';
import type { B2bMonthlySummary, Role } from '../../types/index.ts';
import { B2bAddInvoiceModal } from './B2bAddInvoiceModal.tsx';

interface B2bMonthlyViewProps {
  userRole: Role;
  onOpenMonth: (periodKey: string) => void;
}

export const B2bMonthlyView: React.FC<B2bMonthlyViewProps> = ({ userRole, onOpenMonth }) => {
  const [summaries, setSummaries] = useState<B2bMonthlySummary[]>([]);
  const [selectedFy, setSelectedFy] = useState<string>('2026-27');
  const [loading, setLoading] = useState(true);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [targetAddPeriod, setTargetAddPeriod] = useState<string>('August 2026');

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedMonthFilter, setSelectedMonthFilter] = useState<string>('ALL');
  const [onlyWithInvoices, setOnlyWithInvoices] = useState<boolean>(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const isViewer = userRole === 'VIEWER';

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await api.getB2bMonthlySummaries(selectedFy);
      setSummaries(data);
    } catch (err) {
      console.error('Error loading monthly summaries:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // Reset filters when FY changes
    setSelectedMonthFilter('ALL');
  }, [selectedFy]);

  const formatInr = (val?: number) => {
    return '₹' + (Number(val || 0)).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  // Compute FY aggregates
  const totalInvoices = summaries.reduce((s, m) => s + m.invoiceCount, 0);
  const totalTaxable = summaries.reduce((s, m) => s + m.totalTaxableValue, 0);
  const totalGst = summaries.reduce((s, m) => s + m.totalGst, 0);
  const totalInvoiceVal = summaries.reduce((s, m) => s + m.totalInvoiceValue, 0);

  // Filtered summaries according to search and month selection
  const filteredSummaries = useMemo(() => {
    return summaries.filter((month) => {
      if (selectedMonthFilter !== 'ALL' && month.periodKey !== selectedMonthFilter) {
        return false;
      }
      if (onlyWithInvoices && month.invoiceCount === 0) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchDisplay = month.displayPeriod.toLowerCase().includes(q);
        const matchKey = month.periodKey.toLowerCase().includes(q);
        return matchDisplay || matchKey;
      }
      return true;
    });
  }, [summaries, selectedMonthFilter, onlyWithInvoices, searchQuery]);

  const handleAddForMonth = (displayPeriod: string) => {
    setTargetAddPeriod(displayPeriod);
    setIsAddModalOpen(true);
  };

  const handleResetFilters = () => {
    setSearchQuery('');
    setSelectedMonthFilter('ALL');
    setOnlyWithInvoices(false);
  };

  const hasActiveFilters = searchQuery.trim() !== '' || selectedMonthFilter !== 'ALL' || onlyWithInvoices;

  const handleExport = async (params: { reportType?: string; periodKey?: string; financialYear?: string }) => {
    setExportError(null);
    try {
      await api.downloadB2bExport(params);
    } catch (err: any) {
      setExportError(err.message || 'Failed to export B2B Excel.');
    }
  };

  return (
    <div className="space-y-6">
      {exportError && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-xl text-xs font-medium flex items-center justify-between">
          <span>{exportError}</span>
          <button type="button" onClick={() => setExportError(null)} className="font-bold text-red-600 hover:text-red-900">×</button>
        </div>
      )}
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white p-6 rounded-xl border border-slate-200 shadow-xs">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-blue-600 mb-1">
            <Calendar className="w-4 h-4" />
            <span>Month-by-Month GSTR Periods</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Monthly GST Entries (FY {selectedFy})</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Strictly grouped by GSTR Period (return filing month) across all 12 standard months of the Indian fiscal calendar.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* FY Selector */}
          <div className="flex items-center bg-slate-100 rounded-lg p-1 border border-slate-300">
            <span className="text-xs font-medium text-slate-600 px-2">Financial Year:</span>
            <select
              value={selectedFy}
              onChange={(e) => setSelectedFy(e.target.value)}
              className="bg-white text-xs font-semibold text-slate-800 rounded-md px-2 py-1 border-0 shadow-xs focus:ring-2 focus:ring-blue-500 focus:outline-hidden cursor-pointer"
            >
              <option value="2026-27">FY 2026-27 (Current)</option>
              <option value="2025-26">FY 2025-26</option>
              <option value="2027-28">FY 2027-28</option>
            </select>
          </div>

          <button
            onClick={loadData}
            title="Refresh"
            className="p-2 text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {!isViewer && (
            <button
              onClick={() => {
                setTargetAddPeriod('August 2026');
                setIsAddModalOpen(true);
              }}
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add B2B Invoice</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => handleExport({ reportType: 'monthly_summary', financialYear: selectedFy })}
            className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <Download className="w-3.5 h-3.5 text-emerald-600" />
            <span>Export FY Summary</span>
          </button>
        </div>
      </div>

      {/* Annual Summary Stats Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
          <div className="text-xs text-slate-500 uppercase font-semibold">Total Invoices</div>
          <div className="text-xl font-bold text-slate-900 mt-1">{totalInvoices}</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
          <div className="text-xs text-slate-500 uppercase font-semibold">Total Taxable Value</div>
          <div className="text-xl font-bold text-indigo-950 font-mono mt-1">{formatInr(totalTaxable)}</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
          <div className="text-xs text-slate-500 uppercase font-semibold">Total Input GST</div>
          <div className="text-xl font-bold text-emerald-700 font-mono mt-1">{formatInr(totalGst)}</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
          <div className="text-xs text-slate-500 uppercase font-semibold">Total Invoice Value</div>
          <div className="text-xl font-bold text-slate-900 font-mono mt-1">{formatInr(totalInvoiceVal)}</div>
        </div>
      </div>

      {/* Search & Month Selection Controls Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Search Input */}
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search month name or period (e.g. August, Jul, 2026-08)..."
              className="w-full pl-9 pr-8 py-2 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:ring-2 focus:ring-blue-500 focus:outline-hidden transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                title="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Choose Month Dropdown */}
            <div className="flex items-center gap-1.5 bg-slate-50 rounded-lg px-2.5 py-1.5 border border-slate-300 text-xs">
              <Calendar className="w-3.5 h-3.5 text-blue-600 shrink-0" />
              <span className="font-medium text-slate-600">Choose Month:</span>
              <select
                value={selectedMonthFilter}
                onChange={(e) => setSelectedMonthFilter(e.target.value)}
                className="bg-transparent font-semibold text-slate-800 border-0 focus:ring-0 focus:outline-hidden cursor-pointer"
              >
                <option value="ALL">All 12 Standard Months</option>
                {summaries.map((m) => (
                  <option key={m.periodKey} value={m.periodKey}>
                    {m.displayPeriod} {m.invoiceCount > 0 ? `(${m.invoiceCount} invoices)` : '(0)'}
                  </option>
                ))}
              </select>
            </div>

            {/* Toggle: Only with Invoices */}
            <button
              onClick={() => setOnlyWithInvoices(!onlyWithInvoices)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border flex items-center gap-1.5 transition-colors cursor-pointer ${
                onlyWithInvoices
                  ? 'bg-blue-50 text-blue-700 border-blue-300 shadow-xs'
                  : 'bg-slate-50 text-slate-600 border-slate-300 hover:bg-slate-100'
              }`}
            >
              <Filter className="w-3.5 h-3.5" />
              <span>With Invoices Only</span>
              {summaries.filter((m) => m.invoiceCount > 0).length > 0 && (
                <span className="ml-0.5 px-1.5 py-0.2 bg-blue-200 text-blue-800 rounded-full text-[10px]">
                  {summaries.filter((m) => m.invoiceCount > 0).length}
                </span>
              )}
            </button>

            {hasActiveFilters && (
              <button
                onClick={handleResetFilters}
                className="px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 rounded-lg border border-rose-200 transition-colors flex items-center gap-1 cursor-pointer"
              >
                <X className="w-3 h-3" />
                <span>Reset Filters</span>
              </button>
            )}
          </div>
        </div>

        {/* Quick Month Chips Selector */}
        <div className="pt-2 border-t border-slate-100 flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mr-1 shrink-0">
            Quick Jump:
          </span>
          <button
            onClick={() => setSelectedMonthFilter('ALL')}
            className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors shrink-0 cursor-pointer ${
              selectedMonthFilter === 'ALL'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            All (12)
          </button>
          {summaries.map((m) => {
            const isSelected = selectedMonthFilter === m.periodKey;
            const hasInvs = m.invoiceCount > 0;
            const shortName = m.displayPeriod.split(' ')[0].slice(0, 3);
            return (
              <button
                key={m.periodKey}
                onClick={() => setSelectedMonthFilter(isSelected ? 'ALL' : m.periodKey)}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors shrink-0 flex items-center gap-1.5 cursor-pointer ${
                  isSelected
                    ? 'bg-blue-600 text-white shadow-xs'
                    : hasInvs
                    ? 'bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800'
                }`}
                title={`${m.displayPeriod}: ${m.invoiceCount} invoices`}
              >
                <span>{shortName}</span>
                {hasInvs && (
                  <span
                    className={`text-[10px] px-1 py-0.2 rounded-full font-bold ${
                      isSelected ? 'bg-blue-800 text-blue-100' : 'bg-blue-200 text-blue-900'
                    }`}
                  >
                    {m.invoiceCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filter Status Counter */}
      {hasActiveFilters && (
        <div className="flex items-center justify-between text-xs text-slate-500 px-1">
          <div>
            Showing <span className="font-semibold text-slate-800">{filteredSummaries.length}</span> of {summaries.length} months
            {searchQuery && (
              <span> matching "<span className="font-medium text-slate-800">{searchQuery}</span>"</span>
            )}
            {selectedMonthFilter !== 'ALL' && (
              <span> in <span className="font-medium text-blue-700">{summaries.find(m => m.periodKey === selectedMonthFilter)?.displayPeriod}</span></span>
            )}
          </div>
          <button
            onClick={handleResetFilters}
            className="text-blue-600 hover:text-blue-800 font-semibold cursor-pointer underline"
          >
            Show all 12 months
          </button>
        </div>
      )}

      {/* Months Grid (Filtered) */}
      {filteredSummaries.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredSummaries.map((month) => {
            const hasInvoices = month.invoiceCount > 0;

            return (
              <div
                key={month.periodKey}
                className={`rounded-xl border transition-all duration-200 flex flex-col justify-between overflow-hidden ${
                  hasInvoices
                    ? 'bg-white border-blue-200 shadow-xs hover:border-blue-400 hover:shadow-md'
                    : 'bg-slate-50/60 border-slate-200 hover:bg-white hover:border-slate-300'
                }`}
              >
                {/* Card Header */}
                <div
                  onClick={() => onOpenMonth(month.periodKey)}
                  className={`p-4 border-b transition-colors cursor-pointer flex items-center justify-between ${
                    hasInvoices ? 'bg-blue-50/70 border-blue-100 hover:bg-blue-100/60' : 'bg-slate-100/60 border-slate-200'
                  }`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-slate-900">{month.displayPeriod}</h3>
                      {hasInvoices && (
                        <span className="px-2 py-0.5 bg-blue-600 text-white rounded-full text-[11px] font-semibold">
                          {month.invoiceCount} {month.invoiceCount === 1 ? 'Inv' : 'Invs'}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 font-mono mt-0.5">
                      GSTR Period: {month.periodKey}
                    </div>
                  </div>

                  <div className="p-1.5 text-blue-600 hover:bg-blue-200/50 rounded-lg">
                    <ChevronRight className="w-5 h-5" />
                  </div>
                </div>

                {/* Card Body */}
                <div
                  onClick={() => onOpenMonth(month.periodKey)}
                  className="p-5 space-y-3 cursor-pointer flex-1"
                >
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="text-slate-500 block">Unique Suppliers</span>
                      <span className="font-semibold text-slate-800 text-sm">
                        {month.uniqueSuppliers} {month.uniqueSuppliers === 1 ? 'Supplier' : 'Suppliers'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">ITC Available</span>
                      <span className="font-semibold text-emerald-700 text-sm flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        {month.itcAvailableCount} Invoices
                      </span>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-100 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Taxable Value:</span>
                      <span className="font-mono font-medium text-slate-800">
                        {formatInr(month.totalTaxableValue)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-medium">Total GST:</span>
                      <span className="font-mono font-bold text-emerald-700 text-sm">
                        {formatInr(month.totalGst)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono pt-1">
                      <span>IGST: {formatInr(month.totalIgst)}</span>
                      <span>CGST+SGST: {formatInr(month.totalCgst + month.totalSgst)}</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-600 pt-1 border-t border-slate-100">
                      <span className="text-xs">Invoice Value:</span>
                      <span className="font-mono font-semibold text-slate-900">
                        {formatInr(month.totalInvoiceValue)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Card Footer Actions */}
                <div className="p-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
                  <button
                    onClick={() => onOpenMonth(month.periodKey)}
                    className="px-3 py-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900 hover:bg-blue-100/50 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <span>Open Register</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>

                  <div className="flex items-center gap-1.5">
                    {!isViewer && (
                      <button
                        onClick={() => handleAddForMonth(month.displayPeriod)}
                        title={`Add invoice for ${month.displayPeriod}`}
                        className="p-1.5 text-slate-600 hover:text-blue-600 hover:bg-white rounded-lg border border-transparent hover:border-slate-300 transition-colors cursor-pointer"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                    {hasInvoices && (
                      <button
                        type="button"
                        onClick={() => handleExport({ periodKey: month.periodKey })}
                        title={`Export Excel for ${month.displayPeriod}`}
                        className="p-1.5 text-slate-600 hover:text-emerald-600 hover:bg-white rounded-lg border border-transparent hover:border-slate-300 transition-colors cursor-pointer"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Empty State */
        <div className="bg-white rounded-xl border border-dashed border-slate-300 p-12 text-center">
          <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <h3 className="text-base font-bold text-slate-800">No Months Match Your Filter</h3>
          <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
            {searchQuery
              ? `No months in FY ${selectedFy} match the search term "${searchQuery}".`
              : `No months match the active filter criteria.`}
          </p>
          <button
            onClick={handleResetFilters}
            className="mt-4 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors inline-flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Reset All Filters</span>
          </button>
        </div>
      )}

      {/* Add Invoice Modal prefilled with target month */}
      {isAddModalOpen && (
        <B2bAddInvoiceModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          onSuccess={loadData}
          defaultPeriodKey={targetAddPeriod}
        />
      )}
    </div>
  );
};
