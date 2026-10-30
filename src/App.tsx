/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Sidebar, NavItemKey } from './components/Sidebar.tsx';
import { Header } from './components/Header.tsx';
import { GlobalSearchModal } from './components/GlobalSearchModal.tsx';
import { ShipmentDetailModal } from './components/ShipmentDetailModal.tsx';
import { NewShipmentModal } from './components/NewShipmentModal.tsx';
import { EditShipmentModal } from './components/EditShipmentModal.tsx';
import { AllocatePaymentModal } from './components/AllocatePaymentModal.tsx';
import { DocumentUploadModal } from './components/DocumentUploadModal.tsx';
import { LoginModal } from './components/LoginModal.tsx';

// Views
import { DashboardView } from './views/DashboardView.tsx';
import { ShipmentListView } from './views/ShipmentListView.tsx';
import { QuickView } from './views/QuickView.tsx';
import { SummaryReportsView } from './views/SummaryReportsView.tsx';
import { InvoiceLookupView } from './views/InvoiceLookupView.tsx';
import { PaymentsView } from './views/PaymentsView.tsx';
import { BrcManagementView } from './views/BrcManagementView.tsx';
import { IncentivesView } from './views/IncentivesView.tsx';
import { ConsigneeSummaryView } from './views/ConsigneeSummaryView.tsx';
import { ConsigneeMasterView } from './views/ConsigneeMasterView.tsx';
import { BankMasterView } from './views/BankMasterView.tsx';
import { ExcelImportExportView } from './views/ExcelImportExportView.tsx';
import { DocumentReviewView } from './views/DocumentReviewView.tsx';
import { AuditHistoryView } from './views/AuditHistoryView.tsx';
import { UserManagementView } from './views/UserManagementView.tsx';
import { SettingsView } from './views/SettingsView.tsx';

