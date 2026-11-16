/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { initializeDatabase, disconnectDatabase } from './config/database.ts';
import { env } from './config/environment.ts';
import { createContainer } from './container.ts';
import { createApp } from './app.ts';

export async function bootstrapServer() {
  const dbInit = await initializeDatabase();
  const container = createContainer();
  container.ocrWorker.startPolling();

  const app = await createApp(container);

  const server = app.listen(env.port, '0.0.0.0', () => {
    console.log(
      `[SKE Server] Running on http://0.0.0.0:${env.port} (db=${dbInit.mode}, env=${env.nodeEnv})`
    );
  });

  const shutdown = async () => {
    container.ocrWorker.stopPolling();
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  return { app, server, container };
}
