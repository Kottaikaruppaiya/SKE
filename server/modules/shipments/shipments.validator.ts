/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

export const createShipmentSchema = z.object({
  financialYearId: z.string().trim().min(1).optional(),
  invoiceNumber: z.string().trim().min(1, 'Invoice Number is required and must be unique.'),
  invoiceDate: z.string().trim().optional(),
  consigneeId: z.string().trim().optional(),
  portCode: z.string().trim().optional().default('INNSA1'),
  packageCount: z.coerce.number().int().min(0).optional().default(0),
  invoiceValueUsd: z.coerce.number().min(0).default(0),
  shippingBillNumber: z.string().trim().optional().default('PENDING'),
  shippingBillDate: z.string().trim().optional(),
  sbExchangeRate: z.coerce.number().positive().optional().default(84.5),
  fobValueInr: z.coerce.number().min(0).optional(),
  blNumber: z.string().optional(),
  blDate: z.string().optional(),
  vesselName: z.string().optional(),
  remarks: z.string().optional(),
  reviewStatus: z.enum(['EXTRACTED', 'NEEDS_REVIEW', 'CONFIRMED', 'MANUALLY_ENTERED']).optional(),
  initialFircPaymentId: z.string().trim().optional(),
  initialFircAllocationAmount: z.coerce.number().optional(),
  initialFircDocumentUploaded: z.boolean().optional(),
  incentives: z
    .object({
      dbkClaimed: z.coerce.number().min(0).optional(),
      rodtepClaimed: z.coerce.number().min(0).optional(),
      rosctlClaimed: z.coerce.number().min(0).optional(),
    })
    .optional(),
  brc: z
    .object({
      uploadMode: z.enum(['SINGLE', 'MULTIPLE']).optional(),
      statutoryDeadline: z.string().optional(),
      remarks: z.string().optional(),
    })
    .optional(),
});

export function validateCreateShipment(body: unknown) {
  const parsed = createShipmentSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid shipment payload.');
  }
  return parsed.data;
}

export function validateCreateWithDocumentsBody(body: Record<string, any>) {
  const invoiceNumber = String(body?.invoiceNumber || '').trim();
  if (!invoiceNumber) {
    throw new ValidationError('Invoice Number is required and must be unique.');
  }
  const brcUploadMode = body?.brcUploadMode === 'MULTIPLE' ? 'MULTIPLE' : 'SINGLE';
  return {
    ...body,
    invoiceNumber,
    brcUploadMode: brcUploadMode as 'SINGLE' | 'MULTIPLE',
  };
}
