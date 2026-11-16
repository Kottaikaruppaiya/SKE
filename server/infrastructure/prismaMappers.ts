/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { toNumber } from '../domain/calculations/money.ts';

export function toIsoDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().split('T')[0];
  }
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.slice(0, 10);
  }
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? str : parsed.toISOString().split('T')[0];
}

export function toIsoTimestamp(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  }
  return String(value);
}

export function toDateOrUndefined(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const iso = toIsoDate(value);
  return iso || undefined;
}

export function decimalToNumber(value: unknown, fallback = 0): number {
  return toNumber(value, fallback);
}

export function bigIntToNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
