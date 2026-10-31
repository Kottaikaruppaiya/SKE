/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { FileText, Download, CheckCircle2, AlertTriangle, Eye, ShieldCheck, Trash2 } from 'lucide-react';
import { DocumentRecord, Role, ReviewStatus } from '../types/index.ts';
import { api } from '../api/client.ts';

interface DocumentReviewViewProps {
  userRole: Role;
  onSelectShipment: (id: string) => void;
  refreshKey?: number;
}

export const DocumentReviewView: React.FC<DocumentReviewViewProps> = ({
  userRole,
  onSelectShipment,
  refreshKey,
}) => {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadDocs = async () => {
    setLoading(true);
    try {
      const data = await api.request<DocumentRecord[]>('/documents');
      setDocuments(data);
      if (data.length > 0) {
        if (!selectedDoc || !data.some((d) => d.id === selectedDoc.id)) {
          setSelectedDoc(data[0]);
        }
      } else {
        setSelectedDoc(null);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDocs();
  }, [refreshKey]);

  const handleUpdateReviewStatus = async (id: string, status: ReviewStatus) => {
    try {
      const updated = await api.reviewDocument(id, status);
      setDocuments((prev) => prev.map((d) => (d.id === id ? updated : d)));
      if (selectedDoc?.id === id) setSelectedDoc(updated);
    } catch (err: any) {
      alert(err.message || 'Failed to update review status');
    }
  };

  const handleDeleteDocument = async (id: string, filename: string) => {
    const ok = window.confirm(`Are you sure you want to permanently delete document "${filename}"?`);
    if (!ok) return;

    setDeletingId(id);
    try {
      await api.deleteDocument(id);
      await loadDocs();
    } catch (err: any) {
      alert(err.message || 'Failed to delete document');
    } finally {
      setDeletingId(null);
    }
  };

  const isViewer = userRole === 'VIEWER';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <FileText size={20} className="text-blue-600" />
          <span>Document Vault & Side-by-Side Field Review</span>
        </h2>
        <p className="text-xs text-slate-500">
          Verify local PDF extraction against original source documents, review status management, and download archives
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Document List (Left 5 Cols on desktop, top stacked on mobile) */}
        <div className="col-span-1 lg:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs flex flex-col h-[320px] lg:h-[700px]">
          <div className="p-3 bg-slate-900 text-white text-xs font-bold flex items-center justify-between">
            <span>Uploaded Export Documents ({documents.length})</span>
            <span className="text-[10px] text-slate-400">Private Server Storage</span>
          </div>

          <div className="overflow-y-auto divide-y divide-slate-100 flex-1">
            {loading && (
              <div className="p-8 text-center text-xs text-slate-400 animate-pulse">
                Loading document archive...
              </div>
            )}

            {!loading && documents.length === 0 && (
              <div className="p-8 text-center text-xs text-slate-400">
                No documents uploaded yet.
              </div>
            )}

            {documents.map((doc) => {
              const isSelected = selectedDoc?.id === doc.id;
              return (
                <div
                  key={doc.id}
                  onClick={() => setSelectedDoc(doc)}
                  className={`p-3 cursor-pointer transition-colors text-xs space-y-1 ${
                    isSelected ? 'bg-blue-50/80 border-l-4 border-blue-600' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900">{doc.category.replace(/_/g, ' ')}</span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                        doc.reviewStatus === 'CONFIRMED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {doc.reviewStatus}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-600 truncate">{doc.originalFilename}</div>
                  <div className="text-[10px] text-slate-400 flex items-center justify-between">
                    <span>Uploaded by {doc.uploadedByName}</span>
                    <span>v{doc.version}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Side-by-Side Review & Extracted Metadata Pane (Right 7 Cols on desktop) */}
        <div className="col-span-1 lg:col-span-7 bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-2xs flex flex-col min-h-[500px] lg:h-[700px] overflow-y-auto space-y-4">
          {selectedDoc ? (
            <>
              {/* Document Header & Actions */}
              <div className="flex flex-col sm:flex-row sm:items-start justify-between border-b border-slate-100 pb-3 gap-3">
                <div className="min-w-0">
                  <span className="px-2 py-0.5 bg-blue-50 text-blue-700 text-[10px] font-bold rounded uppercase">
                    {selectedDoc.category.replace(/_/g, ' ')}
                  </span>
                  <h3 className="font-bold text-sm text-slate-900 mt-1 truncate">{selectedDoc.originalFilename}</h3>
                  <p className="text-[11px] font-mono text-slate-400 truncate">Path: {selectedDoc.storedPath}</p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={api.getDocumentDownloadUrl(selectedDoc.id)}
                    target="_blank"
                    rel="noreferrer"
                    className="h-8 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <Download size={13} />
                    <span>Download</span>
                  </a>

                  {selectedDoc.shipmentId && (
                    <button
                      onClick={() => onSelectShipment(selectedDoc.shipmentId!)}
                      className="h-8 px-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold inline-flex items-center justify-center transition-colors"
                    >
                      View Shipment
                    </button>
                  )}

                  {!isViewer && (
                    <button
                      onClick={() => handleDeleteDocument(selectedDoc.id, selectedDoc.originalFilename)}
                      disabled={deletingId === selectedDoc.id}
                      className="h-8 px-3 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
                      title="Permanently delete document"
                    >
                      <Trash2 size={13} />
                      <span>{deletingId === selectedDoc.id ? 'Deleting...' : 'Delete'}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Review Status Selector */}
              {!isViewer && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between text-xs gap-2">
                  <span className="font-semibold text-slate-700">Admin Review Decision:</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(['CONFIRMED', 'NEEDS_REVIEW', 'MANUALLY_ENTERED'] as ReviewStatus[]).map((st) => (
                      <button
                        key={st}
                        onClick={() => handleUpdateReviewStatus(selectedDoc.id, st)}
                        className={`h-7 px-2.5 rounded-md text-[11px] font-bold transition-colors inline-flex items-center justify-center ${
                          selectedDoc.reviewStatus === st
                            ? 'bg-blue-600 text-white shadow-2xs'
                            : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Extracted Fields Table */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                  Locally Extracted Structured Fields
                </h4>
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                      <tr>
                        <th className="p-2.5">Field</th>
                        <th className="p-2.5">Extracted Value</th>
                        <th className="p-2.5">Confidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedDoc.extractedData?.fields &&
                        Object.entries(selectedDoc.extractedData.fields).map(([k, v]: [string, any]) => (
                          <tr key={k}>
                            <td className="p-2.5 font-medium text-slate-700">{k}</td>
                            <td className="p-2.5 font-bold text-slate-900">
                              {v.value !== null ? String(v.value) : <span className="text-slate-400 font-normal">Not detected</span>}
                            </td>
                            <td className="p-2.5">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  v.confidence === 'HIGH'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : v.confidence === 'MEDIUM'
                                    ? 'bg-blue-100 text-blue-800'
                                    : 'bg-slate-100 text-slate-600'
                                }`}
                              >
                                {v.confidence}
                              </span>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Raw Snippets */}
              {selectedDoc.extractedData?.snippets && selectedDoc.extractedData.snippets.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                    Source Text Snippets
                  </h4>
                  <div className="p-3 bg-slate-950 text-slate-300 font-mono text-[11px] rounded-lg space-y-1 overflow-x-auto">
                    {selectedDoc.extractedData.snippets.map((snip: string, i: number) => (
                      <div key={i}>{snip}</div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="m-auto text-center text-xs text-slate-400">
              Select a document from the vault to inspect extracted fields.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
