/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

const enqueueBodySchema = z.object({
  category: z
    .enum([
      'COMMERCIAL_INVOICE',
      'SHIPPING_BILL',
      'FIRC_PAYMENT',
      'BILL_OF_LADING',
      'BRC_COPY_1',
      'BRC_COPY_2',
      'ADDITIONAL_DOC',
    ])
    .optional(),
  financialYearId: z.string().optional(),
});

export function validateEnqueueOcrPayload(body: unknown) {
  const parsed = enqueueBodySchema.safeParse(body || {});
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid OCR job payload.');
  }
  return parsed.data;
}

export function validateApproveOcrPayload(body: unknown): Record<string, any> {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Reviewed values payload is required.');
  }
  const obj = body as Record<string, any>;
  return obj.reviewedValues && typeof obj.reviewedValues === 'object' ? obj.reviewedValues : obj;
}
