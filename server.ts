/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import crypto from 'crypto';

// In development, ensure default 32+ char key if not provided via .env
if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'production') {
  process.env.JWT_SECRET = 'ske_development_jwt_secret_key_minimum_32_characters_long_2026';
}

import { createServer as createViteServer } from 'vite';
import { apiRouter } from './server/routes.ts';

// Extend Express Request to include id and startTime
declare global {
  namespace Express {
    interface Request {
      id?: string;
      startTime?: number;
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Request ID and structured logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.id = (req.headers['x-request-id'] as string) || crypto.randomUUID();
    req.startTime = Date.now();
    res.setHeader('X-Request-Id', req.id);

    res.on('finish', () => {
      const duration = Date.now() - (req.startTime || Date.now());
      // Skip noisy asset requests from logs
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
  });

  // Body parsing middleware
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Mount API router
  app.use('/api', apiRouter);

  // Catch-all for undefined /api routes so they always return JSON, not HTML
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}`, requestId: req.id });
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'ske-export-tracker',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  // Mount Vite middleware for dev or static files for prod
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve('dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SKE Server] Running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[SKE Server] Fatal initialization error:', err);
  process.exit(1);
});
