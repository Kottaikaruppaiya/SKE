/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

const reviewStatusSchema = z.object({
  reviewStatus: z.enum(['EXTRACTED', 'NEEDS_REVIEW', 'CONFIRMED', 'MANUALLY_ENTERED']),
});

export function validateReviewStatusPayload(body: unknown) {
  const parsed = reviewStatusSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid review status.');
  }
  return parsed.data.reviewStatus;
}
