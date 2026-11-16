/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { Role, User } from '../../../shared/contracts/index.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../domain/errors/AppError.ts';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';
import { toIsoTimestamp } from '../../infrastructure/prismaMappers.ts';

export type UserWithHash = User & { passwordHash: string };

export interface CreateUserRepoInput {
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  mustChangePassword?: boolean;
  passwordHash: string;
}

export interface UpdateUserRepoInput {
  name?: string;
  role?: Role;
  isActive?: boolean;
  mustChangePassword?: boolean;
  passwordHash?: string;
  tokenRevokedBefore?: string;
}

export interface IUsersRepository {
  findAll(): Promise<User[]>;
  findById(id: string): Promise<User | null>;
  findByEmailWithHash(email: string): Promise<UserWithHash | null>;
  create(input: CreateUserRepoInput): Promise<User>;
  update(id: string, input: UpdateUserRepoInput): Promise<User>;
  deleteWithReassignment(id: string, reassignToUserId: string): Promise<{ success: boolean }>;
  countActiveSuperAdmins(): Promise<number>;
}

function toCleanUser(row: {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  mustChangePassword?: boolean | null;
  tokenRevokedBefore?: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    isActive: row.isActive,
    mustChangePassword: Boolean(row.mustChangePassword),
    tokenRevokedBefore: row.tokenRevokedBefore ? toIsoTimestamp(row.tokenRevokedBefore) : undefined,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

export class PrismaUsersRepository implements IUsersRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll(): Promise<User[]> {
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toCleanUser);
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? toCleanUser(row) : null;
  }

  async findByEmailWithHash(email: string): Promise<UserWithHash | null> {
    const row = await this.prisma.user.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' } },
    });
    if (!row) return null;
    return {
      ...toCleanUser(row),
      passwordHash: row.passwordHash,
    };
  }

  async create(input: CreateUserRepoInput): Promise<User> {
    const existing = await this.findByEmailWithHash(input.email);
    if (existing) {
      throw new ConflictError('User with this email already exists.');
    }
    const created = await this.prisma.user.create({
      data: {
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        role: input.role,
        isActive: input.isActive,
        mustChangePassword: Boolean(input.mustChangePassword),
        passwordHash: input.passwordHash,
      },
    });
    return toCleanUser(created);
  }

  async update(id: string, input: UpdateUserRepoInput): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('User not found.');

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.mustChangePassword !== undefined ? { mustChangePassword: input.mustChangePassword } : {}),
        ...(input.passwordHash !== undefined ? { passwordHash: input.passwordHash } : {}),
        ...(input.tokenRevokedBefore !== undefined
          ? { tokenRevokedBefore: new Date(input.tokenRevokedBefore) }
          : {}),
      },
    });
    return toCleanUser(updated);
  }

  async countActiveSuperAdmins(): Promise<number> {
    return this.prisma.user.count({
      where: { role: 'SUPER_ADMIN', isActive: true },
    });
  }

  async deleteWithReassignment(id: string, reassignToUserId: string): Promise<{ success: boolean }> {
    if (id === reassignToUserId) {
      throw new ForbiddenError('You cannot delete your own account while logged in.');
    }

    await this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id } });
      if (!target) throw new NotFoundError('User not found.');

      if (target.role === 'SUPER_ADMIN') {
        const superAdmins = await tx.user.count({
          where: { role: 'SUPER_ADMIN', isActive: true },
        });
        if (superAdmins <= 1) {
          throw new ForbiddenError('Cannot delete the last remaining active Super Admin.');
        }
      }

      await tx.document.updateMany({
        where: { uploadedByUserId: id },
        data: { uploadedByUserId: reassignToUserId },
      });

      await tx.paymentAllocation.updateMany({
        where: { allocatedByUserId: id },
        data: { allocatedByUserId: reassignToUserId },
      });

      await tx.user.delete({ where: { id } });
    });

    return { success: true };
  }
}

export class JsonUsersRepository implements IUsersRepository {
  async findAll(): Promise<User[]> {
    const state = jsonStore.getState();
    return state.users.map(({ passwordHash: _ph, ...u }) => toCleanUser(u));
  }

  async findById(id: string): Promise<User | null> {
    const state = jsonStore.getState();
    const row = state.users.find((u) => u.id === id);
    return row ? toCleanUser(row) : null;
  }

  async findByEmailWithHash(email: string): Promise<UserWithHash | null> {
    const state = jsonStore.getState();
    const row = state.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!row) return null;
    return {
      ...toCleanUser(row),
      passwordHash: row.passwordHash || '',
    };
  }

  async create(input: CreateUserRepoInput): Promise<User> {
    const state = jsonStore.getState();
    const existing = state.users.find((u) => u.email.toLowerCase() === input.email.trim().toLowerCase());
    if (existing) {
      throw new ConflictError('User with this email already exists.');
    }
    const now = new Date().toISOString();
    const newUser: User & { passwordHash: string } = {
      id: crypto.randomUUID(),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      role: input.role,
      isActive: input.isActive,
      mustChangePassword: Boolean(input.mustChangePassword),
      passwordHash: input.passwordHash,
      createdAt: now,
      updatedAt: now,
    };
    state.users.push(newUser);
    jsonStore.save();
    return toCleanUser(newUser);
  }

  async update(id: string, input: UpdateUserRepoInput): Promise<User> {
    const state = jsonStore.getState();
    const user = state.users.find((u) => u.id === id);
    if (!user) throw new NotFoundError('User not found.');

    if (input.name !== undefined) user.name = input.name.trim();
    if (input.role !== undefined) user.role = input.role;
    if (input.isActive !== undefined) user.isActive = input.isActive;
    if (input.mustChangePassword !== undefined) user.mustChangePassword = input.mustChangePassword;
    if (input.passwordHash !== undefined) user.passwordHash = input.passwordHash;
    if (input.tokenRevokedBefore !== undefined) user.tokenRevokedBefore = input.tokenRevokedBefore;
    user.updatedAt = new Date().toISOString();

    jsonStore.save();
    return toCleanUser(user);
  }

  async countActiveSuperAdmins(): Promise<number> {
    const state = jsonStore.getState();
    return state.users.filter((u) => u.role === 'SUPER_ADMIN' && u.isActive).length;
  }

  async deleteWithReassignment(id: string, reassignToUserId: string): Promise<{ success: boolean }> {
    const state = jsonStore.getState();
    const idx = state.users.findIndex((u) => u.id === id);
    if (idx === -1) throw new NotFoundError('User not found.');

    const user = state.users[idx];
    if (user.id === reassignToUserId) {
      throw new ForbiddenError('You cannot delete your own account while logged in.');
    }

    const superAdmins = state.users.filter((u) => u.role === 'SUPER_ADMIN' && u.isActive);
    if (user.role === 'SUPER_ADMIN' && superAdmins.length <= 1) {
      throw new ForbiddenError('Cannot delete the last remaining active Super Admin.');
    }

    for (const doc of state.documents) {
      if (doc.uploadedByUserId === id) {
        doc.uploadedByUserId = reassignToUserId;
      }
    }
    for (const alloc of state.allocations) {
      if (alloc.allocatedByUserId === id) {
        alloc.allocatedByUserId = reassignToUserId;
      }
    }

    state.users.splice(idx, 1);
    jsonStore.save();
    return { success: true };
  }
}
