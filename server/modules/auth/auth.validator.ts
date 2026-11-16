/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ValidationError } from '../../domain/errors/AppError.ts';

export const loginSchema = z.object({
  email: z.string().trim().min(1, 'Corporate email is required.'),
  password: z.string().min(1, 'Password is required.'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, 'New password must be at least 8 characters long.'),
});

export function validateLogin(body: unknown) {
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid login credentials format.');
  }
  return parsed.data;
}

export function validateChangePassword(body: unknown) {
  const parsed = changePasswordSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message || 'Invalid password payload.');
  }
  return parsed.data;
}
