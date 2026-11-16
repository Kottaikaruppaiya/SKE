/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDataDir } from '../config/storage.ts';
import { createInitialSeedState, type PersistedDatabaseState } from '../../prisma/seedData.ts';

class JsonPersistenceStore {
  private state: PersistedDatabaseState | null = null;
  private activeLocks = new Set<string>();

  private getDbFilePath(): string {
    return path.resolve(getDataDir(), 'db.json');
  }

  public getState(): PersistedDatabaseState {
    if (!this.state) {
      this.state = this.loadOrInitialize();
    }
    return this.state;
  }

  public reloadFromDisk(): PersistedDatabaseState {
    this.state = this.loadOrInitialize();
    return this.state;
  }

  public save(): void {
    if (!this.state) return;
    this.persist(this.state);
  }

  public replaceState(nextState: PersistedDatabaseState): void {
    this.state = nextState;
    this.persist(nextState);
  }

  public async runInTransaction<T>(fn: () => Promise<T> | T): Promise<T> {
    const snapshot = structuredClone(this.getState());
    try {
      const result = await fn();
      this.save();
      return result;
    } catch (err) {
      this.state = snapshot;
      this.save();
      throw err;
    }
  }

  public acquireLock(key: string): boolean {
    if (this.activeLocks.has(key)) return false;
    this.activeLocks.add(key);
    return true;
  }

  public releaseLock(key: string): void {
    this.activeLocks.delete(key);
  }

  private loadOrInitialize(): PersistedDatabaseState {
    const dbFile = this.getDbFilePath();
    if (fs.existsSync(dbFile)) {
      try {
        const raw = fs.readFileSync(dbFile, 'utf-8');
        const parsed = JSON.parse(raw);
        if (
          parsed.shipments &&
          parsed.shipments.length > 0 &&
          parsed.consignees?.some((c: any) => c.name.includes('S K Global'))
        ) {
          if (!Array.isArray(parsed.ocrJobs)) parsed.ocrJobs = [];
          if (!Array.isArray(parsed.revokedTokens)) parsed.revokedTokens = [];
          if (!Array.isArray(parsed.gstEntries)) parsed.gstEntries = [];
          if (!Array.isArray(parsed.suppliers)) parsed.suppliers = [];
          if (!Array.isArray(parsed.b2bInvoices)) parsed.b2bInvoices = [];
          if (!Array.isArray(parsed.importBatches)) parsed.importBatches = [];
          if (parsed.auditLogs) delete parsed.auditLogs;

          if (parsed.b2bInvoices.length === 0) {
            const seed = createInitialSeedState();
            parsed.suppliers = seed.suppliers;
            parsed.b2bInvoices = seed.b2bInvoices;
            parsed.importBatches = seed.importBatches;
          }
          return parsed;
        }
      } catch (err) {
        console.error('[JsonPersistence] Failed reading db.json, re-initializing:', err);
      }
    }

    const defaultState = createInitialSeedState();
    this.persist(defaultState);
    return defaultState;
  }

  private persist(state: PersistedDatabaseState): void {
    const dbFile = this.getDbFilePath();
    const tempFile = `${dbFile}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tempFile, dbFile);
  }
}

export const jsonStore = new JsonPersistenceStore();
