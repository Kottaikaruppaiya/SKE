/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { round2, subMoney } from './money.ts';

export interface ForexVarianceResult {
  claimedInr: number;
  realisedInr: number;
  varianceInr: number;
  status: 'GAIN' | 'LOSS' | 'NIL';
}

export function calculateForexVariance(input: {
  fobValueInr: number;
  realisedInr: number;
  totalPaidUsd?: number;
  sbExchangeRate?: number;
}): ForexVarianceResult {
  const realisedInr = round2(input.realisedInr || 0);
  const fobValueInr = round2(input.fobValueInr || 0);

  if (realisedInr <= 0) {
    return {
      claimedInr: fobValueInr,
      realisedInr: 0,
      varianceInr: 0,
      status: 'NIL',
    };
  }

  const varianceInr = subMoney(realisedInr, fobValueInr);
  const status = varianceInr > 0 ? 'GAIN' : varianceInr < 0 ? 'LOSS' : 'NIL';

  return {
    claimedInr: fobValueInr,
    realisedInr,
    varianceInr,
    status,
  };
}
