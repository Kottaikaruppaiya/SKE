/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Search, CheckCircle2, ArrowRight, Sparkles, AlertCircle, FileText } from 'lucide-react';
import { api } from '../api/client.ts';
import { Shipment } from '../types/index.ts';
import { normalizeInvoiceKey } from '../../server/normalizer.ts';

interface InvoiceLookupViewProps {
  selectedFyId: string;
  onSelectShipment: (id: string) => void;
  refreshKey?: number;
}

export const InvoiceLookupView: React.FC<InvoiceLookupViewProps> = ({
  selectedFyId,
  onSelectShipment,
  refreshKey,
}) => {
  const [inputVal, setInputVal] = useState('SKE/26-27/020');
  const [results, setResults] = useState<Shipment[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);

  const currentNormalized = normalizeInvoiceKey(inputVal);

  const handleSearch = async (queryToUse?: string) => {
    const q = (queryToUse || inputVal).trim();
    if (!q) return;

    setLoading(true);
    setHasSearched(true);
    try {
      const res = await api.lookupShipments(q, selectedFyId);
      setResults(res.matches);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (hasSearched) {
      handleSearch();
    }
  }, [refreshKey]);

  const testVariants = [
    { label: 'Standard Slash Format', value: 'SKE/26-27/020' },
    { label: 'Unpadded Hyphen Format', value: 'SKE-26-27-20' },
    { label: 'Proforma Invoice Space Format', value: 'SKE PI 26 27 020' },
    { label: 'Space & Number Format', value: 'SKE 26-27 20' },
    { label: 'Sequential Next Invoice (Negative Test)', value: 'SKE/26-27/021' },
    { label: 'Previous FY Invoice (Negative Test)', value: 'SKE-25-26-020' },
  ];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h2 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Search size={20} className="text-blue-600" />
          <span>Interactive Invoice Identity Normalizer & Lookup</span>
        </h2>
        <p className="text-xs text-slate-500">
          Resolves all known export invoice formatting variants into authoritative canonical keys
        </p>
      </div>

      {/* Interactive Normalizer Test Card */}
      <div className="p-6 bg-white border border-slate-200 rounded-2xl shadow-sm space-y-4">
        <label className="text-xs font-bold text-slate-700 block">
          Enter Invoice String or Shipping Bill Number:
        </label>
        <div className="flex gap-3">
          <input
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Type e.g. SKE/26-27/020 or SKE-26-27-20..."
            className="flex-1 px-4 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm font-semibold text-slate-900 outline-none focus:bg-white focus:border-blue-500 transition-all font-mono"
          />
          <button
            onClick={() => handleSearch()}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold shadow-sm transition-all flex items-center space-x-2"
          >
            <Search size={16} />
            <span>Search Database</span>
          </button>
        </div>

        {/* Real-time Normalization Bar */}
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center justify-between text-xs">
          <div className="flex items-center space-x-2">
            <Sparkles size={16} className="text-blue-600" />
            <span className="text-slate-600">Calculated Normalized Identity:</span>
            <span className="font-mono font-bold text-blue-900 bg-blue-100 px-2 py-0.5 rounded text-sm">
              {currentNormalized || 'EMPTY'}
            </span>
          </div>
          <span className="text-[11px] text-blue-700 font-medium">Used for deduplication within FY</span>
        </div>

        {/* Quick Test Variant Buttons */}
        <div className="pt-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-2">
            Test Section 6 Specification Test Cases:
          </span>
          <div className="flex flex-wrap gap-2">
            {testVariants.map((v, i) => (
              <button
                key={i}
                onClick={() => {
                  setInputVal(v.value);
                  handleSearch(v.value);
                }}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-mono border border-slate-200 transition-colors text-left"
              >
                <span className="font-semibold">{v.value}</span>
                <span className="text-[10px] text-slate-400 block font-sans">{v.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results Section */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
          Matched System Records ({results.length})
        </h3>

        {loading && (
          <div className="p-8 text-center text-xs text-slate-400 animate-pulse">
            Querying PostgreSQL indexed records...
          </div>
        )}

        {!loading && hasSearched && results.length === 0 && (
          <div className="p-8 bg-white border border-slate-200 rounded-xl text-center text-xs text-slate-400">
            No active shipment matched invoice key <strong className="text-slate-700 font-mono">{currentNormalized}</strong>.
          </div>
        )}

        {results.map((shipment) => (
          <div
            key={shipment.id}
            onClick={() => onSelectShipment(shipment.id)}
            className="p-5 bg-white border border-slate-200 hover:border-blue-300 rounded-2xl shadow-2xs hover:shadow-sm transition-all cursor-pointer flex items-center justify-between group"
          >
            <div className="space-y-2">
              <div className="flex items-center space-x-3">
                <span className="text-base font-bold text-slate-900 group-hover:text-blue-600">
                  {shipment.invoiceNumber}
                </span>
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                  Key: {shipment.normalizedInvoiceKey}
                </span>
                <span
                  className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${
                    shipment.paymentStatus === 'FULLY_PAID'
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-amber-100 text-amber-800'
                  }`}
                >
                  {shipment.paymentStatus}
                </span>
              </div>

              <div className="text-xs text-slate-500 grid grid-cols-3 gap-x-6 gap-y-1">
                <span>Buyer: <strong className="text-slate-700">{shipment.consigneeName}</strong></span>
                <span>Date: <strong className="text-slate-700">{shipment.invoiceDate}</strong></span>
                <span>Invoice USD: <strong className="text-slate-900">${shipment.invoiceValueUsd.toLocaleString()}</strong></span>
                <span>SB No: <strong className="text-slate-700">{shipment.shippingBillNumber}</strong></span>
                <span>Realised USD: <strong className="text-emerald-700">${(shipment.totalPaidUsd || 0).toLocaleString()}</strong></span>
                <span>BRC Status: <strong className="text-slate-700">{shipment.brcRecord?.status || 'PENDING'}</strong></span>
              </div>
            </div>

            <div className="flex items-center space-x-2 text-blue-600 font-semibold text-xs group-hover:translate-x-1 transition-transform">
              <span>Open Dossier</span>
              <ArrowRight size={16} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
