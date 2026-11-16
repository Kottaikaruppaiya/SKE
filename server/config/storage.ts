/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { ForbiddenError } from '../domain/errors/AppError.ts';

export function getStorageRoot(): string {
  const root = process.env.STORAGE_ROOT ? path.resolve(process.env.STORAGE_ROOT) : path.resolve('storage');
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

export function getDataDir(): string {
  const dataDir = path.resolve(getStorageRoot(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

export function getStagingDir(): string {
  const stagingDir = path.resolve(getStorageRoot(), 'staging');
  if (!fs.existsSync(stagingDir)) {
    fs.mkdirSync(stagingDir, { recursive: true });
  }
  return stagingDir;
}

export function resolveSafeStoragePath(storedPath: string): string {
  const storageRoot = getStorageRoot();
  const absPath = path.isAbsolute(storedPath) ? path.resolve(storedPath) : path.resolve(process.cwd(), storedPath);
  const rootPrefix = storageRoot.endsWith(path.sep) ? storageRoot : `${storageRoot}${path.sep}`;

  if (absPath !== storageRoot && !absPath.startsWith(rootPrefix)) {
    throw new ForbiddenError('Security Policy: Access outside configured storage root is prohibited.');
  }

  return absPath;
}
