/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { AppError } from '../domain/errors/AppError.ts';
import { env } from '../config/environment.ts';

export const asyncHandler =
  <TReq extends Request = Request>(
    fn: (req: TReq, res: Response, next: NextFunction) => Promise<any> | any
  ) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as TReq, res, next)).catch(next);
  };

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.id;

  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Uploaded file exceeds maximum allowed size of ${env.maxUploadSizeMb}MB.`
        : `File upload error: ${err.message}`;
    return res.status(status).json({ error: message, code: err.code, requestId });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code,
      details: err.details,
      requestId,
    });
  }

  // Handle Prisma known constraint errors safely
  if (err?.code === 'P2002') {
    return res.status(409).json({
      error: 'A duplicate record with the same unique identifier already exists.',
      code: 'UNIQUE_CONSTRAINT',
      requestId,
    });
  }
  if (err?.code === 'P2003') {
    return res.status(409).json({
      error: 'Operation blocked because referenced records still depend on this item.',
      code: 'FOREIGN_KEY_CONSTRAINT',
      requestId,
    });
  }

  if (typeof err?.message === 'string' && err.message.startsWith('Security Policy:')) {
    return res.status(400).json({ error: err.message, code: 'SECURITY_POLICY', requestId });
  }

  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      method: req.method,
      path: req.originalUrl,
      message: err?.message || 'Unhandled API error',
      timestamp: new Date().toISOString(),
    })
  );

  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
  const safeMessage = status < 500 && err?.message ? err.message : 'An unexpected server error occurred.';
  return res.status(status).json({ error: safeMessage, requestId });
}
