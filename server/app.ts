/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type Express } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { checkDatabaseHealth } from './config/database.ts';
import { env } from './config/environment.ts';
import type { AppContainer } from './container.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import { requestContextMiddleware } from './middleware/requestContext.ts';
import { createApiRouter } from './routes/index.ts';

export async function createApp(container: AppContainer): Promise<Express> {
  const app = express();

  app.use(requestContextMiddleware);
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.use('/api', createApiRouter(container));

  app.use('/api', (req, res) => {
    res.status(404).json({
      error: `API route not found: ${req.method} ${req.originalUrl}`,
      requestId: req.id,
    });
  });

  app.get('/health', async (_req, res) => {
    const dbHealth = await checkDatabaseHealth();
    res.json({
      status: dbHealth.status,
      service: 'ske-export-tracker',
      database: dbHealth.engine,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  if (env.isProduction) {
    app.use(express.static(path.resolve('dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.use(errorHandler);

  return app;
}
