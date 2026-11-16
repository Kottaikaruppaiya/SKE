/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'object' && value !== null && 'toNumber' in (value as any)) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function round2(value: number): number {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

export function round4(value: number): number {
  return Math.round((toNumber(value) + Number.EPSILON) * 10000) / 10000;
}

export function toCents(value: number): number {
  return Math.round(toNumber(value) * 100);
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

export function addMoney(a: number, b: number): number {
  return fromCents(toCents(a) + toCents(b));
}

export function subMoney(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}

export function sumMoney(values: number[]): number {
  let totalCents = 0;
  for (const v of values) {
    totalCents += toCents(v);
  }
  return fromCents(totalCents);
}

export function mulMoney(amount: number, multiplier: number): number {
  return round2(toNumber(amount) * toNumber(multiplier));
}
