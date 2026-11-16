/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

export const createPaymentSchema = z.object({
  irmNumber: z.string().trim().min(1, 'IRM / FIRC Number is required.'),
  senderReference: z.string().optional(),
  currency: z.string().trim().optional().default('USD'),
  verifiedAmount: z.coerce.number().positive('Verified amount must be greater than zero.'),
  inrAmount: z.coerce.number().optional(),
  exchangeRate: z.coerce.number().positive().optional(),
  valueDate: z.string().trim().min(1, 'Value date is required.'),
  creditDate: z.string().trim().min(1, 'Credit date is required.'),
  fircIssueDate: z.string().optional(),
  bankId: z.string().trim().min(1, 'Bank selection is required.'),
  purposeCode: z.string().optional().default('P0102'),
  remarks: z.string().optional(),
});

export const allocatePaymentSchema = z.object({
  paymentId: z.string().trim().min(1, 'Payment ID is required.'),
  shipmentId: z.string().trim().min(1, 'Shipment ID is required.'),
  allocatedAmountUsd: z.coerce.number().positive('Allocation amount must be strictly greater than 0.'),
  notes: z.string().optional(),
});

export function validateCreatePayment(body: unknown) {
  const parsed = createPaymentSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid payment payload.');
  return parsed.data;
}

export function validateAllocatePayment(body: unknown) {
  const parsed = allocatePaymentSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid allocation payload.');
  return parsed.data;
}
