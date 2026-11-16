/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { B2bDashboardMetrics, B2bInvoice, B2bMonthlySummary, Supplier } from '../../../shared/contracts/index.ts';
import { getMonthsForFinancialYear } from '../../gstr_period.ts';
import { sumMoney } from './money.ts';

export function calculateB2bTotalGst(input: {
  integratedTax: number;
  centralTax: number;
  stateUtTax: number;
  cess: number;
}): number {
  return sumMoney([input.integratedTax, input.centralTax, input.stateUtTax, input.cess]);
}

export function aggregateB2bMonthlySummaries(
  invoices: B2bInvoice[],
  financialYear?: string
): B2bMonthlySummary[] {
  const map = new Map<string, B2bInvoice[]>();
  for (const inv of invoices) {
    if (financialYear && financialYear !== 'ALL' && inv.financialYear !== financialYear) continue;
    const list = map.get(inv.periodKey) || [];
    list.push(inv);
    map.set(inv.periodKey, list);
  }

  const summaries: B2bMonthlySummary[] = [];
  if (financialYear && financialYear !== 'ALL') {
    const standardMonths = getMonthsForFinancialYear(financialYear);
    const seen = new Set<string>();
    for (const m of standardMonths) {
      seen.add(m.periodKey);
      const monthInvoices = map.get(m.periodKey) || [];
      summaries.push(buildMonthSummary(m.periodKey, m.displayPeriod, financialYear, monthInvoices));
    }
    for (const [key, monthInvoices] of map.entries()) {
      if (seen.has(key)) continue;
      const sample = monthInvoices[0];
      summaries.push(buildMonthSummary(key, sample?.gstrPeriod || key, financialYear, monthInvoices));
    }
  } else {
    const keys = Array.from(map.keys()).sort((a, b) => b.localeCompare(a));
    for (const key of keys) {
      const monthInvoices = map.get(key) || [];
      const sample = monthInvoices[0];
      summaries.push(buildMonthSummary(key, sample.gstrPeriod, sample.financialYear, monthInvoices));
    }
  }

  return summaries;
}

function buildMonthSummary(
  periodKey: string,
  displayPeriod: string,
  financialYear: string,
  monthInvoices: B2bInvoice[]
): B2bMonthlySummary {
  const supplierSet = new Set(monthInvoices.map((i) => i.supplierGstin));
  return {
    periodKey,
    displayPeriod,
    financialYear,
    invoiceCount: monthInvoices.length,
    uniqueSuppliers: supplierSet.size,
    totalInvoiceValue: sumMoney(monthInvoices.map((i) => i.invoiceValue)),
    totalTaxableValue: sumMoney(monthInvoices.map((i) => i.taxableValue)),
    totalIgst: sumMoney(monthInvoices.map((i) => i.integratedTax)),
    totalCgst: sumMoney(monthInvoices.map((i) => i.centralTax)),
    totalSgst: sumMoney(monthInvoices.map((i) => i.stateUtTax)),
    totalCess: sumMoney(monthInvoices.map((i) => i.cess)),
    totalGst: sumMoney(monthInvoices.map((i) => i.totalGst)),
    itcAvailableCount: monthInvoices.filter((i) => i.itcAvailability.toLowerCase() === 'yes').length,
    reverseChargeCount: monthInvoices.filter((i) => ['y', 'yes'].includes(i.reverseCharge.toLowerCase())).length,
  };
}

export function aggregateB2bDashboard(
  invoices: B2bInvoice[],
  _suppliers: Supplier[],
  financialYear?: string
): B2bDashboardMetrics {
  const filtered = financialYear && financialYear !== 'ALL'
    ? invoices.filter((i) => i.financialYear === financialYear)
    : invoices;

  const uniqueSupplierSet = new Set(filtered.map((i) => i.supplierGstin));
  const totalIgst = sumMoney(filtered.map((i) => i.integratedTax));
  const totalCgst = sumMoney(filtered.map((i) => i.centralTax));
  const totalSgst = sumMoney(filtered.map((i) => i.stateUtTax));
  const totalCess = sumMoney(filtered.map((i) => i.cess));
  const totalGst = sumMoney([totalIgst, totalCgst, totalSgst, totalCess]);

  const monthlySummaries = aggregateB2bMonthlySummaries(filtered, financialYear);
  const monthlyTrends = monthlySummaries.map((m) => ({
    periodKey: m.periodKey,
    displayPeriod: m.displayPeriod,
    invoiceCount: m.invoiceCount,
    taxableValue: m.totalTaxableValue,
    totalGst: m.totalGst,
    invoiceValue: m.totalInvoiceValue,
  }));

  const supplierAgg = new Map<string, { gstin: string; name: string; invoiceCount: number; invoiceValue: number; taxableValue: number; totalGst: number }>();
  for (const inv of filtered) {
    const curr = supplierAgg.get(inv.supplierGstin) || {
      gstin: inv.supplierGstin,
      name: inv.supplierName,
      invoiceCount: 0,
      invoiceValue: 0,
      taxableValue: 0,
      totalGst: 0,
    };
    curr.invoiceCount += 1;
    curr.invoiceValue = sumMoney([curr.invoiceValue, inv.invoiceValue]);
    curr.taxableValue = sumMoney([curr.taxableValue, inv.taxableValue]);
    curr.totalGst = sumMoney([curr.totalGst, inv.totalGst]);
    supplierAgg.set(inv.supplierGstin, curr);
  }

  const supplierSummaries = Array.from(supplierAgg.values()).sort((a, b) => b.totalGst - a.totalGst);
  const recentInvoices = [...filtered]
    .sort((a, b) => (b.invoiceDate || '').localeCompare(a.invoiceDate || ''))
    .slice(0, 10);

  return {
    totalInvoices: filtered.length,
    uniqueSuppliers: uniqueSupplierSet.size,
    totalInvoiceValue: sumMoney(filtered.map((i) => i.invoiceValue)),
    totalTaxableValue: sumMoney(filtered.map((i) => i.taxableValue)),
    totalIgst,
    totalCgst,
    totalSgst,
    totalCess,
    totalGst,
    itcAvailableCount: filtered.filter((i) => i.itcAvailability.toLowerCase() === 'yes').length,
    reverseChargeCount: filtered.filter((i) => ['y', 'yes'].includes(i.reverseCharge.toLowerCase())).length,
    monthlyTrends,
    supplierSummaries,
    topSuppliers: supplierSummaries.slice(0, 10),
    recentInvoices,
  };
}
