/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import multer from 'multer';
import path from 'path';
import { env } from '../config/environment.ts';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
]);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadSizeMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isAllowedExt = ['.pdf', '.xlsx', '.xls', '.csv', '.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    if (ALLOWED_MIME_TYPES.has(file.mimetype.toLowerCase()) || isAllowedExt) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Security Policy: Uploaded file type "${file.mimetype || ext}" is not permitted. Only PDF, XLSX, CSV, and image documents are accepted.`
        )
      );
    }
  },
});

export function validateDocumentContent(buffer: Buffer, filename?: string): boolean {
  if (!buffer || buffer.length === 0) return false;
  // PDF magic bytes: %PDF
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return true;
  }
  // PNG
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return true;
  }
  // JPEG
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  // WebP
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return true;
  }
  // Spreadsheets / CSV
  if (filename && /\.(xlsx|xls|csv)$/i.test(filename)) {
    return true;
  }
  // PK ZIP (XLSX)
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return true;
  }
  return false;
}
