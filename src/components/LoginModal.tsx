/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Lock, ShieldAlert, ShieldCheck, UserCheck, AlertCircle } from 'lucide-react';
import { api } from '../api/client.ts';
import { User, Role } from '../types/index.ts';

interface LoginModalProps {
  isOpen: boolean;
  onSuccess: (user: User) => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onSuccess }) => {
  const [email, setEmail] = useState('owner@skenterprises.com');
  const [password, setPassword] = useState('Admin@123');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleLogin = async (emailToUse?: string, passToUse?: string) => {
    const e = emailToUse || email;
    const p = passToUse || password;
    setError(null);
    setLoading(true);

    try {
      const res = await api.login(e, p);
      onSuccess(res.user);
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const quickSwitch = (targetEmail: string) => {
    setEmail(targetEmail);
    setPassword('Admin@123');
    handleLogin(targetEmail, 'Admin@123');
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="p-6 bg-slate-950 text-white text-center space-y-2">
          <div className="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center text-white font-bold text-xl mx-auto shadow-md">
            SKE
          </div>
          <h2 className="text-base font-bold tracking-tight">S K Enterprises</h2>
          <p className="text-xs text-slate-400">Export Documents & Realisation Tracker</p>
        </div>

        <div className="p-6 space-y-4 text-xs">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-lg flex items-center space-x-2">
              <AlertCircle size={15} />
              <span>{error}</span>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleLogin();
            }}
            className="space-y-3"
          >
            <div>
              <label className="font-semibold text-slate-700 block mb-1">Corporate Email Address</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2 font-medium"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700 block mb-1">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold shadow-sm transition-all disabled:opacity-50"
            >
              {loading ? 'Authenticating...' : 'Sign In to Tracker'}
            </button>
          </form>

          {/* Quick Demo Sign In for Testing RBAC */}
          <div className="pt-3 border-t border-slate-100 space-y-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block text-center">
              Quick Role Testing Profiles (3 Required Roles):
            </span>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => quickSwitch('owner@skenterprises.com')}
                className="p-2 border border-purple-200 bg-purple-50 hover:bg-purple-100 rounded-lg text-center transition-colors group"
              >
                <ShieldAlert size={16} className="text-purple-600 mx-auto mb-1" />
                <span className="font-bold text-purple-900 block text-[11px]">Super Admin</span>
                <span className="text-[9px] text-purple-700 block">Owner Access</span>
              </button>

              <button
                type="button"
                onClick={() => quickSwitch('accountant@skenterprises.com')}
                className="p-2 border border-blue-200 bg-blue-50 hover:bg-blue-100 rounded-lg text-center transition-colors group"
              >
                <ShieldCheck size={16} className="text-blue-600 mx-auto mb-1" />
                <span className="font-bold text-blue-900 block text-[11px]">Admin</span>
                <span className="text-[9px] text-blue-700 block">Operations</span>
              </button>

              <button
                type="button"
                onClick={() => quickSwitch('auditor@skenterprises.com')}
                className="p-2 border border-amber-200 bg-amber-50 hover:bg-amber-100 rounded-lg text-center transition-colors group"
              >
                <UserCheck size={16} className="text-amber-600 mx-auto mb-1" />
                <span className="font-bold text-amber-900 block text-[11px]">Viewer</span>
                <span className="text-[9px] text-amber-700 block">Read-Only</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
