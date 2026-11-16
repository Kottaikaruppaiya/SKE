/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GstEntry, GstResult, GstSummary } from '../../../shared/contracts/index.ts';
import { ValidationError } from '../errors/AppError.ts';
import { round2, subMoney, sumMoney } from './money.ts';

export interface GstEntryCalculation {
  igst: number;
  cgst: number;
  sgst: number;
  totalGst: number;
  refundEligible: number;
  difference: number;
  result: GstResult;
}

export function calculateGstEntryTotals(input: {
  igst: number;
  cgst: number;
  sgst: number;
  refundEligible: number;
}): GstEntryCalculation {
  const igst = round2(input.igst);
  const cgst = round2(input.cgst);
  const sgst = round2(input.sgst);
  const refundEligible = round2(input.refundEligible);

  if (igst < 0 || cgst < 0 || sgst < 0 || refundEligible < 0) {
    throw new ValidationError('GST tax components (IGST, CGST, SGST) and Refund Eligible cannot be negative.');
  }

  const totalGst = sumMoney([igst, cgst, sgst]);
  const difference = subMoney(refundEligible, totalGst);
  const result: GstResult = difference > 0 ? 'GAIN' : difference < 0 ? 'LOSS' : 'NIL';

  return {
    igst,
    cgst,
    sgst,
    totalGst,
    refundEligible,
    difference,
    result,
  };
}

export function summarizeGstEntries(entries: GstEntry[]): GstSummary {
  const totalIgst = sumMoney(entries.map((e) => e.igst));
  const totalCgst = sumMoney(entries.map((e) => e.cgst));
  const totalSgst = sumMoney(entries.map((e) => e.sgst));
  const totalGst = sumMoney([totalIgst, totalCgst, totalSgst]);
  const totalRefundEligible = sumMoney(entries.map((e) => e.refundEligible));
  const netDifference = subMoney(totalRefundEligible, totalGst);
  const overallResult: GstResult = netDifference > 0 ? 'GAIN' : netDifference < 0 ? 'LOSS' : 'NIL';

  return {
    totalEntries: entries.length,
    totalIgst,
    totalCgst,
    totalSgst,
    totalGst,
    totalRefundEligible,
    netDifference,
    overallResult,
    gainCount: entries.filter((e) => e.result === 'GAIN').length,
    lossCount: entries.filter((e) => e.result === 'LOSS').length,
    nilCount: entries.filter((e) => e.result === 'NIL').length,
  };
}
