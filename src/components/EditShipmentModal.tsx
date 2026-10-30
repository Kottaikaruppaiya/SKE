/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, Edit2, AlertCircle } from 'lucide-react';
import { Shipment, ConsigneeMaster } from '../types/index.ts';
import { api } from '../api/client.ts';
import { normalizeInvoiceKey } from '../../server/normalizer.ts';

interface EditShipmentModalProps {
  shipment: Shipment | null;
  consignees: ConsigneeMaster[];
  onClose: () => void;
  onSuccess: () => void;
}

export const EditShipmentModal: React.FC<EditShipmentModalProps> = ({
  shipment,
  consignees,
  onClose,
  onSuccess,
}) => {
  if (!shipment) return null;

  const [invoiceNumber, setInvoiceNumber] = useState(shipment.invoiceNumber);
  const [consigneeId, setConsigneeId] = useState(shipment.consigneeId);
  const [portCode, setPortCode] = useState(shipment.portCode);
  const [packageCount, setPackageCount] = useState(shipment.packageCount || 0);
  const [invoiceValueUsd, setInvoiceValueUsd] = useState(shipment.invoiceValueUsd);
  const [shippingBillNumber, setShippingBillNumber] = useState(shipment.shippingBillNumber);
  const [shippingBillDate, setShippingBillDate] = useState(shipment.shippingBillDate);
  const [sbExchangeRate, setSbExchangeRate] = useState(shipment.sbExchangeRate);
  const [fobValueInr, setFobValueInr] = useState(shipment.fobValueInr);
  const [blNumber, setBlNumber] = useState(shipment.blNumber || '');
  const [vesselName, setVesselName] = useState(shipment.vesselName || '');
  const [reviewStatus, setReviewStatus] = useState(shipment.reviewStatus);
  const [remarks, setRemarks] = useState(shipment.remarks || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedKey = normalizeInvoiceKey(invoiceNumber);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await api.updateShipment(shipment.id, {
        invoiceNumber,
        consigneeId,
        portCode,
        packageCount,
        invoiceValueUsd,
        shippingBillNumber,
        shippingBillDate,
        sbExchangeRate,
        fobValueInr,
        blNumber: blNumber || undefined,
        vesselName: vesselName || undefined,
        reviewStatus,
        remarks,
      });

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update shipment.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-2xl rounded-xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Edit2 size={18} className="text-blue-400" />
            <h3 className="font-bold text-sm">Edit Shipment Record — {shipment.invoiceNumber}</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleUpdate} className="p-6 space-y-4 text-xs overflow-y-auto flex-1">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-lg flex items-start space-x-2">
              <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-red-600" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="font-semibold text-slate-700 block mb-1">Invoice Number</label>
              <input
                type="text"
                required
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2 font-semibold"
              />
              <span className="text-[10px] text-blue-700 font-mono mt-0.5 block">
                Normalized: {normalizedKey}
              </span>
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Consignee</label>
              <select
                value={consigneeId}
                onChange={(e) => setConsigneeId(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2 bg-white"
              >
                {consignees.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Invoice Value (USD)</label>
              <input
                type="number"
                step="0.01"
                required
                value={invoiceValueUsd}
                onChange={(e) => setInvoiceValueUsd(parseFloat(e.target.value) || 0)}
                className="w-full border border-slate-300 rounded-lg p-2 font-bold"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Customs Port Code</label>
              <input
                type="text"
                value={portCode}
                onChange={(e) => setPortCode(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2 uppercase"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Shipping Bill No.</label>
              <input
                type="text"
                value={shippingBillNumber}
                onChange={(e) => setShippingBillNumber(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2 font-semibold"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Shipping Bill Date</label>
              <input
                type="date"
                value={shippingBillDate}
                onChange={(e) => setShippingBillDate(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Customs Rate (INR)</label>
              <input
                type="number"
                step="0.0001"
                value={sbExchangeRate}
                onChange={(e) => setSbExchangeRate(parseFloat(e.target.value) || 0)}
                className="w-full border border-slate-300 rounded-lg p-2"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">FOB Value (INR)</label>
              <input
                type="number"
                step="0.01"
                value={fobValueInr}
                onChange={(e) => setFobValueInr(parseFloat(e.target.value) || 0)}
                className="w-full border border-slate-300 rounded-lg p-2"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Bill of Lading No.</label>
              <input
                type="text"
                value={blNumber}
                onChange={(e) => setBlNumber(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Vessel / Voyage</label>
              <input
                type="text"
                value={vesselName}
                onChange={(e) => setVesselName(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Review Status</label>
              <select
                value={reviewStatus}
                onChange={(e) => setReviewStatus(e.target.value as any)}
                className="w-full border border-slate-300 rounded-lg p-2 bg-white font-medium"
              >
                <option value="EXTRACTED">Extracted</option>
                <option value="NEEDS_REVIEW">Needs Review</option>
                <option value="CONFIRMED">Confirmed</option>
                <option value="MANUALLY_ENTERED">Manually Entered</option>
              </select>
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Package Count</label>
              <input
                type="number"
                value={packageCount}
                onChange={(e) => setPackageCount(parseInt(e.target.value, 10) || 0)}
                className="w-full border border-slate-300 rounded-lg p-2"
              />
            </div>
          </div>

          <div>
            <label className="font-semibold text-slate-700 block mb-1">Remarks</label>
            <textarea
              rows={2}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              className="w-full border border-slate-300 rounded-lg p-2"
            />
          </div>

          <div className="pt-2 flex justify-end space-x-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-slate-300 rounded-lg font-semibold text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold shadow-sm disabled:opacity-50"
            >
              {loading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
