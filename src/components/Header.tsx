/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Search,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  Calendar,
  Download,
  LogOut,
  Menu,
} from 'lucide-react';
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
  onToggleMobileMenu?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentUser,
  financialYears,
  selectedFyId,
  onSelectFyId,
  onSwitchRole,
  onOpenSearch,
  onQuickExport,
  onLogout,
  onToggleMobileMenu,
}) => {
  const getRoleBadge = (role: Role) => {
    switch (role) {
      case 'SUPER_ADMIN':
        return {
          shortLabel: 'Owner',
          label: 'Super Admin',
          color: 'bg-purple-100 text-purple-800 border-purple-300',
          icon: <ShieldAlert size={13} className="text-purple-600" />,
        };
      case 'ADMIN':
        return {
          shortLabel: 'Admin',
          label: 'Admin (Ops)',
          color: 'bg-blue-100 text-blue-800 border-blue-300',
          icon: <ShieldCheck size={13} className="text-blue-600" />,
        };
      case 'VIEWER':
        return {
          shortLabel: 'Viewer',
          label: 'Viewer (Read)',
          color: 'bg-amber-100 text-amber-800 border-amber-300',
          icon: <UserCheck size={13} className="text-amber-600" />,
        };
    }
  };

  const badge = getRoleBadge(currentUser.role);

  return (
    <header className="h-14 sm:h-16 bg-white border-b border-slate-200 px-3 sm:px-6 flex items-center justify-between shadow-xs select-none sticky top-0 z-30">
      {/* Left Area: Mobile Menu Trigger + Global Search */}
      <div className="flex items-center space-x-2 sm:space-x-4 flex-1 max-w-lg min-w-0 mr-2">
        {/* Mobile Hamburger Drawer Trigger */}
        {onToggleMobileMenu && (
          <button
            onClick={onToggleMobileMenu}
            className="lg:hidden p-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer flex-shrink-0"
            aria-label="Toggle Navigation Menu"
          >
            <Menu size={20} />
          </button>
        )}

        {/* Mobile Search Icon Button (< md) */}
        <button
          onClick={onOpenSearch}
          className="md:hidden p-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer border border-slate-200"
          aria-label="Search Invoices and Documents"
        >
          <Search size={18} className="text-slate-500" />
        </button>

        {/* Desktop Search Bar (>= md) */}
        <button
          onClick={onOpenSearch}
          className="hidden md:flex w-full items-center space-x-2.5 px-3.5 py-1.5 text-xs text-slate-500 bg-slate-100 hover:bg-slate-200/80 rounded-lg border border-slate-300 transition-all text-left group cursor-pointer"
        >
          <Search size={15} className="text-slate-400 group-hover:text-slate-600 flex-shrink-0" />
          <span className="flex-1 truncate">
            Search Invoice (e.g. SKE/26-27/020), SB No, IRM, or Consignee...
          </span>
          <kbd className="hidden lg:inline-block px-1.5 py-0.5 text-[10px] bg-white border border-slate-300 rounded text-slate-500 shadow-2xs font-mono">
            Ctrl+K
          </kbd>
        </button>
      </div>

      {/* Right Controls Area */}
      <div className="flex items-center space-x-1.5 sm:space-x-3 flex-shrink-0">
        {/* Financial Year Selector */}
        <div className="flex items-center space-x-1 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200 text-xs">
          <Calendar size={13} className="text-slate-500 hidden sm:inline" />
          <span className="text-slate-500 font-medium hidden sm:inline">FY:</span>
          <select
            value={selectedFyId}
            onChange={(e) => onSelectFyId(e.target.value)}
            className="bg-transparent font-semibold text-slate-700 outline-none cursor-pointer text-xs pr-1"
            aria-label="Select Financial Year"
          >
            <option value="ALL">All Years</option>
            {financialYears.map((fy) => (
              <option key={fy.id} value={fy.id}>
                FY {fy.label} {fy.isCurrent ? '(Curr)' : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Quick Excel Export */}
        <button
          onClick={onQuickExport}
          title="Download live Export Realisation Tracker (.xlsx)"
          className="flex items-center space-x-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200 transition-colors shadow-2xs min-h-[36px] cursor-pointer"
        >
          <Download size={14} />
          <span className="hidden md:inline">Export Excel</span>
        </button>

        {/* User Role & Quick Switcher */}
        <div className="flex items-center space-x-1.5 border-l border-slate-200 pl-2 sm:pl-3">
          <div className="hidden sm:flex flex-col items-end">
            <span className="text-xs font-semibold text-slate-800 leading-tight truncate max-w-[120px]">
              {currentUser.name}
            </span>
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border mt-0.5 ${badge.color}`}
            >
              {badge.icon}
              <span>{badge.shortLabel}</span>
            </span>
          </div>

          {/* Quick RBAC Switcher Dropdown */}
          <div className="relative">
            <select
              aria-label="Switch Role (Testing RBAC)"
              value={currentUser.role}
              onChange={(e) => onSwitchRole(e.target.value as Role)}
              className="text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded-lg px-1.5 sm:px-2 py-1 outline-none cursor-pointer h-8"
            >
              <option value="SUPER_ADMIN">Owner</option>
              <option value="ADMIN">Admin</option>
              <option value="VIEWER">Viewer</option>
            </select>
          </div>

          {/* Logout Button */}
          <button
            onClick={onLogout}
            title="Sign out of SKE Tracker"
            className="flex items-center justify-center space-x-1 px-2 sm:px-2.5 py-1 text-xs text-rose-700 hover:text-rose-800 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors cursor-pointer min-h-[34px] min-w-[34px]"
            aria-label="Sign Out"
          >
            <LogOut size={13} />
            <span className="hidden md:inline font-semibold text-[11px]">Logout</span>
          </button>
        </div>
      </div>
    </header>
  );
};
