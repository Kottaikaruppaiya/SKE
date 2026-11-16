/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Role, User } from '../../../shared/contracts/index.ts';
import { hashPassword } from '../../../prisma/seedData.ts';
import { ForbiddenError, NotFoundError } from '../../domain/errors/AppError.ts';
import type { IUsersRepository } from './users.repository.ts';

export class UsersService {
  constructor(
    private readonly usersRepo: IUsersRepository,
    private readonly onRevokeUserSessions?: (userId: string) => Promise<void>
  ) {}

  async listUsers(): Promise<User[]> {
    return this.usersRepo.findAll();
  }

  async getUserById(id: string): Promise<User | null> {
    return this.usersRepo.findById(id);
  }

  async createUser(
    data: { email: string; name: string; role: Role; isActive?: boolean; mustChangePassword?: boolean },
    passwordPlain: string
  ): Promise<User> {
    const passwordHash = hashPassword(passwordPlain);
    return this.usersRepo.create({
      email: data.email,
      name: data.name,
      role: data.role,
      isActive: data.isActive ?? true,
      mustChangePassword: data.mustChangePassword ?? false,
      passwordHash,
    });
  }

  async updateUser(
    id: string,
    updates: {
      name?: string;
      role?: Role;
      isActive?: boolean;
      password?: string;
      mustChangePassword?: boolean;
    }
  ): Promise<User> {
    const existing = await this.usersRepo.findById(id);
    if (!existing) {
      throw new NotFoundError('User not found.');
    }

    const shouldRevoke = updates.isActive === false || Boolean(updates.password);
    const updated = await this.usersRepo.update(id, {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.role !== undefined ? { role: updates.role } : {}),
      ...(updates.isActive !== undefined ? { isActive: updates.isActive } : {}),
      ...(updates.password !== undefined
        ? {
            passwordHash: hashPassword(updates.password),
            mustChangePassword: false,
            tokenRevokedBefore: new Date().toISOString(),
          }
        : updates.mustChangePassword !== undefined
          ? { mustChangePassword: updates.mustChangePassword }
          : {}),
      ...(updates.isActive === false ? { tokenRevokedBefore: new Date().toISOString() } : {}),
    });

    if (shouldRevoke && this.onRevokeUserSessions) {
      await this.onRevokeUserSessions(id);
    }

    return updated;
  }

  async deleteUser(id: string, actorUserId: string): Promise<{ success: boolean }> {
    if (id === actorUserId) {
      throw new ForbiddenError('You cannot delete your own account while logged in.');
    }
    const result = await this.usersRepo.deleteWithReassignment(id, actorUserId);
    if (this.onRevokeUserSessions) {
      await this.onRevokeUserSessions(id);
    }
    return result;
  }
}
