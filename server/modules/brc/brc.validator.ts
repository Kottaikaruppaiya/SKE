/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

const updateBrcSchema = z.object({
  brcNumber: z.string().optional(),
  issueDate: z.string().optional(),
  realisationDate: z.string().optional(),
  realisedAmount: z.coerce.number().min(0).optional(),
  realisedCurrency: z.string().optional(),
  uploadMode: z.enum(['SINGLE', 'MULTIPLE']).optional(),
  statutoryDeadline: z.string().optional(),
  status: z.enum(['PENDING', 'ISSUED', 'REALISED', 'OVERDUE']).optional(),
  remarks: z.string().optional(),
});

export function validateUpdateBrcPayload(body: unknown) {
  const parsed = updateBrcSchema.safeParse(body || {});
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid BRC update payload.');
  }
  return parsed.data;
}
