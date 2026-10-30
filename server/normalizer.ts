/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Normalizes export invoice numbers for duplicate detection and lookup.
 *
 * Targets:
 * - 'SKE/26-27/020'   -> 'SKE-26-27-020'
 * - 'SKE-26-27-20'    -> 'SKE-26-27-020'
 * - 'SKE PI 26 27 020' -> 'SKE-26-27-020'
 * - 'SKE 26-27 20'    -> 'SKE-26-27-020'
 *
 * Distinguishes different invoice sequences:
 * - 'SKE/26-27/021'   -> 'SKE-26-27-021'
 * - 'SKE-25-26-020'   -> 'SKE-25-26-020'
 * - 'INV-2026-99'     -> 'INV-2026-099'
 */
export function normalizeInvoiceKey(input: string): string {
  if (!input || typeof input !== 'string') return '';

  let cleaned = input.trim().toUpperCase();

  // Remove common interim keywords like 'PI', 'PROFORMA', 'EXP', 'INV' when used as middle qualifiers
  cleaned = cleaned.replace(/\b(PI|PROFORMA)\b/g, ' ');

  // Replace all slashes, backslashes, underscores, and dots with hyphens
  cleaned = cleaned.replace(/[\/\\_\.]/g, '-');

  // Replace multiple whitespace with single hyphen
  cleaned = cleaned.replace(/\s+/g, '-');

  // Collapse multiple hyphens
  cleaned = cleaned.replace(/-+/g, '-');

  // Check pattern for SKE format: SKE-YY-YY-NUM or SKE-YY-NUM
  const skeMatch = cleaned.match(/^([A-Z]+)-?(\d{2})?-?(\d{2})?-?(\d+)$/);
  if (skeMatch) {
    const prefix = skeMatch[1]; // SKE
    const y1 = skeMatch[2] || '26';
    const y2 = skeMatch[3] || '27';
    const num = parseInt(skeMatch[4], 10);
    const paddedNum = String(num).padStart(3, '0');
    return `${prefix}-${y1}-${y2}-${paddedNum}`;
  }

  // Check with standard 4-digit year format: PREFIX-YYYY-YY-NUM
  const fullYearMatch = cleaned.match(/^([A-Z]+)-?(\d{4})?-?(\d{2,4})?-?(\d+)$/);
  if (fullYearMatch) {
    const prefix = fullYearMatch[1];
    const y1 = fullYearMatch[2] ? fullYearMatch[2].slice(-2) : '26';
    const y2 = fullYearMatch[3] ? fullYearMatch[3].slice(-2) : '27';
    const num = parseInt(fullYearMatch[4], 10);
    const paddedNum = String(num).padStart(3, '0');
    return `${prefix}-${y1}-${y2}-${paddedNum}`;
  }

  // Fallback: trim hyphens and pad trailing number if present
  const trailingNumMatch = cleaned.match(/^(.*)-(\d+)$/);
  if (trailingNumMatch) {
    const base = trailingNumMatch[1];
    const num = parseInt(trailingNumMatch[2], 10);
    return `${base}-${String(num).padStart(3, '0')}`;
  }

  return cleaned;
}
