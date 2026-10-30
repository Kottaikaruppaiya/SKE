/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { BarChart3, Download, TrendingUp, Calendar } from 'lucide-react';
import { Shipment } from '../types/index.ts';
import { api } from '../api/client.ts';

interface SummaryReportsViewProps {
  selectedFyId: string;
  refreshKey?: number;
}

export const SummaryReportsView: React.FC<SummaryReportsViewProps> = ({ selectedFyId, refreshKey }) => {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getShipments({ financialYearId: selectedFyId })
      .then((data) => setShipments(data))
      .finally(() => setLoading(false));
  }, [selectedFyId, refreshKey]);

  // Group by Month
  const monthlyData: Record<
    string,
    {
      monthLabel: string;
      shipmentCount: number;
      invoicedUsd: number;
      realisedUsd: number;
      fobInr: number;
      realisedInr: number;
      incentivesClaimed: number;
      incentivesReceived: number;
    }
  > = {};

  for (const s of shipments) {
    const d = new Date(s.invoiceDate);
    const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const mLabel = d.toLocaleString('default', { month: 'short', year: 'numeric' });

    if (!monthlyData[mKey]) {
      monthlyData[mKey] = {
        monthLabel: mLabel,
        shipmentCount: 0,
        invoicedUsd: 0,
        realisedUsd: 0,
        fobInr: 0,
        realisedInr: 0,
        incentivesClaimed: 0,
        incentivesReceived: 0,
      };
    }

    monthlyData[mKey].shipmentCount += 1;
    monthlyData[mKey].invoicedUsd += s.invoiceValueUsd;
    monthlyData[mKey].realisedUsd += s.totalPaidUsd || 0;
    monthlyData[mKey].fobInr += s.fobValueInr;
    monthlyData[mKey].realisedInr += s.realisedInr || 0;

    if (s.incentives) {
      for (const inc of s.incentives) {
        monthlyData[mKey].incentivesClaimed += inc.claimedAmount;
        monthlyData[mKey].incentivesReceived += inc.receivedAmount;
      }
    }
  }

  const sortedMonths = Object.keys(monthlyData).sort();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <BarChart3 size={20} className="text-blue-600" />
            <span>Monthly Financial Realisation & Valuation Summary</span>
          </h2>
          <p className="text-xs text-slate-500">
            Equivalent of workbook Summary sheet: Month-by-month shipment volume, realization and FOB reconciliation
          </p>
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
        <div className="overflow-x-auto max-h-[calc(100vh-280px)]">
          <table className="w-full min-w-[1000px] text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-900 text-slate-200 text-[11px] uppercase tracking-wider font-semibold sticky top-0 z-10">
              <tr>
                <th className="p-3">Month</th>
                <th className="p-3 text-center">Shipments</th>
                <th className="p-3 text-right">Invoiced (USD)</th>
                <th className="p-3 text-right">Realised (USD)</th>
                <th className="p-3 text-right font-bold text-emerald-400">Realisation %</th>
                <th className="p-3 text-right">Customs FOB (INR)</th>
                <th className="p-3 text-right">Realised Bank (INR)</th>
                <th className="p-3 text-right">Incentives Claimed</th>
                <th className="p-3 text-right">Incentives Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {loading && (
                <tr>
                  <td colSpan={9} className="p-12 text-center text-slate-400 animate-pulse">
                    Aggregating monthly summaries...
                  </td>
                </tr>
              )}

              {!loading && sortedMonths.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-12 text-center text-slate-400">
                    No shipments recorded for this financial year yet.
                  </td>
                </tr>
              )}

              {!loading &&
                sortedMonths.map((mKey) => {
                  const item = monthlyData[mKey];
                  const pct =
                    item.invoicedUsd > 0
                      ? ((item.realisedUsd / item.invoicedUsd) * 100).toFixed(1)
                      : '0';

                  return (
                    <tr key={mKey} className="hover:bg-slate-50 transition-colors">
                      <td className="p-3 font-bold text-slate-900">{item.monthLabel}</td>
                      <td className="p-3 text-center font-semibold text-slate-700">{item.shipmentCount}</td>
                      <td className="p-3 text-right font-semibold text-slate-900">
                        ${item.invoicedUsd.toLocaleString()}
                      </td>
                      <td className="p-3 text-right font-bold text-emerald-700">
                        ${item.realisedUsd.toLocaleString()}
                      </td>
                      <td className="p-3 text-right font-bold text-emerald-800">{pct}%</td>
                      <td className="p-3 text-right text-slate-800">₹{item.fobInr.toLocaleString()}</td>
                      <td className="p-3 text-right font-semibold text-slate-800">
                        ₹{item.realisedInr.toLocaleString()}
                      </td>
                      <td className="p-3 text-right text-slate-600">
                        ₹{item.incentivesClaimed.toLocaleString()}
                      </td>
                      <td className="p-3 text-right font-semibold text-emerald-700">
                        ₹{item.incentivesReceived.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
