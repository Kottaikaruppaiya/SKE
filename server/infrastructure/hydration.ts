/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BrcRecord,
  DocumentRecord,
  IncentiveRecord,
  Payment,
  PaymentAllocation,
  Shipment,
} from '../../shared/contracts/index.ts';
import { calculateIncentiveOutstanding } from '../domain/calculations/incentive.calc.ts';
import {
  computePaymentAllocationBalances,
  computeShipmentPaymentMetrics,
} from '../domain/calculations/shipment.calc.ts';

export function hydrateShipmentDto(params: {
  shipment: Shipment;
  consigneeName?: string;
  financialYearLabel?: string;
  allocations: Array<PaymentAllocation & { paymentIrm?: string; exchangeRate?: number | null }>;
  documents: DocumentRecord[];
  incentives: IncentiveRecord[];
  brcRecord?: BrcRecord;
}): Shipment {
  const metrics = computeShipmentPaymentMetrics(
    Number(params.shipment.invoiceValueUsd),
    Number(params.shipment.sbExchangeRate),
    params.allocations.map((a) => ({
      allocatedAmountUsd: Number(a.allocatedAmountUsd),
      exchangeRate: a.exchangeRate ?? null,
    }))
  );

  const currentDocs = params.documents.filter((d) => d.isCurrent);
  const hasFircDoc = currentDocs.some((d) => d.category === 'FIRC_PAYMENT');
  const hasLinkedFircPayment = params.allocations.length > 0;

  return {
    ...params.shipment,
    consigneeName: params.consigneeName || params.shipment.consigneeName || 'Unknown Buyer',
    financialYearLabel: params.financialYearLabel || params.shipment.financialYearLabel || 'Unknown FY',
    allocations: params.allocations.map(({ exchangeRate: _er, ...alloc }) => alloc),
    documents: currentDocs,
    incentives: params.incentives.map((inc) => ({
      ...inc,
      outstandingBalance: calculateIncentiveOutstanding(Number(inc.claimedAmount), Number(inc.receivedAmount)),
    })),
    brcRecord: params.brcRecord,
    totalPaidUsd: metrics.totalPaidUsd,
    balanceDueUsd: metrics.balanceDueUsd,
    realisedInr: metrics.realisedInr,
    averageRealisedRate: metrics.averageRealisedRate,
    hasFircEvidence: hasFircDoc || hasLinkedFircPayment,
    paymentStatus: metrics.paymentStatus,
  };
}

export function hydratePaymentDto(params: {
  payment: Payment;
  bankName?: string;
  allocations: Array<PaymentAllocation & { shipmentInvoiceNo?: string }>;
  documents: DocumentRecord[];
}): Payment {
  const balances = computePaymentAllocationBalances(
    Number(params.payment.verifiedAmount),
    params.allocations.map((a) => ({ allocatedAmountUsd: Number(a.allocatedAmountUsd) }))
  );

  return {
    ...params.payment,
    bankName: params.bankName || params.payment.bankName || 'Unknown Bank',
    allocations: params.allocations,
    documents: params.documents.filter((d) => d.isCurrent),
    totalAllocatedUsd: balances.totalAllocatedUsd,
    availableBalanceUsd: balances.availableBalanceUsd,
  };
}
