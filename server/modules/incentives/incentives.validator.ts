/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

const createIncentiveSchema = z.object({
  shipmentId: z.string().trim().min(1, 'Shipment ID is required.'),
  type: z.enum(['DRAWBACK', 'RODTEP', 'ROSCTL']),
  claimedAmount: z.coerce.number().min(0, 'Claimed amount cannot be negative.'),
  receivedAmount: z.coerce.number().min(0).optional(),
  receivedDate: z.string().optional(),
  scrollNumber: z.string().optional(),
  remarks: z.string().optional(),
});

const updateIncentiveSchema = z.object({
  claimedAmount: z.coerce.number().min(0).optional(),
  receivedAmount: z.coerce.number().min(0).optional(),
  receivedDate: z.string().optional(),
  status: z.enum(['PENDING', 'PART_RECEIVED', 'RECEIVED']).optional(),
  scrollNumber: z.string().optional(),
  remarks: z.string().optional(),
});

export function validateCreateIncentivePayload(body: unknown) {
  const parsed = createIncentiveSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid incentive payload.');
  }
  return parsed.data;
}

export function validateUpdateIncentivePayload(body: unknown) {
  const parsed = updateIncentiveSchema.safeParse(body || {});
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid incentive update payload.');
  }
  return parsed.data;
}
