/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';

// Configure test environment variables prior to importing application modules
process.env.NODE_ENV = 'test';
process.env.STORAGE_ROOT = path.resolve('storage_test');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ske_test_jwt_secure_secret_key_minimum_32_chars_2026';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://ske_user:ske_secure_password_2026@localhost:5432/ske_test?schema=public';
process.env.OCR_CONCURRENCY = '1';
process.env.MAX_OCR_FILE_SIZE_MB = '50';
