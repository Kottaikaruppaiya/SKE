/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

export const createConsigneeSchema = z.object({
  name: z.string().trim().min(1, 'Consignee name is required.'),
  country: z.string().trim().min(1, 'Country is required.').default('International'),
  portOfDischarge: z.string().optional().default(''),
  paymentTerms: z.string().optional().default(''),
  currency: z.string().trim().optional().default('USD'),
  contactEmail: z.string().trim().optional(),
  isActive: z.boolean().optional().default(true),
});

export const updateConsigneeSchema = createConsigneeSchema.partial();

export const createBankSchema = z.object({
  name: z.string().trim().min(1, 'Bank name is required.'),
  branch: z.string().optional().default(''),
  adCode: z.string().optional().default(''),
  ifscCode: z.string().optional().default(''),
  swiftCode: z.string().optional().default(''),
  accountNumber: z.string().optional().default(''),
  isActive: z.boolean().optional().default(true),
});

export const updateBankSchema = createBankSchema.partial();

export function validateCreateConsignee(body: unknown) {
  const parsed = createConsigneeSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid consignee data.');
  return parsed.data;
}

export function validateUpdateConsignee(body: unknown) {
  const parsed = updateConsigneeSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid consignee update data.');
  return parsed.data;
}

export function validateCreateBank(body: unknown) {
  const parsed = createBankSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid bank data.');
  return parsed.data;
}

export function validateUpdateBank(body: unknown) {
  const parsed = updateBankSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid bank update data.');
  return parsed.data;
}
