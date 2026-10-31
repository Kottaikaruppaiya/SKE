/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  Building2,
  DollarSign,
  FileSpreadsheet,
  Download,
  Search,
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  CreditCard,
  Award,
  ArrowUpRight,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { Shipment, ConsigneeMaster, Role } from '../types/index.ts';
import { api } from '../api/client.ts';

interface CompanyLedgerViewProps {
  selectedFyId: string;
  initialCompanyName?: string;
  onSelectShipment: (id: string) => void;
  userRole: Role;
  refreshKey?: number;
}

export const CompanyLedgerView: React.FC<CompanyLedgerViewProps> = ({
  selectedFyId,
  initialCompanyName = 'S K Global Ventures Private Limited',
  onSelectShipment,
  userRole,
  refreshKey,
}) => {
  const [consignees, setConsignees] = useState<ConsigneeMaster[]>([]);
  const [selectedConsigneeId, setSelectedConsigneeId] = useState<string>('');
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [selectedFyId, refreshKey]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [cList, sList] = await Promise.all([
        api.getConsignees(),
        api.getShipments({ financialYearId: selectedFyId }),
      ]);
      setConsignees(cList);
      setShipments(sList);

      // Auto-select initial company or match name
      if (initialCompanyName) {
        const match = cList.find(
          (c) =>
            c.name.toLowerCase().includes(initialCompanyName.toLowerCase()) ||
            initialCompanyName.toLowerCase().includes(c.name.toLowerCase())
        );
        if (match) {
          setSelectedConsigneeId(match.id);
        } else if (cList.length > 0) {
          setSelectedConsigneeId(cList[0].id);
        }
      } else if (cList.length > 0) {
        setSelectedConsigneeId(cList[0].id);
      }
    } catch (err) {
      console.error('Failed to load company ledger data:', err);
    } finally {
      setLoading(false);
    }
  };

  const selectedConsignee = consignees.find((c) => c.id === selectedConsigneeId);

  // Filter shipments for this specific company
  const companyShipments = shipments.filter(
    (s) =>
      s.consigneeId === selectedConsigneeId ||
      (selectedConsignee && s.consigneeName?.toLowerCase() === selectedConsignee.name.toLowerCase())
  );

  const filtered = companyShipments.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.invoiceNumber.toLowerCase().includes(q) ||
      s.shippingBillNumber.toLowerCase().includes(q) ||
      (s.blNumber && s.blNumber.toLowerCase().includes(q)) ||
      (s.remarks && s.remarks.toLowerCase().includes(q))
    );
  });

  // Calculate metrics
  const totalBilledUsd = companyShipments.reduce((sum, s) => sum + Number(s.invoiceValueUsd || 0), 0);
  const totalRealisedUsd = companyShipments.reduce((sum, s) => sum + Number(s.totalPaidUsd || 0), 0);
  const balanceDueUsd = Math.max(0, totalBilledUsd - totalRealisedUsd);
  const totalRealisedInr = companyShipments.reduce((sum, s) => sum + Number(s.realisedInr || 0), 0);
  const averageRate = totalRealisedUsd > 0 ? totalRealisedInr / totalRealisedUsd : 0;
  const totalPkgs = companyShipments.reduce((sum, s) => sum + Number(s.packageCount || 0), 0);

  const totalDbk = companyShipments.reduce((sum, s) => {
    const inc = s.incentives?.find((i) => i.type === 'DRAWBACK');
    return sum + Number(inc?.claimedAmount || 0);
  }, 0);
  const totalRodtep = companyShipments.reduce((sum, s) => {
    const inc = s.incentives?.find((i) => i.type === 'RODTEP');
    return sum + Number(inc?.claimedAmount || 0);
  }, 0);
  const totalRosctl = companyShipments.reduce((sum, s) => {
    const inc = s.incentives?.find((i) => i.type === 'ROSCTL');
    return sum + Number(inc?.claimedAmount || 0);
  }, 0);

  const handleExportCompanyCsv = () => {
    const sheetName = selectedConsignee?.name.toLowerCase().includes('sk global')
      ? 'S K Global Ventures'
      : selectedConsignee?.name.toLowerCase().includes('shasvanth')
      ? 'Shasvanth Impex'
      : 'Export Tracker';
    window.open(api.getExportCsvUrl(sheetName, selectedFyId), '_blank');
  };

  const handleExportFullExcel = () => {
    window.open(api.getExportUrl(selectedFyId), '_blank');
  };

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2.5">
              <span className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-700 font-bold shadow-sm">
                <Building2 size={20} />
              </span>
              <div>
                <div className="flex items-center space-x-2">
                  <h2 className="text-xl font-bold text-slate-900 tracking-tight">
                    {selectedConsignee?.name || 'Company Account Ledger'}
                  </h2>
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Active Account
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Detailed export register, real-time inward remittance allocations, BRC status, and financial realisations.
                </p>
              </div>
            </div>
          </div>

          {/* Company Quick-Switch Buttons & Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Quick Switch Pills */}
            <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 text-xs">
              {consignees.map((c) => {
                const isSelected = c.id === selectedConsigneeId;
                const isSkGlobal = c.name.toLowerCase().includes('sk global') || c.name.toLowerCase().includes('s k global');
                const isShasvanth = c.name.toLowerCase().includes('shasvanth');
                const label = isSkGlobal ? 'S K Global Ventures' : isShasvanth ? 'Shasvanth Impex' : c.name.split(' ')[0];

                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedConsigneeId(c.id)}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                      isSelected
                        ? 'bg-white text-blue-700 shadow-xs font-semibold'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* Export CSV for this company */}
            <button
              onClick={handleExportCompanyCsv}
              className="px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 shadow-xs flex items-center space-x-1.5"
              title="Download CSV for this company ledger"
            >
              <Download size={14} className="text-slate-500" />
              <span>Export CSV</span>
            </button>

            {/* Export Master Excel */}
            <button
              onClick={handleExportFullExcel}
              className="px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm flex items-center space-x-1.5"
            >
              <FileSpreadsheet size={14} />
              <span>Full Workbook</span>
            </button>
          </div>
        </div>

        {/* Company Master Card Meta Info */}
        {selectedConsignee && (
          <div className="mt-5 pt-4 border-t border-slate-100 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-slate-400 block text-[11px]">Country & Port:</span>
              <span className="font-semibold text-slate-800">
                {selectedConsignee.country} • {selectedConsignee.portOfDischarge || 'Colombo Port'}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Payment Terms:</span>
              <span className="font-semibold text-slate-800">{selectedConsignee.paymentTerms || 'DA 90 Days'}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Designated Currency:</span>
              <span className="font-semibold text-slate-800">{selectedConsignee.currency || 'USD'}</span>
            </div>
            <div>
              <span className="text-slate-400 block text-[11px]">Contact & Remittance:</span>
              <span className="font-semibold text-slate-800 truncate block">
                {selectedConsignee.contactEmail || 'remittance@buyer.lk'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Financial Executive Metrics Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5 sm:gap-4">
        {/* Total Invoiced */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1.5">
            <span className="font-medium">Total Billed</span>
            <DollarSign size={16} className="text-blue-500" />
          </div>
          <div className="text-xl font-bold text-slate-900 tracking-tight">
            ${totalBilledUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {companyShipments.length} export invoice{companyShipments.length === 1 ? '' : 's'}
          </div>
        </div>

        {/* Realised Amount */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1.5">
            <span className="font-medium">Realised USD</span>
            <CheckCircle2 size={16} className="text-emerald-500" />
          </div>
          <div className="text-xl font-bold text-emerald-600 tracking-tight">
            ${totalRealisedUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[11px] text-emerald-700 font-medium mt-1">
            {totalBilledUsd > 0 ? Math.round((totalRealisedUsd / totalBilledUsd) * 100) : 0}% settled
          </div>
        </div>

        {/* Balance Due */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1.5">
            <span className="font-medium">Balance Due</span>
            <AlertTriangle size={16} className={balanceDueUsd > 0 ? 'text-amber-500' : 'text-slate-400'} />
          </div>
          <div className={`text-xl font-bold tracking-tight ${balanceDueUsd > 0 ? 'text-amber-600' : 'text-slate-800'}`}>
            ${balanceDueUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {balanceDueUsd === 0 ? 'Fully settled' : 'Pending realization'}
          </div>
        </div>

        {/* Realised INR */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1.5">
            <span className="font-medium">Realised INR</span>
            <CreditCard size={16} className="text-indigo-500" />
          </div>
          <div className="text-xl font-bold text-slate-900 tracking-tight">
            ₹{totalRealisedInr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Avg rate: ₹{averageRate > 0 ? averageRate.toFixed(2) : '93.28'} / USD
          </div>
        </div>

        {/* Incentives */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-xs col-span-2 lg:col-span-1">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1.5">
            <span className="font-medium">Total Incentives</span>
            <Award size={16} className="text-purple-500" />
          </div>
          <div className="text-xl font-bold text-purple-700 tracking-tight">
            ₹{(totalDbk + totalRodtep + totalRosctl).toLocaleString()}
          </div>
          <div className="text-[10px] text-slate-500 mt-1 flex space-x-1.5">
            <span>DBK: ₹{Math.round(totalDbk / 1000)}k</span>
            <span>•</span>
            <span>RoDTEP: ₹{Math.round(totalRodtep / 1000)}k</span>
          </div>
        </div>
      </div>

      {/* Search and Table Card */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/50">
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by invoice, SB number, BL, or remarks..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white rounded-xl border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="text-xs text-slate-500 font-medium">
            Showing {filtered.length} shipment record{filtered.length === 1 ? '' : 's'} for this company
          </div>
        </div>

        {/* Ledger Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-100/75 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-3 px-3.5">Invoice No & Date</th>
                <th className="py-3 px-3">Shipping Bill</th>
                <th className="py-3 px-3">Bill of Lading</th>
                <th className="py-3 px-3 text-right">Invoice USD</th>
                <th className="py-3 px-3">FIRC / IRM Number</th>
                <th className="py-3 px-3 text-right">Realised USD</th>
                <th className="py-3 px-3 text-right">Balance Due</th>
                <th className="py-3 px-3 text-right">Realised INR</th>
                <th className="py-3 px-3">BRC Status</th>
                <th className="py-3 px-3">Payment Status</th>
                <th className="py-3 px-3.5">Remarks</th>
                <th className="py-3 px-3 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center text-slate-400">
                    <RefreshCw size={20} className="animate-spin mx-auto mb-2 text-blue-500" />
                    Loading account ledger...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center text-slate-400">
                    <FileText size={28} className="mx-auto mb-2 text-slate-300" />
                    No shipments found for this company in {selectedFyId}.
                  </td>
                </tr>
              ) : (
                filtered.map((s) => {
                  const alloc = s.allocations?.[0];
                  const brc = s.brcRecord;

                  return (
                    <tr
                      key={s.id}
                      className="hover:bg-blue-50/40 transition-colors cursor-pointer group"
                      onClick={() => onSelectShipment(s.id)}
                    >
                      {/* Invoice No & Date */}
                      <td className="py-3 px-3.5">
                        <div className="font-bold text-slate-900 group-hover:text-blue-600 flex items-center space-x-1.5">
                          <span>{s.invoiceNumber}</span>
                          <ArrowUpRight size={13} className="opacity-0 group-hover:opacity-100 transition-opacity text-blue-500" />
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">{s.invoiceDate}</div>
                      </td>

                      {/* Shipping Bill */}
                      <td className="py-3 px-3">
                        <div className="font-semibold text-slate-800">{s.shippingBillNumber}</div>
                        <div className="text-[11px] text-slate-500">
                          {s.shippingBillDate} • {s.portCode}
                        </div>
                      </td>

                      {/* Bill of Lading */}
                      <td className="py-3 px-3">
                        <div className="font-medium text-slate-700">{s.blNumber || '—'}</div>
                        <div className="text-[11px] text-slate-400 truncate max-w-[140px]" title={s.vesselName}>
                          {s.vesselName || 'Pending vessel'}
                        </div>
                      </td>

                      {/* Invoice USD */}
                      <td className="py-3 px-3 text-right font-bold text-slate-900">
                        ${Number(s.invoiceValueUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        <div className="text-[10px] text-slate-400 font-normal">
                          {s.packageCount ? `${s.packageCount} pkgs` : ''}
                        </div>
                      </td>

                      {/* FIRC IRM */}
                      <td className="py-3 px-3">
                        {alloc?.paymentIrm ? (
                          <div>
                            <span className="font-mono text-blue-700 font-semibold">{alloc.paymentIrm}</span>
                            <div className="text-[10px] text-slate-400">
                              {alloc.allocatedAt ? alloc.allocatedAt.split('T')[0] : 'Settled'}
                            </div>
                          </div>
                        ) : (
                          <span className="text-amber-600 font-medium text-[11px] flex items-center space-x-1">
                            <Clock size={12} />
                            <span>Unallocated</span>
                          </span>
                        )}
                      </td>

                      {/* Realised USD */}
                      <td className="py-3 px-3 text-right font-semibold text-emerald-600">
                        ${Number(s.totalPaidUsd || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>

                      {/* Balance Due */}
                      <td className="py-3 px-3 text-right font-semibold">
                        {Number(s.balanceDueUsd || 0) > 0 ? (
                          <span className="text-amber-600">
                            ${Number(s.balanceDueUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        ) : (
                          <span className="text-slate-400">0.00</span>
                        )}
                      </td>

                      {/* Realised INR */}
                      <td className="py-3 px-3 text-right font-medium text-slate-800">
                        ₹{Number(s.realisedInr || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        {s.averageRealisedRate ? (
                          <div className="text-[10px] text-slate-400">@{s.averageRealisedRate.toFixed(2)}</div>
                        ) : null}
                      </td>

                      {/* BRC Status */}
                      <td className="py-3 px-3">
                        {brc?.status === 'REALISED' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                            Realised ({brc.brcNumber ? brc.brcNumber.slice(-8) : 'eBRC'})
                          </span>
                        ) : brc?.status === 'ISSUED' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                            Issued
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                            Pending
                          </span>
                        )}
                      </td>

                      {/* Payment Status */}
                      <td className="py-3 px-3">
                        {s.paymentStatus === 'FULLY_PAID' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center space-x-1 w-fit">
                            <CheckCircle2 size={10} />
                            <span>Fully Paid</span>
                          </span>
                        ) : s.paymentStatus === 'PART_PAID' ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 flex items-center space-x-1 w-fit">
                            <Clock size={10} />
                            <span>Part Paid</span>
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200 w-fit">
                            Unpaid
                          </span>
                        )}
                      </td>

                      {/* Remarks */}
                      <td className="py-3 px-3.5 max-w-[180px] truncate text-slate-500 text-[11px]" title={s.remarks}>
                        {s.remarks || '—'}
                      </td>

                      {/* Action */}
                      <td className="py-3 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => onSelectShipment(s.id)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-slate-100 transition-colors"
                          title="View Details & Documents"
                        >
                          <ExternalLink size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
