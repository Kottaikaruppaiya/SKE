/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Landmark, PlusCircle, Edit } from 'lucide-react';
import { BankMaster, Role } from '../types/index.ts';
import { api } from '../api/client.ts';

interface BankMasterViewProps {
  banks: BankMaster[];
  onRefresh: () => void;
  userRole: Role;
}

export const BankMasterView: React.FC<BankMasterViewProps> = ({
  banks,
  onRefresh,
  userRole,
}) => {
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [branch, setBranch] = useState('');
  const [adCode, setAdCode] = useState('');
  const [ifscCode, setIfscCode] = useState('');
  const [swiftCode, setSwiftCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isViewer = userRole === 'VIEWER';

  const openCreate = () => {
    setEditingId(null);
    setName('');
    setBranch('');
    setAdCode('');
    setIfscCode('');
    setSwiftCode('');
    setAccountNumber('');
    setError(null);
    setShowModal(true);
  };

  const openEdit = (b: BankMaster) => {
    setEditingId(b.id);
    setName(b.name);
    setBranch(b.branch || '');
    setAdCode(b.adCode || '');
    setIfscCode(b.ifscCode || '');
    setSwiftCode(b.swiftCode || '');
    setAccountNumber(b.accountNumber || '');
    setError(null);
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (editingId) {
        await api.updateBank(editingId, {
          name,
          branch,
          adCode,
          ifscCode,
          swiftCode,
          accountNumber,
        });
      } else {
        await api.createBank({
          name,
          branch,
          adCode,
          ifscCode,
          swiftCode,
          accountNumber,
          isActive: true,
        });
      }
      setShowModal(false);
      onRefresh();
    } catch (err: any) {
      setError(err.message || 'Error saving bank');
    }
  };

  const [searchTerm, setSearchTerm] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filteredBanks = banks.filter((b) => {
    const q = searchTerm.toLowerCase();
    return (
      b.name.toLowerCase().includes(q) ||
      (b.branch && b.branch.toLowerCase().includes(q)) ||
      (b.adCode && b.adCode.toLowerCase().includes(q)) ||
      (b.ifscCode && b.ifscCode.toLowerCase().includes(q)) ||
      (b.swiftCode && b.swiftCode.toLowerCase().includes(q)) ||
      (b.accountNumber && b.accountNumber.toLowerCase().includes(q))
    );
  });

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Are you sure you want to delete bank "${name}"? This action cannot be undone.`)) {
      return;
    }
    setDeletingId(id);
    try {
      await api.deleteBank(id);
      onRefresh();
    } catch (err: any) {
      alert(err.message || 'Failed to delete bank');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Landmark size={20} className="text-blue-600" />
            <span>Bank Master (Authorised Dealer AD Banks)</span>
          </h2>
          <p className="text-xs text-slate-500">
            Authorised Dealer (AD) codes, SWIFT codes, and account numbers for DGFT EDPMS and customs integration
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <input
            type="text"
            placeholder="Search banks, AD code, IFSC..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-52 sm:w-64"
          />

          {!isViewer && (
            <button
              onClick={openCreate}
              className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-all flex items-center space-x-1.5 whitespace-nowrap"
            >
              <PlusCircle size={15} />
              <span>Add Bank</span>
            </button>
          )}
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[950px] text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-900 text-slate-200 text-[11px] uppercase tracking-wider font-semibold sticky top-0 z-10">
              <tr>
                <th className="p-3">Bank Name</th>
                <th className="p-3">Branch</th>
                <th className="p-3">AD Code (DGFT)</th>
                <th className="p-3">IFSC Code</th>
                <th className="p-3">SWIFT Code</th>
                <th className="p-3">Account Number</th>
                <th className="p-3 text-center">Status</th>
                {!isViewer && <th className="p-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {filteredBanks.length === 0 ? (
                <tr>
                  <td colSpan={isViewer ? 7 : 8} className="p-10 text-center text-slate-400">
                    No banks found matching your criteria.
                  </td>
                </tr>
              ) : (
                filteredBanks.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-3 font-bold text-slate-900">{b.name}</td>
                    <td className="p-3 text-slate-700">{b.branch || '—'}</td>
                    <td className="p-3 font-mono font-bold text-blue-700">{b.adCode || '—'}</td>
                    <td className="p-3 font-mono text-slate-600">{b.ifscCode || '—'}</td>
                    <td className="p-3 font-mono text-slate-600">{b.swiftCode || '—'}</td>
                    <td className="p-3 font-mono text-slate-700">{b.accountNumber || '—'}</td>
                    <td className="p-3 text-center">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        Active
                      </span>
                    </td>
                    {!isViewer && (
                      <td className="p-3 text-right">
                        <div className="inline-flex items-center space-x-1.5">
                          <button
                            onClick={() => openEdit(b)}
                            className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[11px] font-semibold transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(b.id, b.name)}
                            disabled={deletingId === b.id}
                            className="px-2.5 py-1 bg-red-50 hover:bg-red-100 text-red-600 rounded text-[11px] font-semibold transition-colors disabled:opacity-50"
                          >
                            {deletingId === b.id ? '...' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="p-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
          <span>
            Displaying <strong className="text-slate-800">{filteredBanks.length}</strong> of{' '}
            <strong className="text-slate-800">{banks.length}</strong> authorised dealer banks
          </span>
          {searchTerm && <span className="text-slate-400 font-medium">(filtered)</span>}
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-md rounded-xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">
                {editingId ? 'Edit Bank Master' : 'Add Authorised Dealer Bank'}
              </h3>
              <button onClick={() => setShowModal(false)} className="p-1 text-slate-400 hover:text-white">
                ✕
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-4 text-xs">
              {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg">{error}</div>}

              <div>
                <label className="font-semibold text-slate-700 block mb-1">Bank Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 font-semibold"
                />
              </div>

              <div>
                <label className="font-semibold text-slate-700 block mb-1">Branch Location</label>
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">AD Code (DGFT 7-digit)</label>
                  <input
                    type="text"
                    required
                    value={adCode}
                    onChange={(e) => setAdCode(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 font-mono font-semibold"
                  />
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">SWIFT Code</label>
                  <input
                    type="text"
                    value={swiftCode}
                    onChange={(e) => setSwiftCode(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">IFSC Code</label>
                  <input
                    type="text"
                    value={ifscCode}
                    onChange={(e) => setIfscCode(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 font-mono"
                  />
                </div>
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">Account Number</label>
                  <input
                    type="text"
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 font-mono"
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg font-semibold text-slate-600 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold shadow-sm"
                >
                  Save Bank Master
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
