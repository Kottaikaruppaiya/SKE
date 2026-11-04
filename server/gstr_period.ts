/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const MONTH_MAP: Record<string, number> = {
  january: 1,
  jan: 1,
  '01': 1,
  '1': 1,
  february: 2,
  feb: 2,
  '02': 2,
  '2': 2,
  march: 3,
  mar: 3,
  '03': 3,
  '3': 3,
  april: 4,
  apr: 4,
  '04': 4,
  '4': 4,
  may: 5,
  '05': 5,
  '5': 5,
  june: 6,
  jun: 6,
  '06': 6,
  '6': 6,
  july: 7,
  jul: 7,
  '07': 7,
  '7': 7,
  august: 8,
  aug: 8,
  '08': 8,
  '8': 8,
  september: 9,
  sep: 9,
  sept: 9,
  '09': 9,
  '9': 9,
  october: 10,
  oct: 10,
  '10': 10,
  november: 11,
  nov: 11,
  '11': 11,
  december: 12,
  dec: 12,
  '12': 12,
};

export interface NormalizedPeriod {
  periodKey: string;     // e.g. "2026-08"
  displayPeriod: string; // e.g. "August 2026"
  financialYear: string; // e.g. "2026-27"
  year: number;          // 2026
  month: number;         // 8
}

/**
 * Normalizes any GSTR Period string into canonical periodKey (YYYY-MM),
 * displayPeriod (Month YYYY), and Indian financial year (YYYY-YY).
 * Strict: Never guesses period from invoice or upload date.
 * Returns null if missing or invalid.
 */
export function normalizeGstrPeriod(rawPeriod: any): NormalizedPeriod | null {
  if (rawPeriod === undefined || rawPeriod === null) return null;
  const str = String(rawPeriod).trim();
  if (!str) return null;

  let year: number | null = null;
  let month: number | null = null;

  // Case 0: Date object or string starting with day name (parsed by XLSX cellDates)
  if (rawPeriod instanceof Date && !isNaN(rawPeriod.getTime())) {
    year = rawPeriod.getUTCFullYear();
    month = rawPeriod.getUTCMonth() + 1;
  } else if (/^[a-zA-Z]{3}\s+[a-zA-Z]{3}\s+\d{1,2}\s+\d{4}/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      year = d.getUTCFullYear();
      month = d.getUTCMonth() + 1;
    }
  }

  // Case 1: MMYYYY (e.g. "082026") or YYYYMM (e.g. "202608")
  if (/^\d{6}$/.test(str)) {
    const firstTwo = parseInt(str.slice(0, 2), 10);
    const lastFour = parseInt(str.slice(2), 10);
    if (firstTwo >= 1 && firstTwo <= 12 && lastFour >= 2000 && lastFour <= 2100) {
      month = firstTwo;
      year = lastFour;
    } else {
      const firstFour = parseInt(str.slice(0, 4), 10);
      const lastTwo = parseInt(str.slice(4), 10);
      if (firstFour >= 2000 && firstFour <= 2100 && lastTwo >= 1 && lastTwo <= 12) {
        year = firstFour;
        month = lastTwo;
      }
    }
  }

  // Case 2: "YYYY-MM" or "YYYY/MM"
  if (!year && /^\d{4}[-\/]\d{1,2}$/.test(str)) {
    const parts = str.split(/[-\/]/);
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
  }

  // Case 3: "MM-YYYY" or "MM/YYYY"
  if (!year && /^\d{1,2}[-\/]\d{4}$/.test(str)) {
    const parts = str.split(/[-\/]/);
    month = parseInt(parts[0], 10);
    year = parseInt(parts[1], 10);
  }

  // Case 4: Word + Year, e.g. "August 2026", "Aug 2026", "August-2026", "Aug-26"
  if (!year) {
    const cleaned = str.replace(/[-–,\/]/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = cleaned.split(' ');
    if (parts.length === 2) {
      const part1 = parts[0].toLowerCase();
      const part2 = parts[1].toLowerCase();

      if (MONTH_MAP[part1] !== undefined) {
        month = MONTH_MAP[part1];
        let y = parseInt(part2, 10);
        if (!isNaN(y)) {
          if (y < 100) y += 2000;
          if (y >= 2000 && y <= 2100) year = y;
        }
      } else if (MONTH_MAP[part2] !== undefined) {
        month = MONTH_MAP[part2];
        let y = parseInt(part1, 10);
        if (!isNaN(y)) {
          if (y < 100) y += 2000;
          if (y >= 2000 && y <= 2100) year = y;
        }
      }
    }
  }

  if (!year || !month || month < 1 || month > 12) {
    return null;
  }

  const mm = String(month).padStart(2, '0');
  const periodKey = `${year}-${mm}`;
  const displayPeriod = `${MONTH_NAMES[month - 1]} ${year}`;

  const fyStart = month >= 4 ? year : year - 1;
  const fyEnd = (fyStart + 1).toString().slice(2);
  const financialYear = `${fyStart}-${fyEnd}`;

  return {
    periodKey,
    displayPeriod,
    financialYear,
    year,
    month,
  };
}

export const parseGstrPeriod = normalizeGstrPeriod;

/**
 * Returns all 12 standard months for an Indian financial year in chronological order.
 * e.g. "2026-27" -> [2026-04, 2026-05, ..., 2027-03]
 */
export function getMonthsForFinancialYear(fy: string): Array<{ periodKey: string; displayPeriod: string }> {
  const parts = fy.split('-');
  const startYear = parseInt(parts[0], 10);
  if (isNaN(startYear)) return [];

  const result: Array<{ periodKey: string; displayPeriod: string }> = [];
  // April to December of startYear
  for (let m = 4; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    result.push({
      periodKey: `${startYear}-${mm}`,
      displayPeriod: `${MONTH_NAMES[m - 1]} ${startYear}`,
    });
  }
  // January to March of startYear + 1
  const nextYear = startYear + 1;
  for (let m = 1; m <= 3; m++) {
    const mm = String(m).padStart(2, '0');
    result.push({
      periodKey: `${nextYear}-${mm}`,
      displayPeriod: `${MONTH_NAMES[m - 1]} ${nextYear}`,
    });
  }
  return result;
}
