/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Eye,
  TrendingUp,
  DollarSign,
  Award,
  FileCheck2,
  AlertCircle,
  Download,
  Filter,
  Search,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  Layers
} from 'lucide-react';
import { DashboardMetrics, Shipment, ConsigneeMaster } from '../types/index.ts';
import { api } from '../api/client.ts';

interface QuickViewProps {
  selectedFyId: string;
  onSelectShipment?: (id: string) => void;
  refreshKey?: number;
}

export const QuickView: React.FC<QuickViewProps> = ({
  selectedFyId,
  onSelectShipment,
  refreshKey,
}) => {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [consignees, setConsignees] = useState<ConsigneeMaster[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedBuyer, setSelectedBuyer] = useState('ALL');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('ALL');
  const [brcStatusFilter, setBrcStatusFilter] = useState('ALL');
  const [incentiveStatusFilter, setIncentiveStatusFilter] = useState('ALL');

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getDashboardMetrics(selectedFyId !== 'ALL' ? selectedFyId : undefined),
      api.getShipments({ financialYearId: selectedFyId !== 'ALL' ? selectedFyId : undefined }),
      api.getConsignees(),
    ])
      .then(([m, s, c]) => {
        setMetrics(m);
        setShipments(s);
        setConsignees(c);
      })
      .catch((err) => console.error('Error fetching Quick View data:', err))
      .finally(() => setLoading(false));
  }, [selectedFyId, refreshKey]);

  // Financial aggregates for KPI cards across the active dataset
  const kpis = useMemo(() => {
    let totalBills = shipments.length;
    let paidCount = 0;
    let partPaidCount = 0;
    let pendingCount = 0;
    let totalOutstandingUsd = 0;
    let totalNetForexInr = 0;
    let totalDrawbackPendingInr = 0;
    let totalAllIncentivesPendingInr = 0;

    for (const s of shipments) {
      const totalPaid = s.totalPaidUsd || 0;
      const bal = s.balanceDueUsd ?? Math.max(0, s.invoiceValueUsd - totalPaid);
      totalOutstandingUsd += bal;

      if (s.paymentStatus === 'FULLY_PAID') paidCount++;
      else if (s.paymentStatus === 'PART_PAID') partPaidCount++;
      else pendingCount++;

      // Realised INR and Forex Gain/Loss
      const realisedRate = s.averageRealisedRate || s.sbExchangeRate || 92.1;
      const realisedInr = s.realisedInr || totalPaid * realisedRate;
      const fobInr = s.fobValueInr || 0;
      if (bal === 0 && totalPaid > 0) {
        totalNetForexInr += (realisedInr - fobInr);
      }

      // Incentives
      const dbk = s.incentives?.find((i) => i.type === 'DRAWBACK');
      const rodtep = s.incentives?.find((i) => i.type === 'RODTEP');
      const rosctl = s.incentives?.find((i) => i.type === 'ROSCTL');

      const dbkPending = Math.max(0, (dbk?.claimedAmount || 0) - (dbk?.receivedAmount || 0));
      const rodtepPending = Math.max(0, (rodtep?.claimedAmount || 0) - (rodtep?.receivedAmount || 0));
      const rosctlPending = Math.max(0, (rosctl?.claimedAmount || 0) - (rosctl?.receivedAmount || 0));

      totalDrawbackPendingInr += dbkPending;
      totalAllIncentivesPendingInr += (dbkPending + rodtepPending + rosctlPending);
    }

    return {
      totalBills,
      paidCount,
      partPaidCount,
      pendingCount,
      totalOutstandingUsd,
      totalNetForexInr,
      totalDrawbackPendingInr,
      totalAllIncentivesPendingInr,
    };
  }, [shipments]);

  // Filtered operational rows
  const filteredShipments = useMemo(() => {
    return shipments.filter((s) => {
      // Search term
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        const matchesInvoice = s.invoiceNumber.toLowerCase().includes(q);
        const matchesSb = s.shippingBillNumber.toLowerCase().includes(q);
        const matchesConsignee = (s.consigneeName || '').toLowerCase().includes(q);
        if (!matchesInvoice && !matchesSb && !matchesConsignee) return false;
      }

      // Buyer filter
      if (selectedBuyer !== 'ALL' && s.consigneeId !== selectedBuyer) {
        return false;
      }

      // Payment status
      if (paymentStatusFilter !== 'ALL') {
        if (paymentStatusFilter === 'PAID' && s.paymentStatus !== 'FULLY_PAID') return false;
        if (paymentStatusFilter === 'PART_PAID' && s.paymentStatus !== 'PART_PAID') return false;
        if (paymentStatusFilter === 'PENDING' && s.paymentStatus !== 'UNPAID') return false;
      }

      // BRC status
      if (brcStatusFilter !== 'ALL') {
        const brc = s.brcRecord;
        if (brcStatusFilter === 'REALISED' && brc?.status !== 'REALISED') return false;
        if (brcStatusFilter === 'PENDING' && brc?.status === 'REALISED') return false;
        if (brcStatusFilter === 'OVERDUE') {
          const isOverdue =
            brc?.status !== 'REALISED' &&
            brc?.statutoryDeadline &&
            new Date(brc.statutoryDeadline).getTime() < Date.now();
          if (!isOverdue) return false;
        }
      }

      // Incentive status
      if (incentiveStatusFilter !== 'ALL') {
        const dbk = s.incentives?.find((i) => i.type === 'DRAWBACK');
        const rodtep = s.incentives?.find((i) => i.type === 'RODTEP');
        const rosctl = s.incentives?.find((i) => i.type === 'ROSCTL');
        const anyPending =
          Math.max(0, (dbk?.claimedAmount || 0) - (dbk?.receivedAmount || 0)) > 0 ||
          Math.max(0, (rodtep?.claimedAmount || 0) - (rodtep?.receivedAmount || 0)) > 0 ||
          Math.max(0, (rosctl?.claimedAmount || 0) - (rosctl?.receivedAmount || 0)) > 0;

        if (incentiveStatusFilter === 'ANY_PENDING' && !anyPending) return false;
        if (incentiveStatusFilter === 'ALL_RECEIVED' && anyPending) return false;
      }

      return true;
    });
  }, [shipments, searchTerm, selectedBuyer, paymentStatusFilter, brcStatusFilter, incentiveStatusFilter]);

  if (loading && !metrics) {
    return (
      <div className="p-12 text-center text-xs text-slate-400 animate-pulse">
        Aggregating Worksheet 3: Quick View operational records...
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Top Header & Export */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Eye size={22} className="text-blue-600" />
            <span>Quick View — Executive Operational Grid</span>
          </h2>
          <p className="text-xs text-slate-500">
            Worksheet 3: 15-column high-density table &amp; top KPI monitoring, with unlimited row capacity
          </p>
        </div>

        <div className="flex items-center gap-2">
          <a
            href={api.getExportCsvUrl('Quick View', selectedFyId)}
            download={`SKE_Quick_View_${selectedFyId}_${new Date().toISOString().split('T')[0]}.csv`}
            className="h-9 px-3.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-semibold shadow-2xs inline-flex items-center gap-1.5 transition-colors"
          >
            <Download size={14} className="text-blue-600" />
            <span>Export Quick View CSV</span>
          </a>
        </div>
      </div>

      {/* Audit Note Regarding Workbook Range Discrepancy (Row 604 vs 605) */}
      <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-900 flex items-start space-x-2.5">
        <AlertCircle size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
        <div className="text-[11px] leading-relaxed">
          <span className="font-bold">Architectural Verification — Row 604 vs Row 605 Resolution:</span>{' '}
          In the historical Excel workbook, Export Tracker populated rows 5–274 with capacity through row 605, while Quick View formulas truncated at row 604. In this web application, all {shipments.length} records are indexed dynamically through PostgreSQL without manual coordinate clipping or boundary truncation.
        </div>
      </div>

      {/* TOP 8 KPI SUMMARY CARDS (Part 8.1) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
        {/* Card 1: Bills */}
        <div className="p-3 bg-white border border-slate-200 rounded-xl shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Bills</span>
          <div className="text-lg font-bold text-slate-900 font-mono mt-0.5">{kpis.totalBills}</div>
          <span className="text-[10px] text-slate-400">Total Shipping Bills</span>
        </div>

        {/* Card 2: Paid */}
        <div className="p-3 bg-white border border-slate-200 rounded-xl shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 block">Paid</span>
          <div className="text-lg font-bold text-emerald-700 font-mono mt-0.5">{kpis.paidCount}</div>
          <span className="text-[10px] text-emerald-600/80">Fully Realised</span>
        </div>

        {/* Card 3: Part Paid */}
        <div className="p-3 bg-white border border-slate-200 rounded-xl shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 block">Part Paid</span>
          <div className="text-lg font-bold text-amber-700 font-mono mt-0.5">{kpis.partPaidCount}</div>
          <span className="text-[10px] text-amber-600/80">Partial Realised</span>
        </div>

        {/* Card 4: Pending */}
        <div className="p-3 bg-white border border-slate-200 rounded-xl shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-rose-600 block">Pending</span>
          <div className="text-lg font-bold text-rose-700 font-mono mt-0.5">{kpis.pendingCount}</div>
          <span className="text-[10px] text-rose-600/80">Unrealised</span>
        </div>

        {/* Card 5: Outstanding USD */}
        <div className="p-3 bg-white border border-slate-200 rounded-xl shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Outstanding</span>
          <div className="text-sm font-bold text-slate-900 font-mono mt-1 truncate" title={`$${kpis.totalOutstandingUsd.toLocaleString()}`}>
            ${kpis.totalOutstandingUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <span className="text-[10px] text-slate-400">USD Due Balance</span>
        </div>

        {/* Card 6: Net Forex INR */}
        <div className="p-3 bg-white border border-slate-200 rounded-xl shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 block">Net Forex</span>
          <div className={`text-sm font-bold font-mono mt-1 truncate ${kpis.totalNetForexInr >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {kpis.totalNetForexInr >= 0 ? '+' : ''}₹{kpis.totalNetForexInr.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <span className="text-[10px] text-slate-400">INR Gain/Loss</span>
        </div>

        {/* Card 7: Drawback Pending */}
        <div className="p-3 bg-white border border-slate-200 rounded-xl shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-600 block">DBK Pending</span>
          <div className="text-sm font-bold text-amber-800 font-mono mt-1 truncate">
            ₹{kpis.totalDrawbackPendingInr.toLocaleString()}
          </div>
          <span className="text-[10px] text-amber-600/80">Duty Drawback Due</span>
        </div>

        {/* Card 8: All Incentives Pending */}
        <div className="p-3 bg-white border border-slate-200 rounded-xl shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-purple-600 block">All Inc. Due</span>
          <div className="text-sm font-bold text-purple-800 font-mono mt-1 truncate">
            ₹{kpis.totalAllIncentivesPendingInr.toLocaleString()}
          </div>
          <span className="text-[10px] text-purple-600/80">DBK+RoDTEP+RoSCTL</span>
        </div>
      </div>

      {/* FILTER CONTROLS BAR */}
      <div className="p-4 bg-white border border-slate-200 rounded-xl shadow-2xs space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Filter by invoice, shipping bill, buyer..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 border border-slate-300 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Consignee Buyer Dropdown */}
          <select
            value={selectedBuyer}
            onChange={(e) => setSelectedBuyer(e.target.value)}
            className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs bg-white text-slate-700 outline-none max-w-xs"
          >
            <option value="ALL">All Buyers ({consignees.length})</option>
            {consignees.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          {/* Payment Status Filter */}
          <select
            value={paymentStatusFilter}
            onChange={(e) => setPaymentStatusFilter(e.target.value)}
            className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs bg-white text-slate-700 outline-none"
          >
            <option value="ALL">All Payment Statuses</option>
            <option value="PAID">Fully Paid</option>
            <option value="PART_PAID">Part Paid</option>
            <option value="PENDING">Pending (Unpaid)</option>
          </select>

          {/* BRC Status Filter */}
          <select
            value={brcStatusFilter}
            onChange={(e) => setBrcStatusFilter(e.target.value)}
            className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs bg-white text-slate-700 outline-none"
          >
            <option value="ALL">All BRC Statuses</option>
            <option value="REALISED">BRC Realised</option>
            <option value="PENDING">BRC Pending</option>
            <option value="OVERDUE">BRC Overdue (&gt;270d)</option>
          </select>

          {/* Incentive Filter */}
          <select
            value={incentiveStatusFilter}
            onChange={(e) => setIncentiveStatusFilter(e.target.value)}
            className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs bg-white text-slate-700 outline-none"
          >
            <option value="ALL">All Incentive Statuses</option>
            <option value="ANY_PENDING">Any Incentive Pending</option>
            <option value="ALL_RECEIVED">All Incentives Credited</option>
          </select>

          {/* Reset button if filtered */}
          {(searchTerm || selectedBuyer !== 'ALL' || paymentStatusFilter !== 'ALL' || brcStatusFilter !== 'ALL' || incentiveStatusFilter !== 'ALL') && (
            <button
              onClick={() => {
                setSearchTerm('');
                setSelectedBuyer('ALL');
                setPaymentStatusFilter('ALL');
                setBrcStatusFilter('ALL');
                setIncentiveStatusFilter('ALL');
              }}
              className="text-xs text-blue-600 hover:text-blue-800 font-semibold px-2"
            >
              Reset Filters
            </button>
          )}
        </div>
      </div>

      {/* 15-COLUMN HIGH DENSITY OPERATIONAL TABLE (Part 8.1) */}
      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1500px] text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-900 text-slate-200 text-[11px] uppercase tracking-wider font-semibold sticky top-0 z-10">
              <tr>
                <th className="p-3 text-center w-12">1. S.No</th>
                <th className="p-3">2. Invoice No</th>
                <th className="p-3">3. Consignee</th>
                <th className="p-3">4. SB Date</th>
                <th className="p-3 text-right">5. Inv USD</th>
                <th className="p-3 text-right">6. Recd USD</th>
                <th className="p-3 text-right">7. Outst USD</th>
                <th className="p-3 text-center">8. Status</th>
                <th className="p-3">9. Recd On</th>
                <th className="p-3 text-right">10. Forex INR</th>
                <th className="p-3 text-right">11. DBK Claim</th>
                <th className="p-3 text-center">12. DBK Status</th>
                <th className="p-3">13. DBK Date</th>
                <th className="p-3 text-right">14. All Inc Pending</th>
                <th className="p-3 text-center">15. BRC Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredShipments.length === 0 ? (
                <tr>
                  <td colSpan={15} className="p-8 text-center text-xs text-slate-400">
                    No shipments match the selected filters.
                  </td>
                </tr>
              ) : (
                filteredShipments.map((s, idx) => {
                  const totalPaid = s.totalPaidUsd || 0;
                  const balUsd = s.balanceDueUsd ?? Math.max(0, s.invoiceValueUsd - totalPaid);

                  // Realised INR & Forex
                  const realisedRate = s.averageRealisedRate || s.sbExchangeRate || 92.1;
                  const realisedInr = s.realisedInr || totalPaid * realisedRate;
                  const fobInr = s.fobValueInr || 0;
                  const netForexInr = balUsd === 0 && totalPaid > 0 ? (realisedInr - fobInr) : 0;

                  // Incentives
                  const dbk = s.incentives?.find((i) => i.type === 'DRAWBACK');
                  const rodtep = s.incentives?.find((i) => i.type === 'RODTEP');
                  const rosctl = s.incentives?.find((i) => i.type === 'ROSCTL');

                  const dbkClaimed = dbk?.claimedAmount || 0;
                  const dbkRecd = dbk?.receivedAmount || 0;
                  const dbkPending = Math.max(0, dbkClaimed - dbkRecd);
                  const rodtepPending = Math.max(0, (rodtep?.claimedAmount || 0) - (rodtep?.receivedAmount || 0));
                  const rosctlPending = Math.max(0, (rosctl?.claimedAmount || 0) - (rosctl?.receivedAmount || 0));
                  const allIncPending = dbkPending + rodtepPending + rosctlPending;

                  // BRC
                  const brc = s.brcRecord;
                  const isBrcRealised = brc?.status === 'REALISED' || Boolean(brc?.brcNumber);
                  const isBrcOverdue =
                    !isBrcRealised &&
                    brc?.statutoryDeadline &&
                    new Date(brc.statutoryDeadline).getTime() < Date.now();

                  // Days pending calculation
                  let receivedOnText = 'Pending';
                  if (s.allocations && s.allocations.length > 0 && s.allocations[0].allocatedAt) {
                    receivedOnText = s.allocations[0].allocatedAt.split('T')[0];
                  } else if (s.paymentStatus === 'FULLY_PAID') {
                    receivedOnText = s.invoiceDate;
                  } else if (s.shippingBillDate) {
                    const daysAgo = Math.floor(
                      (Date.now() - new Date(s.shippingBillDate).getTime()) / (1000 * 60 * 60 * 24)
                    );
                    receivedOnText = `${daysAgo}d pending`;
                  }

                  return (
                    <tr
                      key={s.id}
                      onClick={() => onSelectShipment?.(s.id)}
                      className="hover:bg-blue-50/50 cursor-pointer transition-colors group"
                    >
                      {/* 1. S.No */}
                      <td className="p-3 text-center font-mono text-slate-400 text-[11px]">
                        {idx + 1}
                      </td>

                      {/* 2. Invoice No */}
                      <td className="p-3 font-mono font-bold text-slate-900 group-hover:text-blue-600">
                        {s.invoiceNumber}
                      </td>

                      {/* 3. Consignee */}
                      <td className="p-3 text-slate-800 font-medium max-w-[200px] truncate" title={s.consigneeName}>
                        {s.consigneeName || 'Unknown Buyer'}
                      </td>

                      {/* 4. SB Date */}
                      <td className="p-3 font-mono text-slate-600">
                        {s.shippingBillDate}
                      </td>

                      {/* 5. Inv USD */}
                      <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                        ${s.invoiceValueUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>

                      {/* 6. Recd USD */}
                      <td className="p-3 text-right font-mono tabular-nums font-bold text-emerald-700">
                        ${totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>

                      {/* 7. Outst USD */}
                      <td className="p-3 text-right font-mono tabular-nums font-bold text-amber-700">
                        ${balUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>

                      {/* 8. Status */}
                      <td className="p-3 text-center">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            s.paymentStatus === 'FULLY_PAID'
                              ? 'bg-emerald-100 text-emerald-800'
                              : s.paymentStatus === 'PART_PAID'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          {s.paymentStatus === 'FULLY_PAID' ? 'PAID' : s.paymentStatus === 'PART_PAID' ? 'PART PAID' : 'PENDING'}
                        </span>
                      </td>

                      {/* 9. Recd On */}
                      <td className="p-3 font-mono text-slate-600 text-[11px]">
                        {receivedOnText}
                      </td>

                      {/* 10. Forex INR */}
                      <td className={`p-3 text-right font-mono tabular-nums font-bold ${netForexInr >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {netForexInr >= 0 ? '+' : ''}₹{netForexInr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>

                      {/* 11. DBK Claim */}
                      <td className="p-3 text-right font-mono tabular-nums text-slate-700">
                        ₹{dbkClaimed.toLocaleString()}
                      </td>

                      {/* 12. DBK Status */}
                      <td className="p-3 text-center">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            dbkRecd >= dbkClaimed && dbkClaimed > 0
                              ? 'bg-emerald-100 text-emerald-800'
                              : dbkRecd > 0
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {dbkRecd >= dbkClaimed && dbkClaimed > 0 ? 'RECEIVED' : dbkRecd > 0 ? 'PARTIAL' : 'PENDING'}
                        </span>
                      </td>

                      {/* 13. DBK Date */}
                      <td className="p-3 font-mono text-slate-500 text-[11px]">
                        {dbk?.receivedDate || '—'}
                      </td>

                      {/* 14. All Inc Pending */}
                      <td className="p-3 text-right font-mono tabular-nums font-bold text-purple-700">
                        ₹{allIncPending.toLocaleString()}
                      </td>

                      {/* 15. BRC Due */}
                      <td className="p-3 text-center">
                        {isBrcRealised ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                            <CheckCircle2 size={12} />
                            <span>Realised</span>
                          </span>
                        ) : isBrcOverdue ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded">
                            <XCircle size={12} />
                            <span>Overdue</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600">
                            <Clock size={12} className="text-slate-400" />
                            <span>{brc?.statutoryDeadline || 'Due 9m'}</span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Row count footer */}
        <div className="p-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
          <span>
            Showing <strong className="text-slate-800">{filteredShipments.length}</strong> of{' '}
            <strong className="text-slate-800">{shipments.length}</strong> invoices
          </span>
          <span className="text-[11px] text-slate-400">
            Click any row to open the complete document &amp; realisation dossier
          </span>
        </div>
      </div>
    </div>
  );
};
