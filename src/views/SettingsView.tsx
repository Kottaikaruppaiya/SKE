/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Settings, Save, CheckCircle2, ShieldAlert } from 'lucide-react';
import { AppSettings, Role } from '../types/index.ts';
import { api } from '../api/client.ts';

interface SettingsViewProps {
  userRole: Role;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ userRole }) => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [statutoryBrcDays, setStatutoryBrcDays] = useState(270);
  const [defaultPortCode, setDefaultPortCode] = useState('INNSA1');
  const [companyName, setCompanyName] = useState('S K Enterprises');
  const [iecNumber, setIecNumber] = useState('0308019921');
  const [panNumber, setPanNumber] = useState('AAECS9812K');

  useEffect(() => {
    setLoading(true);
    api.getSettings()
      .then((s) => {
        setSettings(s);
        setStatutoryBrcDays(s.statutoryBrcDays);
        setDefaultPortCode(s.defaultPortCode);
        setCompanyName(s.companyName);
        setIecNumber(s.iecNumber);
        setPanNumber(s.panNumber);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.updateSettings({
        statutoryBrcDays,
        defaultPortCode,
        companyName,
        iecNumber,
        panNumber,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      alert(err.message || 'Error saving settings');
    }
  };

  const isViewer = userRole === 'VIEWER';

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h2 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Settings size={20} className="text-blue-600" />
          <span>Application Settings & Statutory Configuration</span>
        </h2>
        <p className="text-xs text-slate-500">
          Global regulatory parameters, default customs ports, and organisation identifiers
        </p>
      </div>

      <form onSubmit={handleSave} className="p-6 bg-white border border-slate-200 rounded-2xl shadow-2xs space-y-6 text-xs">
        {saved && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg flex items-center space-x-2 font-medium">
            <CheckCircle2 size={16} className="text-emerald-600" />
            <span>Settings successfully committed to system database.</span>
          </div>
        )}

        <div className="space-y-4">
          <h3 className="font-bold text-sm text-slate-900 border-b border-slate-100 pb-2">
            Statutory & Compliance Rules
          </h3>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="font-semibold text-slate-700 block mb-1">
                FEMA Statutory BRC Realisation Deadline (Days)
              </label>
              <input
                type="number"
                required
                disabled={isViewer}
                value={statutoryBrcDays}
                onChange={(e) => setStatutoryBrcDays(parseInt(e.target.value, 10) || 270)}
                className="w-full border border-slate-300 rounded-lg p-2 font-bold disabled:bg-slate-100"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                Standard RBI/FEMA timeline: 270 days (9 months) from Shipping Bill export date
              </span>
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">
                Default Customs Port of Loading Code
              </label>
              <input
                type="text"
                required
                disabled={isViewer}
                value={defaultPortCode}
                onChange={(e) => setDefaultPortCode(e.target.value.toUpperCase())}
                className="w-full border border-slate-300 rounded-lg p-2 font-mono uppercase disabled:bg-slate-100"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                Default: INNSA1 (Jawaharlal Nehru Port / Nhava Sheva)
              </span>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="font-bold text-sm text-slate-900 border-b border-slate-100 pb-2">
            Organisation Profile & Identifiers
          </h3>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="font-semibold text-slate-700 block mb-1">Registered Entity Name</label>
              <input
                type="text"
                required
                disabled={isViewer}
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2 font-semibold disabled:bg-slate-100"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">DGFT IEC Number (10 digits)</label>
              <input
                type="text"
                required
                disabled={isViewer}
                value={iecNumber}
                onChange={(e) => setIecNumber(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2 font-mono disabled:bg-slate-100"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">PAN Number</label>
              <input
                type="text"
                required
                disabled={isViewer}
                value={panNumber}
                onChange={(e) => setPanNumber(e.target.value.toUpperCase())}
                className="w-full border border-slate-300 rounded-lg p-2 font-mono uppercase disabled:bg-slate-100"
              />
            </div>
          </div>
        </div>

        {!isViewer && (
          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold shadow-sm transition-all flex items-center space-x-2"
            >
              <Save size={14} />
              <span>Save Configuration</span>
            </button>
          </div>
        )}
      </form>
    </div>
  );
};