import { User, FinancialYear, ConsigneeMaster, BankMaster, Shipment, Role } from './types/index.ts';
import { api } from './api/client.ts';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentTab, setCurrentTab] = useState<NavItemKey>('dashboard');
  const [financialYears, setFinancialYears] = useState<FinancialYear[]>([]);
  const [selectedFyId, setSelectedFyId] = useState<string>('fy-2026-27');
  const [consignees, setConsignees] = useState<ConsigneeMaster[]>([]);
  const [banks, setBanks] = useState<BankMaster[]>([]);

  // Modals
  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(null);
  const [editingShipment, setEditingShipment] = useState<Shipment | null>(null);
  const [allocatingShipment, setAllocatingShipment] = useState<Shipment | null>(null);
  const [uploadingShipment, setUploadingShipment] = useState<Shipment | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isNewShipmentOpen, setIsNewShipmentOpen] = useState(false);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);

  // Initial load
  const loadInitialData = async () => {
    try {
      const user = await api.getCurrentUser();
      setCurrentUser(user);

      const [fyList, cList, bList] = await Promise.all([
        api.getFinancialYears(),
        api.getConsignees(),
        api.getBanks(),
      ]);

      setFinancialYears(fyList);
      const currFy = fyList.find((f) => f.isCurrent) || fyList[0];
      if (currFy) setSelectedFyId(currFy.id);

      setConsignees(cList);
      setBanks(bList);
    } catch (e) {
      console.error('Initial load error:', e);
      setIsLoginModalOpen(true);
    }
  };

  useEffect(() => {
    loadInitialData();

    // Global keyboard shortcut: Ctrl+K / Cmd+K
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSwitchRole = async (role: Role) => {
    try {
      const res = await api.switchRole(role);
      setCurrentUser(res.user);
    } catch (e: any) {
      alert(e.message || 'Failed to switch role');
    }
  };

  const handleQuickExport = () => {
    window.open(api.getExportUrl(selectedFyId), '_blank');
  };

  const handleLogout = () => {
    api.clearToken();
    setCurrentUser(null);
    setIsLoginModalOpen(true);
  };

  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <LoginModal
          isOpen={true}
          onSuccess={(u) => {
            setCurrentUser(u);
            setIsLoginModalOpen(false);
            loadInitialData();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-100 font-sans text-slate-800 overflow-hidden">
      {/* Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        onSelectTab={(tab) => {
          if (tab === 'new-shipment') {
            setIsNewShipmentOpen(true);
          } else {
            setCurrentTab(tab);
          }
        }}
        userRole={currentUser.role}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header Bar */}
        <Header
          currentUser={currentUser}
          financialYears={financialYears}
          selectedFyId={selectedFyId}
          onSelectFyId={setSelectedFyId}
          onSwitchRole={handleSwitchRole}
          onOpenSearch={() => setIsSearchOpen(true)}
          onQuickExport={handleQuickExport}
          onLogout={handleLogout}
        />

        {/* Dynamic Page Views */}
        <main className="flex-1 overflow-y-auto p-6">
          {currentTab === 'dashboard' && (
            <DashboardView
              selectedFyId={selectedFyId}
              onNavigate={setCurrentTab}
              onSelectShipment={setSelectedShipmentId}
              userRole={currentUser.role}
            />
          )}

          {currentTab === 'shipments' && (
            <ShipmentListView
              selectedFyId={selectedFyId}
              consignees={consignees}
              onSelectShipment={setSelectedShipmentId}
              onOpenNewShipment={() => setIsNewShipmentOpen(true)}
              onOpenAllocate={setAllocatingShipment}
              onOpenEdit={setEditingShipment}
              userRole={currentUser.role}
            />
          )}

          {currentTab === 'quick-view' && <QuickView selectedFyId={selectedFyId} />}

          {currentTab === 'summary-reports' && <SummaryReportsView selectedFyId={selectedFyId} />}

          {currentTab === 'lookup' && (
            <InvoiceLookupView
              selectedFyId={selectedFyId}
              onSelectShipment={setSelectedShipmentId}
            />
          )}

          {currentTab === 'payments' && (
            <PaymentsView
              banks={banks}
              userRole={currentUser.role}
              onSelectShipment={setSelectedShipmentId}
            />
          )}

          {currentTab === 'brc' && (
            <BrcManagementView
              selectedFyId={selectedFyId}
              onSelectShipment={setSelectedShipmentId}
              onOpenUpload={setUploadingShipment}
              userRole={currentUser.role}
            />
          )}

          {currentTab === 'incentives' && (
            <IncentivesView
              selectedFyId={selectedFyId}
              userRole={currentUser.role}
              onSelectShipment={setSelectedShipmentId}
            />
          )}

          {currentTab === 'consignee-summary' && (
            <ConsigneeSummaryView
              selectedFyId={selectedFyId}
              onSelectShipment={setSelectedShipmentId}
            />
          )}

          {currentTab === 'consignee-master' && (
            <ConsigneeMasterView
              consignees={consignees}
              onRefresh={loadInitialData}
              userRole={currentUser.role}
            />
          )}

          {currentTab === 'bank-master' && (
            <BankMasterView
              banks={banks}
              onRefresh={loadInitialData}
              userRole={currentUser.role}
            />
          )}

          {currentTab === 'excel' && (
            <ExcelImportExportView
              selectedFyId={selectedFyId}
              onRefresh={loadInitialData}
              userRole={currentUser.role}
            />
          )}

          {currentTab === 'documents' && (
            <DocumentReviewView
              userRole={currentUser.role}
              onSelectShipment={setSelectedShipmentId}
            />
          )}

          {currentTab === 'audit' && <AuditHistoryView />}

          {currentTab === 'users' && <UserManagementView />}

          {currentTab === 'settings' && <SettingsView userRole={currentUser.role} />}
        </main>
      </div>

      {/* Global Modals */}
      <GlobalSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectShipment={setSelectedShipmentId}
        selectedFyId={selectedFyId}
      />

      <ShipmentDetailModal
        shipmentId={selectedShipmentId}
        onClose={() => setSelectedShipmentId(null)}
        onOpenEdit={setEditingShipment}
        onOpenAllocate={setAllocatingShipment}
        onOpenUpload={setUploadingShipment}
        onDeleted={loadInitialData}
        userRole={currentUser.role}
      />

      <NewShipmentModal
        isOpen={isNewShipmentOpen}
        onClose={() => setIsNewShipmentOpen(false)}
        onSuccess={loadInitialData}
        selectedFyId={selectedFyId}
        financialYears={financialYears}
        consignees={consignees}
        banks={banks}
      />

      <EditShipmentModal
        shipment={editingShipment}
        consignees={consignees}
        onClose={() => setEditingShipment(null)}
        onSuccess={loadInitialData}
      />

      <AllocatePaymentModal
        shipment={allocatingShipment}
        onClose={() => setAllocatingShipment(null)}
        onSuccess={loadInitialData}
      />

      <DocumentUploadModal
        shipment={uploadingShipment}
        onClose={() => setUploadingShipment(null)}
        onSuccess={loadInitialData}
      />

      <LoginModal
        isOpen={isLoginModalOpen}
        onSuccess={(u) => {
          setCurrentUser(u);
          setIsLoginModalOpen(false);
          loadInitialData();
        }}
      />
    </div>
  );
}
