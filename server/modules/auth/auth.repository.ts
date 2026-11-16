/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PrismaClient } from '@prisma/client';
import { jsonStore } from '../../infrastructure/jsonPersistence.ts';

export interface ITokenRevocationRepository {
  revokeToken(token: string, userId: string, expiresAtIso?: string): Promise<void>;
  isTokenRevoked(token: string): Promise<boolean>;
  revokeAllForUser(userId: string): Promise<void>;
}

export class PrismaTokenRevocationRepository implements ITokenRevocationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async revokeToken(token: string, userId: string, expiresAtIso?: string): Promise<void> {
    const expiresAt = expiresAtIso ? new Date(expiresAtIso) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await this.prisma.revokedToken.upsert({
      where: { token },
      update: { userId, expiresAt },
      create: { token, userId, expiresAt },
    });
    // Prune expired tokens asynchronously
    await this.prisma.revokedToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  }

  async isTokenRevoked(token: string): Promise<boolean> {
    const row = await this.prisma.revokedToken.findUnique({ where: { token } });
    return Boolean(row);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const now = new Date();
    await this.prisma.user.updateMany({
      where: { id: userId },
      data: { tokenRevokedBefore: now },
    });
    await this.prisma.revokedToken.create({
      data: {
        token: `user-revocation-${userId}-${Date.now()}`,
        userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  }
}

export class JsonTokenRevocationRepository implements ITokenRevocationRepository {
  async revokeToken(token: string, userId: string, expiresAtIso?: string): Promise<void> {
    const state = jsonStore.getState();
    if (!state.revokedTokens) state.revokedTokens = [];
    if (!state.revokedTokens.some((r) => r.token === token)) {
      const now = new Date().toISOString();
      state.revokedTokens.push({
        token,
        userId,
        revokedAt: now,
        expiresAt: expiresAtIso || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
      state.revokedTokens = state.revokedTokens.filter((r) => r.expiresAt > now);
      jsonStore.save();
    }
  }

  async isTokenRevoked(token: string): Promise<boolean> {
    const state = jsonStore.getState();
    if (!state.revokedTokens || state.revokedTokens.length === 0) return false;
    return state.revokedTokens.some((r) => r.token === token);
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const state = jsonStore.getState();
    if (!state.revokedTokens) state.revokedTokens = [];
    const now = new Date().toISOString();
    const user = state.users.find((u) => u.id === userId);
    if (user) {
      user.tokenRevokedBefore = now;
      user.updatedAt = now;
    }
    state.revokedTokens.push({
      token: `user-revocation-${userId}-${Date.now()}`,
      userId,
      revokedAt: now,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    jsonStore.save();
  }
}
