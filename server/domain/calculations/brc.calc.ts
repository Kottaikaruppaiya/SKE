/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrcStatus } from '../../../shared/contracts/index.ts';

export function computeStatutoryBrcDeadline(shippingBillDate: string, statutoryDays = 270): string {
  const parsed = new Date(shippingBillDate);
  const base = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const deadline = new Date(base.getTime() + statutoryDays * 24 * 60 * 60 * 1000);
  return deadline.toISOString().split('T')[0];
}

export function isBrcOverdue(
  brc: { status: BrcStatus; statutoryDeadline?: string; brcNumber?: string; issueDate?: string },
  referenceDate = new Date()
): boolean {
  if (brc.status === 'REALISED' || brc.status === 'ISSUED') return false;
  if (brc.status === 'OVERDUE') return true;
  if (!brc.statutoryDeadline) return false;
  const deadline = new Date(brc.statutoryDeadline);
  if (Number.isNaN(deadline.getTime())) return false;
  return deadline.getTime() < referenceDate.getTime();
}

export function deriveBrcStatusAfterPayment(
  currentStatus: BrcStatus,
  totalPaidUsd: number,
  invoiceValueUsd: number,
  hasBrcNumber: boolean
): BrcStatus {
  if (hasBrcNumber) return 'REALISED';
  if (totalPaidUsd >= invoiceValueUsd - 0.01 && invoiceValueUsd > 0) {
    return currentStatus === 'REALISED' ? 'REALISED' : 'ISSUED';
  }
  return currentStatus === 'OVERDUE' ? 'OVERDUE' : 'PENDING';
}
