/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PaymentStatus } from '../../../shared/contracts/index.ts';
import { mulMoney, round2, round4, subMoney, sumMoney } from './money.ts';

export function calculateFobValueInr(invoiceValueUsd: number, sbExchangeRate: number): number {
  return mulMoney(invoiceValueUsd, sbExchangeRate);
}

export function deriveShipmentPaymentStatus(invoiceValueUsd: number, totalPaidUsd: number): PaymentStatus {
  const paid = round2(totalPaidUsd);
  const invoiced = round2(invoiceValueUsd);
  if (paid <= 0) return 'UNPAID';
  if (paid > invoiced + 0.01) return 'EXCESS_RECEIVED';
  if (paid >= invoiced - 0.01) return 'FULLY_PAID';
  return 'PART_PAID';
}

export interface ShipmentAllocationCalculation {
  totalPaidUsd: number;
  balanceDueUsd: number;
  realisedInr: number;
  averageRealisedRate: number;
  paymentStatus: PaymentStatus;
}

export function computeShipmentPaymentMetrics(
  invoiceValueUsd: number,
  sbExchangeRate: number,
  allocations: Array<{ allocatedAmountUsd: number; exchangeRate?: number | null }>
): ShipmentAllocationCalculation {
  const totalPaidUsd = sumMoney(allocations.map((a) => a.allocatedAmountUsd));
  const balanceDueUsd = Math.max(0, subMoney(invoiceValueUsd, totalPaidUsd));

  let realisedInr = 0;
  for (const alloc of allocations) {
    const rate = alloc.exchangeRate && alloc.exchangeRate > 0 ? alloc.exchangeRate : sbExchangeRate;
    realisedInr = sumMoney([realisedInr, mulMoney(alloc.allocatedAmountUsd, rate)]);
  }

  const averageRealisedRate = totalPaidUsd > 0 ? round4(realisedInr / totalPaidUsd) : 0;
  const paymentStatus = deriveShipmentPaymentStatus(invoiceValueUsd, totalPaidUsd);

  return {
    totalPaidUsd,
    balanceDueUsd,
    realisedInr: round2(realisedInr),
    averageRealisedRate,
    paymentStatus,
  };
}

export function computePaymentAllocationBalances(
  verifiedAmount: number,
  allocations: Array<{ allocatedAmountUsd: number }>
): { totalAllocatedUsd: number; availableBalanceUsd: number } {
  const totalAllocatedUsd = sumMoney(allocations.map((a) => a.allocatedAmountUsd));
  const availableBalanceUsd = Math.max(0, subMoney(verifiedAmount, totalAllocatedUsd));
  return { totalAllocatedUsd, availableBalanceUsd };
}
