/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Lock, AlertCircle, ShieldCheck, Eye, EyeOff, LogOut } from 'lucide-react';
import { api } from '../api/client.ts';
import { User } from '../types/index.ts';

interface ForcePasswordChangeModalProps {
  user: User;
  onPasswordChanged: (updatedUser: User) => void;
  onLogout: () => void;
}

export const ForcePasswordChangeModal: React.FC<ForcePasswordChangeModalProps> = ({
  user,
  onPasswordChanged,
  onLogout,
}) => {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters long.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Password confirmation does not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.changePassword('', newPassword);
      onPasswordChanged(res.user);
    } catch (err: any) {
      setError(err.message || 'Failed to update password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="force-password-title"
      className="min-h-screen w-full bg-slate-950 text-slate-100 flex items-center justify-center p-4"
    >
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-slate-800 bg-slate-950/70 space-y-2">
          <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center">
            <Lock size={20} />
          </div>
          <h1 id="force-password-title" className="text-lg font-bold text-white tracking-tight">
            Password Reset Required
          </h1>
          <p className="text-xs text-slate-400 leading-relaxed">
            For corporate security compliance, <strong className="text-slate-200">{user.name}</strong> must set a personal password before accessing export records.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          {error && (
            <div className="p-3 bg-red-950/70 border border-red-800/80 text-red-300 rounded-xl flex items-start space-x-2">
              <AlertCircle size={15} className="mt-0.5 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">
              New Corporate Password (min. 8 characters)
            </label>
            <div className="relative flex items-center">
              <input
                type={showNew ? 'text' : 'password'}
                required
                minLength={8}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter a strong password"
                className="w-full h-11 bg-slate-950 border border-slate-700 rounded-xl pl-3.5 pr-10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute right-2.5 text-slate-400 hover:text-white cursor-pointer"
                aria-label={showNew ? 'Hide password' : 'Show password'}
              >
                {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">
              Confirm New Password
            </label>
            <input
              type={showNew ? 'text' : 'password'}
              required
              minLength={8}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter your new password"
              className="w-full h-11 bg-slate-950 border border-slate-700 rounded-xl px-3.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-xl flex items-start space-x-2 text-[11px] text-slate-400">
            <ShieldCheck size={15} className="text-emerald-400 shrink-0 mt-0.5" />
            <span>Updating your password invalidates all previous session tokens across devices.</span>
          </div>

          <div className="pt-2 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onLogout}
              disabled={loading}
              className="px-4 h-10 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <LogOut size={14} />
              <span>Sign Out</span>
            </button>

            <button
              type="submit"
              disabled={loading}
              className="flex-1 h-10 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold shadow-lg shadow-blue-600/20 transition-all disabled:opacity-50 cursor-pointer"
            >
              {loading ? 'Updating Password...' : 'Set Password & Continue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
