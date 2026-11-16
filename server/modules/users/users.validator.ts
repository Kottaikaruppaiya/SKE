/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

export const createUserSchema = z.object({
  email: z.string().trim().email('Valid corporate email is required.'),
  name: z.string().trim().min(1, 'Name is required.'),
  role: z.enum(['SUPER_ADMIN', 'ADMIN', 'VIEWER']),
  password: z.string().min(6, 'Password must be at least 6 characters long.'),
  isActive: z.boolean().optional().default(true),
  mustChangePassword: z.boolean().optional().default(false),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty.').optional(),
  role: z.enum(['SUPER_ADMIN', 'ADMIN', 'VIEWER']).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(6, 'Password must be at least 6 characters long.').optional(),
  mustChangePassword: z.boolean().optional(),
});

export function validateCreateUser(body: unknown) {
  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid user payload.');
  }
  return parsed.data;
}

export function validateUpdateUser(body: unknown) {
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid user update payload.');
  }
  return parsed.data;
}
