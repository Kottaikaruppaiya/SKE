/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

const createGstEntrySchema = z.object({
  entryDate: z.string().min(1, 'Valid entry date is required.'),
  consigneeId: z.string().min(1, 'Consignee is required.'),
  igst: z.coerce.number().min(0, 'IGST cannot be negative.').default(0),
  cgst: z.coerce.number().min(0, 'CGST cannot be negative.').default(0),
  sgst: z.coerce.number().min(0, 'SGST cannot be negative.').default(0),
  refundEligible: z.coerce.number().min(0, 'Refund Eligible cannot be negative.').default(0),
  remarks: z.string().optional(),
});

const updateGstEntrySchema = z.object({
  entryDate: z.string().min(1).optional(),
  consigneeId: z.string().min(1).optional(),
  igst: z.coerce.number().min(0, 'IGST cannot be negative.').optional(),
  cgst: z.coerce.number().min(0, 'CGST cannot be negative.').optional(),
  sgst: z.coerce.number().min(0, 'SGST cannot be negative.').optional(),
  refundEligible: z.coerce.number().min(0, 'Refund Eligible cannot be negative.').optional(),
  remarks: z.string().optional(),
});

export function validateCreateGstEntry(payload: unknown) {
  const parsed = createGstEntrySchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid GST entry payload.');
  }
  return parsed.data;
}

export function validateUpdateGstEntry(payload: unknown) {
  const parsed = updateGstEntrySchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid GST entry update payload.');
  }
  return parsed.data;
}
