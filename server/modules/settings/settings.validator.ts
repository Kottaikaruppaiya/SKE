/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

const updateSettingsSchema = z.object({
  statutoryBrcDays: z.coerce.number().int().min(1).max(1095).optional(),
  defaultPortCode: z.string().trim().min(1).max(20).optional(),
  baseCurrency: z.string().trim().min(1).max(10).optional(),
  allowOverAllocation: z.boolean().optional(),
  companyName: z.string().trim().min(1).optional(),
  iecNumber: z.string().trim().optional(),
  panNumber: z.string().trim().optional(),
});

export function validateUpdateSettings(payload: unknown) {
  const parsed = updateSettingsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid settings payload.');
  }
  return parsed.data;
}
