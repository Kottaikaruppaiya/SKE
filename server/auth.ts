/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db.ts';
import type { Role, User } from '../src/types/index.ts';

// Enforce strong JWT secret - fail fast if missing or shorter than 32 characters
const rawSecret = process.env.JWT_SECRET;
if (!rawSecret || rawSecret.trim().length < 32) {
  throw new Error(
    'FATAL SECURITY ERROR: JWT_SECRET environment variable is missing or shorter than 32 characters. A cryptographically secure key of at least 32 characters is required.'
  );
}
export const JWT_SECRET: string = rawSecret.trim();

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

/**
 * Generates a short-lived, signed download ticket (valid for 60 seconds)
 * strictly scoped to document retrieval without exposing long-lived session tokens in query strings.
 */
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

/**
 * Standard authentication middleware for all API endpoints.
 * Strictly requires Authorization: Bearer <token> in headers.
 * Tokens in query strings are rejected to prevent leakage in URLs, proxy logs, and browser history.
 */
export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  // Explicitly reject query string tokens on general endpoints (Item 5)
  if (!token && (req.query?.token || req.query?.access_token)) {
    return res.status(401).json({
      error: 'Security Warning: Authentication tokens in query strings are prohibited. Provide credentials via Authorization: Bearer <token> header.',
    });
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }

  try {
    // Check server-side session revocation store
    if (db.isTokenRevoked(token)) {
      return res.status(401).json({ error: 'Session has been revoked or logged out. Please sign in again.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // Reject short-lived download tickets on general operational API endpoints
    if (decoded.purpose === 'download') {
      return res.status(401).json({ error: 'Download tickets cannot be used for operational API requests.' });
    }

    const user = db.getUserById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User session expired or account deactivated.' });
    }

    // Check user-level session revocation (e.g., password change or account reset)
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
  } catch (err: any) {
    return res.status(401).json({ error: 'Invalid, expired, or revoked session token.' });
  }
}

/**
 * Authentication middleware for document downloads and file exports.
 * Accepts either:
 * 1. Authorization: Bearer <token> header (recommended for programmatic downloads)
 * 2. ?ticket=<signed_ticket> (short-lived 60s single-use download token)
 */
export function authenticateDownload(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query?.ticket) {
    token = String(req.query.ticket);
  }

  // Reject general session token in query string
  if (!token && req.query?.token) {
    return res.status(401).json({
      error: 'Security Warning: Full session tokens cannot be passed via URL. Use a short-lived download ticket or Bearer header.',
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
  } catch (err: any) {
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
