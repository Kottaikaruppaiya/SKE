/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  namespace Express {
    interface Request {
      id?: string;
      startTime?: number;
    }
  }
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  req.id = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.startTime = Date.now();
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    const duration = Date.now() - (req.startTime || Date.now());
    if (!req.originalUrl.startsWith('/@') && !req.originalUrl.includes('.')) {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          requestId: req.id,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: duration,
          ip: req.ip || req.socket.remoteAddress,
        })
      );
    }
  });

  next();
}
