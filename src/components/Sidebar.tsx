/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  LayoutDashboard,
  FileSpreadsheet,
  PlusCircle,
  Search,
  CreditCard,
  Award,
  FileCheck2,
  FileText,
  Building2,
  Landmark,
  FileDown,
  History,
  Users,
  Settings,
  Eye,
  BarChart3,
  UsersRound,
} from 'lucide-react';
import { Role } from '../types/index.ts';

export type NavItemKey =
  | 'dashboard'
  | 'quick-view'
  | 'summary-reports'
  | 'shipments'
  | 'new-shipment'
  | 'lookup'
  | 'payments'
  | 'brc'
  | 'incentives'
  | 'documents'
  | 'consignee-summary'
  | 'consignee-master'
  | 'bank-master'
  | 'excel'
  | 'audit'
  | 'users'
  | 'settings';

interface SidebarProps {
  currentTab: NavItemKey;
  onSelectTab: (tab: NavItemKey) => void;
  userRole: Role;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentTab, onSelectTab, userRole }) => {
  const isSuperAdmin = userRole === 'SUPER_ADMIN';
  const isViewer = userRole === 'VIEWER';

  return (
    <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col flex-shrink-0 border-r border-slate-800 select-none">
      {/* Brand Header */}
      <div className="p-4 border-b border-slate-800 flex items-center space-x-3 bg-slate-950">
        <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-lg shadow-md">
          SKE
        </div>
        <div>
          <h1 className="text-sm font-semibold text-white tracking-tight leading-tight">
            S K Enterprises
          </h1>
          <p className="text-[11px] text-slate-400 font-medium">Export & Realisation</p>
        </div>
      </div>

      {/* Navigation Sections */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6 text-xs">
        {/* Overview */}
        <div>
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Overview & Analytics
          </div>
          <div className="space-y-1">
            <NavItem
              icon={<LayoutDashboard size={16} />}
              label="Dashboard"
              active={currentTab === 'dashboard'}
              onClick={() => onSelectTab('dashboard')}
            />
            <NavItem
              icon={<Eye size={16} />}
              label="Quick View"
              active={currentTab === 'quick-view'}
              onClick={() => onSelectTab('quick-view')}
            />
            <NavItem
              icon={<BarChart3 size={16} />}
              label="Summary Reports"
              active={currentTab === 'summary-reports'}
              onClick={() => onSelectTab('summary-reports')}
            />
          </div>
        </div>

        {/* Shipments & Realisation */}
        <div>
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Export Operations
          </div>
          <div className="space-y-1">
            <NavItem
              icon={<FileSpreadsheet size={16} />}
              label="Export Shipments"
              active={currentTab === 'shipments'}
              onClick={() => onSelectTab('shipments')}
            />
            {!isViewer && (
              <NavItem
                icon={<PlusCircle size={16} className="text-emerald-400" />}
                label="New Shipment"
                active={currentTab === 'new-shipment'}
                onClick={() => onSelectTab('new-shipment')}
              />
            )}
            <NavItem
              icon={<Search size={16} />}
              label="Invoice Lookup"
              active={currentTab === 'lookup'}
              onClick={() => onSelectTab('lookup')}
            />
            <NavItem
              icon={<CreditCard size={16} />}
              label="Payments & Allocations"
              active={currentTab === 'payments'}
              onClick={() => onSelectTab('payments')}
            />
            <NavItem
              icon={<FileCheck2 size={16} />}
              label="BRC / eBRC Tracking"
              active={currentTab === 'brc'}
              onClick={() => onSelectTab('brc')}
            />
            <NavItem
              icon={<Award size={16} />}
              label="Incentives (DBK/RoDTEP)"
              active={currentTab === 'incentives'}
              onClick={() => onSelectTab('incentives')}
            />
            <NavItem
              icon={<FileText size={16} />}
              label="Document Review & Vault"
              active={currentTab === 'documents'}
              onClick={() => onSelectTab('documents')}
            />
          </div>
        </div>

        {/* Masters & Data */}
        <div>
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Masters & Reports
          </div>
          <div className="space-y-1">
            <NavItem
              icon={<UsersRound size={16} />}
              label="Consignee Summary"
              active={currentTab === 'consignee-summary'}
              onClick={() => onSelectTab('consignee-summary')}
            />
            <NavItem
              icon={<Building2 size={16} />}
              label="Consignee Master"
              active={currentTab === 'consignee-master'}
              onClick={() => onSelectTab('consignee-master')}
            />
            <NavItem
              icon={<Landmark size={16} />}
              label="Bank Master"
              active={currentTab === 'bank-master'}
              onClick={() => onSelectTab('bank-master')}
            />
            <NavItem
              icon={<FileDown size={16} />}
              label="Excel Import & Export"
              active={currentTab === 'excel'}
              onClick={() => onSelectTab('excel')}
            />
          </div>
        </div>

        {/* Administration */}
        <div>
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Security & Controls
          </div>
          <div className="space-y-1">
            <NavItem
              icon={<History size={16} />}
              label="Audit History"
              active={currentTab === 'audit'}
              onClick={() => onSelectTab('audit')}
            />
            {isSuperAdmin && (
              <NavItem
                icon={<Users size={16} className="text-indigo-400" />}
                label="User Management"
                active={currentTab === 'users'}
                onClick={() => onSelectTab('users')}
              />
            )}
            <NavItem
              icon={<Settings size={16} />}
              label="Application Settings"
              active={currentTab === 'settings'}
              onClick={() => onSelectTab('settings')}
            />
          </div>
        </div>
      </div>

      {/* Role Footer Badge */}
      <div className="p-3 border-t border-slate-800 bg-slate-950 text-[11px] flex items-center justify-between">
        <span className="text-slate-400 font-medium">System Status</span>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          PostgreSQL Ready
        </span>
      </div>
    </aside>
  );
};

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ icon, label, active, onClick }) => {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center space-x-2.5 px-3 py-2 rounded-md font-medium text-left transition-colors ${
        active
          ? 'bg-blue-600 text-white shadow-sm'
          : 'text-slate-300 hover:bg-slate-800 hover:text-white'
      }`}
    >
      <span className={active ? 'text-white' : 'text-slate-400'}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
};
