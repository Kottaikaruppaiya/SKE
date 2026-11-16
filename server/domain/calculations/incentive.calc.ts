/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncentiveStatus } from '../../../shared/contracts/index.ts';
import { round2, subMoney } from './money.ts';

export function deriveIncentiveStatus(claimedAmount: number, receivedAmount: number): IncentiveStatus {
  const claimed = round2(claimedAmount);
  const received = round2(receivedAmount);
  if (received >= claimed && claimed > 0) return 'RECEIVED';
  if (received > 0) return 'PART_RECEIVED';
  return 'PENDING';
}

export function calculateIncentiveOutstanding(claimedAmount: number, receivedAmount: number): number {
  return Math.max(0, subMoney(claimedAmount, receivedAmount));
}
