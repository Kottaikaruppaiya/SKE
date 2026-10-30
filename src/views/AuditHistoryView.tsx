/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { History, Shield, Filter, Search } from 'lucide-react';
import { AuditLog } from '../types/index.ts';
import { api } from '../api/client.ts';

export const AuditHistoryView: React.FC = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  useEffect(() => {
    setLoading(true);
    api.getAuditLogs(200)
      .then((data) => setLogs(data))
      .finally(() => setLoading(false));
  }, []);

  const filteredLogs = logs.filter(
    (l) =>
      l.action.toLowerCase().includes(search.toLowerCase()) ||
      l.entityType.toLowerCase().includes(search.toLowerCase()) ||
      (l.userName && l.userName.toLowerCase().includes(search.toLowerCase())) ||
      (l.entityId && l.entityId.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <History size={20} className="text-blue-600" />
            <span>Immutable Audit Trail & Regulatory Change Log</span>
          </h2>
          <p className="text-xs text-slate-500">
            Cryptographically timestamped audit records for all shipment creations, payment allocations, document modifications, and security actions
          </p>
        </div>

        <div className="w-72">
          <input
            type="text"
            placeholder="Search action, entity or user..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-2xs">
        <div className="overflow-x-auto max-h-[calc(100vh-280px)]">
          <table className="w-full min-w-[900px] text-left text-xs whitespace-nowrap">
            <thead className="bg-slate-900 text-slate-200 text-[11px] uppercase tracking-wider font-semibold sticky top-0 z-10">
              <tr>
                <th className="p-3">Timestamp</th>
                <th className="p-3">User</th>
                <th className="p-3">Action</th>
                <th className="p-3">Entity Type</th>
                <th className="p-3">Entity ID</th>
                <th className="p-3">IP Address</th>
                <th className="p-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {loading && (
                <tr>
                  <td colSpan={7} className="p-12 text-center text-slate-400 animate-pulse">
                    Querying audit log entries...
                  </td>
                </tr>
              )}

              {!loading && filteredLogs.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-12 text-center text-slate-400">
                    No matching audit logs found.
                  </td>
                </tr>
              )}

              {!loading &&
                filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-3 font-mono text-slate-600">
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="p-3 font-semibold text-slate-900">{log.userName || 'System'}</td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          log.action.includes('CREATE')
                            ? 'bg-emerald-100 text-emerald-800'
                            : log.action.includes('ALLOCATE')
                            ? 'bg-blue-100 text-blue-800'
                            : log.action.includes('DELETE') || log.action.includes('DENIED')
                            ? 'bg-red-100 text-red-800'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {log.action}
                      </span>
                    </td>
                    <td className="p-3 text-slate-700 font-semibold">{log.entityType}</td>
                    <td className="p-3 font-mono text-[11px] text-slate-500 truncate max-w-[150px]">
                      {log.entityId || '—'}
                    </td>
                    <td className="p-3 font-mono text-[11px] text-slate-500">{log.ipAddress || '127.0.0.1'}</td>
                    <td className="p-3 text-right">
                      <button
                        onClick={() => setSelectedLog(log)}
                        className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[11px] font-semibold transition-colors"
                      >
                        Inspect JSON
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* JSON Inspector Modal */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-xl rounded-xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between">
              <h3 className="font-bold text-sm">
                Audit Record Delta: {selectedLog.action} on {selectedLog.entityType}
              </h3>
              <button onClick={() => setSelectedLog(null)} className="p-1 text-slate-400 hover:text-white">
                ✕
              </button>
            </div>

            <div className="p-6 space-y-3 text-xs">
              <div>
                <span className="text-slate-500 font-semibold block mb-1">New / Current State:</span>
                <pre className="p-3 bg-slate-900 text-emerald-400 rounded-lg font-mono text-[11px] overflow-x-auto max-h-48">
                  {JSON.stringify(selectedLog.newValues || {}, null, 2)}
                </pre>
              </div>

              {selectedLog.oldValues && (
                <div>
                  <span className="text-slate-500 font-semibold block mb-1">Previous State (Before Mutation):</span>
                  <pre className="p-3 bg-slate-900 text-slate-400 rounded-lg font-mono text-[11px] overflow-x-auto max-h-48">
                    {JSON.stringify(selectedLog.oldValues, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                onClick={() => setSelectedLog(null)}
                className="px-4 py-1.5 bg-slate-800 text-white rounded-lg text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
