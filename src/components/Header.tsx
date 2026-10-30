/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Search, ShieldAlert, ShieldCheck, UserCheck, Calendar, Download } from 'lucide-react';
import { User, FinancialYear, Role } from '../types/index.ts';

interface HeaderProps {
  currentUser: User;
  financialYears: FinancialYear[];
  selectedFyId: string;
  onSelectFyId: (id: string) => void;
  onSwitchRole: (role: Role) => void;
  onOpenSearch: () => void;
  onQuickExport: () => void;
  onLogout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentUser,
  financialYears,
  selectedFyId,
  onSelectFyId,
  onSwitchRole,
  onOpenSearch,
  onQuickExport,
}) => {
  const getRoleBadge = (role: Role) => {
    switch (role) {
      case 'SUPER_ADMIN':
        return {
          label: 'Super Admin / Owner',
          color: 'bg-purple-100 text-purple-800 border-purple-300',
          icon: <ShieldAlert size={14} className="text-purple-600" />,
        };
      case 'ADMIN':
        return {
          label: 'Admin (Operations)',
          color: 'bg-blue-100 text-blue-800 border-blue-300',
          icon: <ShieldCheck size={14} className="text-blue-600" />,
        };
      case 'VIEWER':
        return {
          label: 'Viewer (Read-Only)',
          color: 'bg-amber-100 text-amber-800 border-amber-300',
          icon: <UserCheck size={14} className="text-amber-600" />,
        };
    }
  };

  const badge = getRoleBadge(currentUser.role);

  return (
    <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between shadow-xs select-none">
      {/* Left: Global Search trigger */}
      <div className="flex items-center space-x-4 flex-1 max-w-lg">
        <button
          onClick={onOpenSearch}
          className="w-full flex items-center space-x-2.5 px-3.5 py-1.5 text-xs text-slate-500 bg-slate-100 hover:bg-slate-200/80 rounded-lg border border-slate-300 transition-all text-left group"
        >
          <Search size={15} className="text-slate-400 group-hover:text-slate-600" />
          <span className="flex-1 truncate">
            Search Invoice (e.g. SKE/26-27/020), SB No, IRM, or Consignee...
          </span>
          <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] bg-white border border-slate-300 rounded text-slate-500 shadow-2xs">
            Ctrl+K
          </kbd>
        </button>
      </div>

      {/* Right Controls */}
      <div className="flex items-center space-x-4">
        {/* Financial Year Selector */}
        <div className="flex items-center space-x-1.5 bg-slate-50 px-2.5 py-1 rounded-lg border border-slate-200 text-xs">
          <Calendar size={14} className="text-slate-500" />
          <span className="text-slate-500 font-medium">FY:</span>
          <select
            value={selectedFyId}
            onChange={(e) => onSelectFyId(e.target.value)}
            className="bg-transparent font-semibold text-slate-700 outline-none cursor-pointer focus:ring-0 text-xs"
          >
            <option value="ALL">All Financial Years (Show All)</option>
            {financialYears.map((fy) => (
              <option key={fy.id} value={fy.id}>
                FY {fy.label} {fy.isCurrent ? '(Current)' : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Quick Excel Export */}
        <button
          onClick={onQuickExport}
          title="Download live Export Realisation Tracker (.xlsx)"
          className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 transition-colors shadow-2xs"
        >
          <Download size={14} />
          <span className="hidden sm:inline">Export Excel</span>
        </button>

        {/* Role Switcher (For testing RBAC: Super Admin / Admin / Viewer) */}
        <div className="flex items-center space-x-2 border-l border-slate-200 pl-4">
          <div className="flex flex-col items-end">
            <span className="text-xs font-semibold text-slate-800 leading-tight">
              {currentUser.name}
            </span>
            <div className="flex items-center gap-1 mt-0.5">
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${badge.color}`}
              >
                {badge.icon}
                {badge.label}
              </span>
            </div>
          </div>

          {/* Quick RBAC Switcher Dropdown */}
          <div className="relative group">
            <select
              aria-label="Switch Role (Testing RBAC)"
              value={currentUser.role}
              onChange={(e) => onSwitchRole(e.target.value as Role)}
              className="text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded px-2 py-1 outline-none cursor-pointer"
            >
              <option value="SUPER_ADMIN">Role: Super Admin</option>
              <option value="ADMIN">Role: Admin</option>
              <option value="VIEWER">Role: Viewer (Read-Only)</option>
            </select>
          </div>
        </div>
      </div>
    </header>
  );
};
