/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DashboardMetrics } from '../../../shared/contracts/index.ts';
import { round2 } from '../../domain/calculations/money.ts';
import {
  buildCsvExportString,
  buildExportWorkbookBuffer,
  type ImportValidationReport,
  runHistoricalMigrationWithAdapter,
} from '../../excel.ts';
import type { IBrcRepository } from '../brc/brc.repository.ts';
import type { IGstEntriesRepository } from '../gst-entries/gstEntries.repository.ts';
import type { IMastersRepository } from '../masters/masters.repository.ts';
import type { IPaymentsRepository } from '../payments/payments.repository.ts';
import type { IShipmentsRepository } from '../shipments/shipments.repository.ts';

export class ReportsService {
  constructor(
    private readonly shipmentsRepo: IShipmentsRepository,
    private readonly mastersRepo: IMastersRepository,
    private readonly paymentsRepo: IPaymentsRepository,
    private readonly brcRepo: IBrcRepository,
    private readonly gstRepo: IGstEntriesRepository
  ) {}

  async getDashboardMetrics(financialYearId?: string): Promise<DashboardMetrics> {
    const [allShipments, gstSummary] = await Promise.all([
      this.shipmentsRepo.findAll({
        ...(financialYearId ? { financialYearId } : {}),
        includeArchived: true,
      }),
      this.gstRepo.getSummary(),
    ]);

    const activeShipments = allShipments.filter((s) => !s.isArchived);
    const archivedCount = allShipments.filter((s) => s.isArchived).length;

    let totalInvoiceValueUsd = 0;
    let totalRealisedUsd = 0;
    let totalOutstandingUsd = 0;
    let totalExcessReceivedUsd = 0;
    let unpaidCount = 0;
    let partPaidCount = 0;
    let fullyPaidCount = 0;
    let excessCount = 0;
    let pendingReviewCount = 0;
    let incentivesClaimedInr = 0;
    let incentivesReceivedInr = 0;
    let brcPendingCount = 0;
    let brcRealisedCount = 0;
    let brcOverdueCount = 0;

    for (const s of activeShipments) {
      const invUsd = Number(s.invoiceValueUsd || 0);
      const paidUsd = Number(s.totalPaidUsd || 0);
      totalInvoiceValueUsd += invUsd;
      totalRealisedUsd += paidUsd;
      totalOutstandingUsd += Math.max(0, invUsd - paidUsd);
      if (paidUsd > invUsd) {
        totalExcessReceivedUsd += paidUsd - invUsd;
      }

      if (s.paymentStatus === 'UNPAID') unpaidCount++;
      else if (s.paymentStatus === 'PART_PAID') partPaidCount++;
      else if (s.paymentStatus === 'FULLY_PAID') fullyPaidCount++;
      else if (s.paymentStatus === 'EXCESS_RECEIVED') excessCount++;

      if (s.reviewStatus === 'NEEDS_REVIEW' || s.reviewStatus === 'EXTRACTED') {
        pendingReviewCount++;
      }

      for (const inc of s.incentives || []) {
        incentivesClaimedInr += Number(inc.claimedAmount || 0);
        incentivesReceivedInr += Number(inc.receivedAmount || 0);
      }

      if (s.brcRecord) {
        if (s.brcRecord.status === 'REALISED') brcRealisedCount++;
        else if (s.brcRecord.status === 'OVERDUE') brcOverdueCount++;
        else brcPendingCount++;
      }
    }

    return {
      totalShipments: activeShipments.length,
      totalInvoiceValueUsd: round2(totalInvoiceValueUsd),
      totalRealisedUsd: round2(totalRealisedUsd),
      totalOutstandingUsd: round2(totalOutstandingUsd),
      totalExcessReceivedUsd: round2(totalExcessReceivedUsd),
      unpaidCount,
      partPaidCount,
      fullyPaidCount,
      excessCount,
      incentivesClaimedInr: round2(incentivesClaimedInr),
      incentivesReceivedInr: round2(incentivesReceivedInr),
      incentivesPendingInr: round2(Math.max(0, incentivesClaimedInr - incentivesReceivedInr)),
      brcPendingCount,
      brcRealisedCount,
      brcOverdueCount,
      pendingReviewCount,
      archivedCount,
      gstSummary,
    };
  }

  private async loadWorkbookSource(financialYearId?: string) {
    const [shipments, consignees, banks, payments, metrics, financialYears] = await Promise.all([
      this.shipmentsRepo.findAll(financialYearId ? { financialYearId } : undefined),
      this.mastersRepo.findConsignees(),
      this.mastersRepo.findBanks(),
      this.paymentsRepo.findAll(),
      this.getDashboardMetrics(financialYearId),
      this.mastersRepo.findFinancialYears(),
    ]);
    return { shipments, consignees, banks, payments, metrics, financialYears };
  }

  async exportWorkbook(financialYearId?: string): Promise<{ buffer: Buffer; filename: string }> {
    const source = await this.loadWorkbookSource(financialYearId);
    const buffer = buildExportWorkbookBuffer(source);
    const fyLabel = financialYearId
      ? source.financialYears.find((f) => f.id === financialYearId)?.label || 'All'
      : 'All';
    const filename = `SKE_Export_Realisation_Tracker_${fyLabel}_${new Date().toISOString().split('T')[0]}.xlsx`;
    return { buffer, filename };
  }

  async exportCsv(sheetName: string, financialYearId?: string): Promise<{ csv: string; filename: string }> {
    const source = await this.loadWorkbookSource(financialYearId);
    const csv = buildCsvExportString(source, sheetName);
    const safeSheet = sheetName.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filename = `SKE_${safeSheet}_${new Date().toISOString().split('T')[0]}.csv`;
    return { csv, filename };
  }

  async importHistoricalMigration(
    fileBuffer: Buffer,
    financialYearId: string | undefined,
    actorUserId: string
  ): Promise<ImportValidationReport> {
    const resolvedFyId = financialYearId || (await this.mastersRepo.findCurrentFinancialYear()).id;

    return runHistoricalMigrationWithAdapter(fileBuffer, resolvedFyId, actorUserId, {
      getBanks: () => this.mastersRepo.findBanks(),
      createBank: (data) => this.mastersRepo.createBank(data),
      getConsignees: () => this.mastersRepo.findConsignees(),
      createConsignee: (data) => this.mastersRepo.createConsignee(data),
      getShipmentByNormalizedKey: async (key, fyId) => {
        const match = await this.shipmentsRepo.findByNormalizedKey(key, fyId);
        return match || undefined;
      },
      getPayments: () => this.paymentsRepo.findAll(),
      createPayment: (data) => this.paymentsRepo.create(data),
      createShipment: (data, actor) => this.shipmentsRepo.create({ ...data, actorUserId: actor }),
      updateBrcRecord: (shipmentId, updates) => this.brcRepo.update(shipmentId, updates),
    });
  }
}
