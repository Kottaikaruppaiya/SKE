/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import jwt from 'jsonwebtoken';
import type { User } from '../../../shared/contracts/index.ts';
import { env } from '../../config/environment.ts';
import { NotFoundError, TooManyRequestsError, UnauthorizedError } from '../../domain/errors/AppError.ts';
import { loginRateLimiter } from '../../middleware/rateLimit.ts';
import { hashPassword, verifyPassword } from '../../../prisma/seedData.ts';
import type { IUsersRepository } from '../users/users.repository.ts';
import type { ITokenRevocationRepository } from './auth.repository.ts';

export class AuthService {
  constructor(
    private readonly usersRepo: IUsersRepository,
    private readonly tokenRepo: ITokenRevocationRepository
  ) {}

  public signSessionToken(user: User): string {
    return jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        iatMs: Date.now(),
      },
      env.jwtSecret,
      { expiresIn: '7d' }
    );
  }

  public signDownloadTicket(user: User, fileId?: string): string {
    return jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        purpose: 'download',
        fileId,
        iatMs: Date.now(),
      },
      env.jwtSecret,
      { expiresIn: '60s' }
    );
  }

  async login(
    email: string,
    password: string,
    clientIp: string
  ): Promise<{ token: string; user: User; mustChangePassword: boolean }> {
    const cleanEmail = email.trim().toLowerCase();
    const attemptKey = `${clientIp}_${cleanEmail}`;

    const lockCheck = loginRateLimiter.check(attemptKey);
    if (lockCheck.locked) {
      throw new TooManyRequestsError(
        `Account temporarily locked due to excessive failed attempts. Please retry in ${lockCheck.remainingMinutes} minute(s).`
      );
    }

    const userWithHash = await this.usersRepo.findByEmailWithHash(cleanEmail);
    if (!userWithHash || !userWithHash.isActive) {
      loginRateLimiter.recordFailure(attemptKey);
      throw new UnauthorizedError('Invalid credentials or inactive account.');
    }

    if (!verifyPassword(password, userWithHash.passwordHash)) {
      const failure = loginRateLimiter.recordFailure(attemptKey);
      if (failure.justLocked) {
        throw new TooManyRequestsError(
          'Account temporarily locked due to 5 consecutive failed attempts. Please retry after 15 minutes.'
        );
      }
      throw new UnauthorizedError('Invalid email or password.');
    }

    loginRateLimiter.reset(attemptKey);
    const { passwordHash: _ph, ...user } = userWithHash;
    const token = this.signSessionToken(user);
    return {
      token,
      user,
      mustChangePassword: Boolean(user.mustChangePassword),
    };
  }

  async changePassword(
    actorUser: User,
    currentPassword: string | undefined,
    newPassword: string
  ): Promise<{ success: boolean; message: string; token: string; user: User }> {
    const userWithHash = await this.usersRepo.findByEmailWithHash(actorUser.email);
    if (!userWithHash) {
      throw new NotFoundError('User record not found.');
    }

    if (!userWithHash.mustChangePassword) {
      if (!currentPassword || !verifyPassword(currentPassword, userWithHash.passwordHash)) {
        throw new UnauthorizedError('Current password verification failed.');
      }
    }

    const now = new Date().toISOString();
    const updatedUser = await this.usersRepo.update(actorUser.id, {
      passwordHash: hashPassword(newPassword),
      mustChangePassword: false,
      tokenRevokedBefore: now,
    });
    await this.tokenRepo.revokeAllForUser(actorUser.id);

    const newToken = this.signSessionToken(updatedUser);
    return {
      success: true,
      message: 'Password changed successfully. All previous sessions have been invalidated.',
      token: newToken,
      user: updatedUser,
    };
  }

  async logout(token: string | undefined, userId: string | undefined): Promise<{ success: boolean; message: string }> {
    if (token && userId) {
      let expiresAt: string | undefined;
      try {
        const decoded = jwt.decode(token) as any;
        if (decoded?.exp) {
          expiresAt = new Date(decoded.exp * 1000).toISOString();
        }
      } catch {
        // ignore decode error
      }
      await this.tokenRepo.revokeToken(token, userId, expiresAt);
    }
    return { success: true, message: 'Session revoked and logged out successfully.' };
  }

  async verifyTokenAndLoadUser(token: string, options: { allowDownloadTicket: boolean }): Promise<User> {
    if (await this.tokenRepo.isTokenRevoked(token)) {
      throw new UnauthorizedError(
        options.allowDownloadTicket
          ? 'Session or ticket has been revoked.'
          : 'Session has been revoked or logged out. Please sign in again.'
      );
    }

    let decoded: any;
    try {
      decoded = jwt.verify(token, env.jwtSecret);
    } catch {
      throw new UnauthorizedError(
        options.allowDownloadTicket
          ? 'Invalid or expired download ticket.'
          : 'Invalid, expired, or revoked session token.'
      );
    }

    if (!options.allowDownloadTicket && decoded.purpose === 'download') {
      throw new UnauthorizedError('Download tickets cannot be used for operational API requests.');
    }

    const user = await this.usersRepo.findById(decoded.id);
    if (!user || !user.isActive) {
      throw new UnauthorizedError('User session expired or account deactivated.');
    }

    if (user.tokenRevokedBefore && (decoded.iatMs || decoded.iat)) {
      const revokedTime = new Date(user.tokenRevokedBefore).getTime();
      const tokenIssuedTime = typeof decoded.iatMs === 'number' ? decoded.iatMs : decoded.iat * 1000;
      if (tokenIssuedTime < revokedTime) {
        throw new UnauthorizedError(
          'Session has been invalidated due to a password change or administrative reset. Please sign in again.'
        );
      }
    }

    return user;
  }
}
