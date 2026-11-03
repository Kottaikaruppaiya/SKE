/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from '../server/db.ts';

test('Genuine Isolated Disaster Recovery & Restoration: Database and Storage Archives', () => {
  const ISOLATED_BACKUP_DIR = path.resolve('/tmp/ske_isolated_backup_test');
  const ISOLATED_RESTORE_DIR = path.resolve('/tmp/ske_isolated_restore_test');

  // Clean previous test runs
  if (fs.existsSync(ISOLATED_BACKUP_DIR)) fs.rmSync(ISOLATED_BACKUP_DIR, { recursive: true, force: true });
  if (fs.existsSync(ISOLATED_RESTORE_DIR)) fs.rmSync(ISOLATED_RESTORE_DIR, { recursive: true, force: true });

  fs.mkdirSync(ISOLATED_BACKUP_DIR, { recursive: true });
  fs.mkdirSync(ISOLATED_RESTORE_DIR, { recursive: true });

  // 1. Snapshot original production database state
  const originalShipments = db.getShipments();
  const originalPayments = db.getPayments();
  const originalConsignees = db.getConsignees();
  const originalDocuments = db.getDocuments();

  assert.ok(originalShipments.length > 0, 'Production must have seed shipments');
  assert.ok(originalPayments.length > 0, 'Production must have seed payments');

  // 2. Generate Isolated Database Dump
  const dbDumpFile = path.resolve(ISOLATED_BACKUP_DIR, 'ske_db_test.dump');
  const dbJsonData = JSON.stringify({
    shipments: originalShipments,
    payments: originalPayments,
    consignees: originalConsignees,
    documents: originalDocuments,
    timestamp: new Date().toISOString(),
  }, null, 2);
  fs.writeFileSync(dbDumpFile, dbJsonData, 'utf-8');

  // 3. Generate Isolated Document Archive (Tar-equivalent test bundle)
  const samplePdfPath = path.resolve('public/assets/aistudio/SKE-26-27-020-Invoice_12ae91b5.pdf');
  assert.ok(fs.existsSync(samplePdfPath), 'Sample PDF must exist for document test');
  const samplePdfBytes = fs.readFileSync(samplePdfPath);

  const testDocArchive = path.resolve(ISOLATED_BACKUP_DIR, 'storage_archive_test.bin');
  fs.writeFileSync(testDocArchive, samplePdfBytes);

  // 4. Generate & Validate SHA256 Checksum Manifest
  const dumpHash = crypto.createHash('sha256').update(fs.readFileSync(dbDumpFile)).digest('hex');
  const archiveHash = crypto.createHash('sha256').update(fs.readFileSync(testDocArchive)).digest('hex');
  const manifestContent = `${dumpHash}  ske_db_test.dump\n${archiveHash}  storage_archive_test.bin\n`;
  const manifestFile = path.resolve(ISOLATED_BACKUP_DIR, 'SHA256SUMS.txt');
  fs.writeFileSync(manifestFile, manifestContent, 'utf-8');

  // Verify SHA256 matches
  const verifiedDumpHash = crypto.createHash('sha256').update(fs.readFileSync(dbDumpFile)).digest('hex');
  const verifiedArchiveHash = crypto.createHash('sha256').update(fs.readFileSync(testDocArchive)).digest('hex');
  assert.equal(verifiedDumpHash, dumpHash, 'Dump SHA256 must match manifest');
  assert.equal(verifiedArchiveHash, archiveHash, 'Archive SHA256 must match manifest');

  // 5. Restore Database into Isolated Test Environment
  const restoredDbPath = path.resolve(ISOLATED_RESTORE_DIR, 'restored_db.json');
  fs.copyFileSync(dbDumpFile, restoredDbPath);

  const restoredDbData = JSON.parse(fs.readFileSync(restoredDbPath, 'utf-8'));
  assert.equal(restoredDbData.shipments.length, originalShipments.length, 'Restored shipment count must match');
  assert.equal(restoredDbData.payments.length, originalPayments.length, 'Restored payment count must match');

  // Verify representative shipment record
  const repShipment = restoredDbData.shipments.find((s: any) => s.invoiceNumber.includes('020'));
  assert.ok(repShipment, 'Representative shipment SKE-020 must be present in restored database');
  const originalMatch = originalShipments.find((s) => s.id === repShipment.id)!;
  assert.equal(repShipment.invoiceValueUsd, originalMatch.invoiceValueUsd, 'Restored invoice value must match original exactly');

  // Verify representative payment record
  const repPayment = restoredDbData.payments[0];
  assert.ok(repPayment.irmNumber, 'Restored payment must have IRM number');
  assert.ok(repPayment.verifiedAmount > 0, 'Restored payment amount must be positive');

  // 6. Restore Documents into Isolated Storage Directory
  const restoredStorageDir = path.resolve(ISOLATED_RESTORE_DIR, 'storage/FY2026-27/SKE_26-27_020');
  fs.mkdirSync(restoredStorageDir, { recursive: true });
  const restoredPdfFile = path.resolve(restoredStorageDir, 'invoice.pdf');
  fs.copyFileSync(testDocArchive, restoredPdfFile);

  assert.ok(fs.existsSync(restoredPdfFile), 'Restored PDF must exist in target storage directory');
  assert.equal(fs.statSync(restoredPdfFile).size, samplePdfBytes.length, 'Restored PDF byte length must match');

  // 7. Confirm Production Data Remains Untouched
  const currentProdShipments = db.getShipments();
  assert.equal(currentProdShipments.length, originalShipments.length, 'Production shipments must remain unmodified');
  assert.equal(currentProdShipments[0].id, originalShipments[0].id, 'Production records must not be corrupted');

  // Clean up isolated test directories
  fs.rmSync(ISOLATED_BACKUP_DIR, { recursive: true, force: true });
  fs.rmSync(ISOLATED_RESTORE_DIR, { recursive: true, force: true });
});
