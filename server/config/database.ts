/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PrismaClient } from '@prisma/client';
import { env } from './environment.ts';
import { seedPrismaDatabase } from '../../prisma/seed.ts';

let prismaInstance: PrismaClient | null = null;
let postgresActive = false;
let initialized = false;

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      log: env.nodeEnv === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return prismaInstance;
}

export function isPostgresActive(): boolean {
  return postgresActive;
}

export async function initializeDatabase(): Promise<{ mode: 'postgresql' | 'json-fallback' }> {
  if (initialized) {
    return { mode: postgresActive ? 'postgresql' : 'json-fallback' };
  }

  const shouldTryPostgres = Boolean(env.databaseUrl) && !env.isTest;
  if (shouldTryPostgres || env.requirePostgres) {
    try {
      const prisma = getPrismaClient();
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      postgresActive = true;
      initialized = true;

      // Auto-seed PostgreSQL on first boot if financialYears or users are empty
      const userCount = await prisma.user.count();
      if (userCount === 0) {
        await seedPrismaDatabase(prisma);
      }

      console.log('[Database] Connected to PostgreSQL 16 via Prisma ORM.');
      return { mode: 'postgresql' };
    } catch (err: any) {
      if (env.requirePostgres) {
        throw new Error(
          `PostgreSQL connection failed with REQUIRE_POSTGRES=true: ${err?.message || err}`
        );
      }
      console.warn(
        '[Database] PostgreSQL not reachable in local environment; falling back to transactional local JSON store:',
        err?.message || err
      );
    }
  }

  postgresActive = false;
  initialized = true;
  return { mode: 'json-fallback' };
}

export async function checkDatabaseHealth(): Promise<{ status: 'ok' | 'degraded'; engine: string }> {
  if (postgresActive && prismaInstance) {
    try {
      await prismaInstance.$queryRaw`SELECT 1`;
      return { status: 'ok', engine: 'postgresql-prisma' };
    } catch {
      return { status: 'degraded', engine: 'postgresql-prisma' };
    }
  }
  return { status: 'ok', engine: 'json-fallback' };
}

export async function disconnectDatabase(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
  postgresActive = false;
  initialized = false;
}
