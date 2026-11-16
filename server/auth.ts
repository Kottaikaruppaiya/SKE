/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role, User } from '../src/types/index.ts';
import { env } from './config/environment.ts';
import { db } from './db.ts';

export const JWT_SECRET: string = env.jwtSecret;

export interface AuthenticatedRequest extends Request {
  user?: User;
  token?: string;
}

export function generateToken(user: User): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      iatMs: Date.now(),
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function generateDownloadTicket(user: User, fileId?: string): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      purpose: 'download',
      fileId,
      iatMs: Date.now(),
    },
    JWT_SECRET,
    { expiresIn: '60s' }
  );
}

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token && (req.query?.token || req.query?.access_token)) {
    return res.status(401).json({
      error:
        'Security Warning: Authentication tokens in query strings are prohibited. Provide credentials via Authorization: Bearer <token> header.',
    });
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }

  try {
    if (db.isTokenRevoked(token)) {
      return res.status(401).json({ error: 'Session has been revoked or logged out. Please sign in again.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;

    if (decoded.purpose === 'download') {
      return res.status(401).json({ error: 'Download tickets cannot be used for operational API requests.' });
    }

    const user = db.getUserById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User session expired or account deactivated.' });
    }

    if (user.tokenRevokedBefore && (decoded.iatMs || decoded.iat)) {
      const revokedTime = new Date(user.tokenRevokedBefore).getTime();
      const tokenIssuedTime = typeof decoded.iatMs === 'number' ? decoded.iatMs : decoded.iat * 1000;
      if (tokenIssuedTime < revokedTime) {
        return res.status(401).json({
          error: 'Session has been invalidated due to a password change or administrative reset. Please sign in again.',
        });
      }
    }

    req.user = user;
    req.token = token;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid, expired, or revoked session token.' });
  }
}

export function authenticateDownload(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query?.ticket) {
    token = String(req.query.ticket);
  }

  if (!token && req.query?.token) {
    return res.status(401).json({
      error:
        'Security Warning: Full session tokens cannot be passed via URL. Use a short-lived download ticket or Bearer header.',
    });
  }

  if (!token) {
    return res.status(401).json({ error: 'Download authentication required. Provide Bearer header or valid download ticket.' });
  }

  try {
    if (db.isTokenRevoked(token)) {
      return res.status(401).json({ error: 'Session or ticket has been revoked.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const user = db.getUserById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User account deactivated or not found.' });
    }

    if (user.tokenRevokedBefore && (decoded.iatMs || decoded.iat)) {
      const revokedTime = new Date(user.tokenRevokedBefore).getTime();
      const tokenIssuedTime = typeof decoded.iatMs === 'number' ? decoded.iatMs : decoded.iat * 1000;
      if (tokenIssuedTime < revokedTime) {
        return res.status(401).json({ error: 'Session invalidated. Please sign in again.' });
      }
    }

    req.user = user;
    req.token = token;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired download ticket.' });
  }
}

export function requireRole(allowedRoles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Permission Denied: Action requires one of [${allowedRoles.join(', ')}]. Your current role is '${req.user.role}'.`,
      });
    }

    next();
  };
}
