/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getStorageRoot } from './config/storage.ts';
import { createContainer } from './container.ts';
import { validateDocumentContent } from './middleware/upload.ts';
import { createApiRouter } from './routes/index.ts';

export const getStorageDir = getStorageRoot;
export { validateDocumentContent };
export const apiRouter = createApiRouter(createContainer());
