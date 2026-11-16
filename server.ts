/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import { bootstrapServer } from './server/server.ts';

bootstrapServer().catch((err) => {
  console.error('[SKE Server] Fatal initialization error:', err);
  process.exit(1);
});
