/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AppEnvironment {
  nodeEnv: string;
  isProduction: boolean;
  isTest: boolean;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  ocrConcurrency: number;
  maxUploadSizeMb: number;
  storageRoot: string;
  requirePostgres: boolean;
}

const DEFAULT_DEV_JWT_SECRET = 'ske_development_jwt_secret_key_minimum_32_characters_long_2026';

export function loadEnvironment(): AppEnvironment {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  let rawSecret = process.env.JWT_SECRET?.trim() || '';
  if (!rawSecret && !isProduction) {
    rawSecret = DEFAULT_DEV_JWT_SECRET;
    process.env.JWT_SECRET = rawSecret;
  }

  if (!rawSecret || rawSecret.length < 32) {
    throw new Error(
      'FATAL SECURITY ERROR: JWT_SECRET environment variable is missing or shorter than 32 characters.'
    );
  }

  return {
    nodeEnv,
    isProduction,
    isTest,
    port: Number(process.env.PORT) || 3000,
    databaseUrl: (process.env.DATABASE_URL || '').trim(),
    jwtSecret: rawSecret,
    ocrConcurrency: Math.max(1, parseInt(process.env.OCR_CONCURRENCY || '2', 10) || 2),
    maxUploadSizeMb: Math.max(1, parseInt(process.env.MAX_OCR_FILE_SIZE_MB || '50', 10) || 50),
    storageRoot: (process.env.STORAGE_ROOT || 'storage').trim(),
    requirePostgres: process.env.REQUIRE_POSTGRES === 'true',
  };
}

export const env = loadEnvironment();
