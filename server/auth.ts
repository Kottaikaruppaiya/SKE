/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db.ts';
import type { Role, User } from '../src/types/index.ts';

const JWT_SECRET = process.env.JWT_SECRET || 'ske_export_documents_tracker_secret_key_2026';

export interface AuthenticatedRequest extends Request {
  user?: User;
}

export function generateToken(user: User): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query?.token) {
    token = String(req.query.token);
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const user = db.getUserById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User session expired or account deactivated.' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session token.' });
  }
}

export function requireRole(allowedRoles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      db.logAudit({
        userId: req.user.id,
        action: 'PERMISSION_DENIED',
        entityType: 'SECURITY',
        newValues: {
          attemptedUrl: req.originalUrl,
          requiredRoles: allowedRoles,
          userRole: req.user.role,
        },
      });
      return res.status(403).json({
        error: `Permission Denied: Action requires one of [${allowedRoles.join(', ')}]. Your current role is '${req.user.role}'.`,
      });
    }

    next();
  };
}
