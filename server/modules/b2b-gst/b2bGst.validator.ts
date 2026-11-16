/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

const supplierCreateSchema = z.object({
  gstin: z.string().trim().length(15, 'Valid 15-character GSTIN is required.'),
  legalName: z.string().trim().min(1, 'Supplier legal name is required.'),
  tradeName: z.string().optional(),
  address: z.string().optional(),
  state: z.string().optional(),
});

const supplierUpdateSchema = z.object({
  legalName: z.string().trim().min(1, 'Legal name cannot be empty.').optional(),
  tradeName: z.string().optional(),
  address: z.string().optional(),
  state: z.string().optional(),
});

const commitImportSchema = z.object({
  previewData: z.object({}).passthrough(),
  mode: z.enum(['SKIP_EXISTING', 'OVERWRITE_EXISTING', 'INSERT_ALL']).default('SKIP_EXISTING'),
  fileName: z.string().optional(),
  fileSizeBytes: z.coerce.number().optional(),
});

export function validateCreateSupplier(payload: unknown) {
  const parsed = supplierCreateSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid supplier payload.');
  }
  return parsed.data;
}

export function validateUpdateSupplier(payload: unknown) {
  const parsed = supplierUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid supplier update payload.');
  }
  return parsed.data;
}

export function validateCommitB2bImport(payload: unknown) {
  const parsed = commitImportSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('Preview data is required for commit.');
  }
  return parsed.data;
}
