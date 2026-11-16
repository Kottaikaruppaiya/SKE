/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextFunction, RequestHandler, Response } from 'express';
import type { AuthenticatedRequest } from './authorize.ts';
import type { AuthService } from '../modules/auth/auth.service.ts';

export function createAuthenticateMiddleware(authService: AuthService): RequestHandler {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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
      const user = await authService.verifyTokenAndLoadUser(token, { allowDownloadTicket: false });
      req.user = user;
      req.token = token;
      next();
    } catch (err: any) {
      return res.status(err?.status || 401).json({ error: err?.message || 'Invalid, expired, or revoked session token.' });
    }
  };
}

export function createAuthenticateDownloadMiddleware(authService: AuthService): RequestHandler {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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
      return res.status(401).json({
        error: 'Download authentication required. Provide Bearer header or valid download ticket.',
      });
    }

    try {
      const user = await authService.verifyTokenAndLoadUser(token, { allowDownloadTicket: true });
      req.user = user;
      req.token = token;
      next();
    } catch (err: any) {
      return res.status(err?.status || 401).json({ error: err?.message || 'Invalid or expired download ticket.' });
    }
  };
}
