/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParseModule = require('pdf-parse');
import type { DocumentCategory, ReviewStatus } from '../src/types/index.ts';

export interface ExtractedFieldResult {
  value: string | number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'MISSING';
  snippet?: string;
}

export interface DocumentExtractionResult {
  category: DocumentCategory;
  rawText: string;
  pageCount: number;
  reviewStatus: ReviewStatus;
  fields: Record<string, ExtractedFieldResult>;
  snippets: string[];
}

async function parsePdfBuffer(buffer: Buffer): Promise<{ text: string; numpages: number }> {
  try {
    if (typeof pdfParseModule === 'function') {
      const res = await pdfParseModule(buffer);
      return { text: res.text || '', numpages: res.numpages || 1 };
    }
    if (pdfParseModule?.PDFParse) {
      const parser = new pdfParseModule.PDFParse({ data: buffer });
      const result = await parser.getText();
      const numpages = result.total || 1;
      const text = result.text || '';
      if (typeof parser.destroy === 'function') {
        await parser.destroy().catch(() => {});
      }
      return { text, numpages };
    }
  } catch (err: any) {
    console.warn('PDF library text extraction warning:', err?.message || err);
  }

  // Fallback: extract plain ASCII/Latin text streams from buffer
  try {
    const raw = buffer.toString('latin1');
    const textMatches = raw.match(/\(([^()]{2,})\)/g);
    if (textMatches && textMatches.length > 0) {
      const combined = textMatches.map((m) => m.slice(1, -1)).join(' ');
      return { text: combined, numpages: 1 };
    }
  } catch (fallbackErr) {
    // Ignore fallback error
  }

  return { text: '', numpages: 1 };
}

export async function extractDocumentData(
  buffer: Buffer,
  category: DocumentCategory,
  originalFilename: string
): Promise<DocumentExtractionResult> {
  const { text: rawText, numpages: pageCount } = await parsePdfBuffer(buffer);


  const fields: Record<string, ExtractedFieldResult> = {};
  const snippets: string[] = [];

  const addSnippet = (label: string, matchText: string) => {
    snippets.push(`${label}: "...${matchText.trim()}..."`);
  };

  switch (category) {
    case 'COMMERCIAL_INVOICE': {
      // 1. Invoice Number
      const invMatch =
        rawText.match(/(?:INVOICE\s*(?:NO|NUMBER|#)?[:.\s]+)([A-Z0-9\/\-_ ]{4,30})/i) ||
        rawText.match(/(SKE[\/\-_ ][0-9A-Z\/\-_ ]{4,20})/i) ||
        rawText.match(/INV[\-_ ][0-9A-Z\/\-_ ]+/i);
      if (invMatch) {
        fields['invoiceNumber'] = {
          value: invMatch[1].trim(),
          confidence: 'HIGH',
          snippet: invMatch[0],
        };
        addSnippet('Invoice No', invMatch[0]);
      } else {
        fields['invoiceNumber'] = { value: null, confidence: 'MISSING' };
      }

      // 2. Invoice Date
      const dateMatch =
        rawText.match(/(?:INVOICE\s*DATE|DATE)[:.\s]+([0-9]{1,2}[-.\/][0-9]{1,2}[-.\/][0-9]{2,4}|[0-9]{4}[-.\/][0-9]{1,2}[-.\/][0-9]{1,2})/i);
      if (dateMatch) {
        fields['invoiceDate'] = {
          value: parseDate(dateMatch[1]),
          confidence: 'HIGH',
          snippet: dateMatch[0],
        };
        addSnippet('Invoice Date', dateMatch[0]);
      } else {
        fields['invoiceDate'] = { value: null, confidence: 'MISSING' };
      }

      // 3. Invoice Total USD
      const usdMatch =
        rawText.match(/(?:TOTAL\s*(?:INVOICE\s*VALUE|AMOUNT)?\s*(?:\(USD\)|USD|\$)[:.\s]+)([0-9,]+\.?[0-9]*)/i) ||
        rawText.match(/(?:USD|\$)\s*([0-9,]+\.[0-9]{2})/i);
      if (usdMatch) {
        const val = parseFloat(usdMatch[1].replace(/,/g, ''));
        fields['invoiceValueUsd'] = {
          value: isNaN(val) ? null : val,
          confidence: isNaN(val) ? 'MISSING' : 'HIGH',
          snippet: usdMatch[0],
        };
        addSnippet('Invoice USD', usdMatch[0]);
      } else {
        fields['invoiceValueUsd'] = { value: null, confidence: 'MISSING' };
      }

      // 4. Package Count
      const pkgMatch = rawText.match(/(?:PACKAGES|TOTAL\s*PKGS|NO\.\s*OF\s*PKGS)[:.\s]+([0-9]+)/i);
      if (pkgMatch) {
        fields['packageCount'] = {
          value: parseInt(pkgMatch[1], 10),
          confidence: 'HIGH',
          snippet: pkgMatch[0],
        };
      } else {
        fields['packageCount'] = { value: null, confidence: 'MISSING' };
      }

      // 5. Port Code
      const portMatch =
        rawText.match(/(INNSA1|INMAA1|INCCU1|INBOM1|INPAV1|INMUN1)/i) ||
        rawText.match(/(?:PORT\s*OF\s*LOADING)[:.\s]+([A-Z0-9\s]{3,20})/i);
      if (portMatch) {
        fields['portCode'] = {
          value: portMatch[1].trim(),
          confidence: 'MEDIUM',
          snippet: portMatch[0],
        };
      } else {
        fields['portCode'] = { value: null, confidence: 'MISSING' };
      }
      break;
    }

    case 'SHIPPING_BILL': {
      // 1. SB Number (usually 7 digits)
      const sbMatch =
        rawText.match(/(?:SHIPPING\s*BILL\s*(?:NO|NUMBER)?[:.\s]+)([0-9]{6,8})/i) ||
        rawText.match(/(?:S\/B\s*NO[:.\s]+)([0-9]{6,8})/i) ||
        rawText.match(/\b([0-9]{7})\b/);
      if (sbMatch) {
        fields['shippingBillNumber'] = {
          value: sbMatch[1],
          confidence: 'HIGH',
          snippet: sbMatch[0],
        };
        addSnippet('SB No', sbMatch[0]);
      } else {
        fields['shippingBillNumber'] = { value: null, confidence: 'MISSING' };
      }

      // 2. SB Date
      const sbDateMatch = rawText.match(
        /(?:SB\s*DATE|DATE\s*OF\s*EXPORT)[:.\s]+([0-9]{1,2}[-.\/][0-9]{1,2}[-.\/][0-9]{2,4}|[0-9]{4}[-.\/][0-9]{1,2}[-.\/][0-9]{1,2})/i
      );
      if (sbDateMatch) {
        fields['shippingBillDate'] = {
          value: parseDate(sbDateMatch[1]),
          confidence: 'HIGH',
          snippet: sbDateMatch[0],
        };
      } else {
        fields['shippingBillDate'] = { value: null, confidence: 'MISSING' };
      }

      // 3. Exchange Rate
      const rateMatch = rawText.match(/(?:EXCHANGE\s*RATE|EX\.\s*RATE|RATE\s*USD)[:.\s]+([0-9]{2,3}\.[0-9]{2,4})/i);
      if (rateMatch) {
        fields['sbExchangeRate'] = {
          value: parseFloat(rateMatch[1]),
          confidence: 'HIGH',
          snippet: rateMatch[0],
        };
      } else {
        fields['sbExchangeRate'] = { value: null, confidence: 'MISSING' };
      }

      // 4. FOB INR
      const fobMatch = rawText.match(/(?:FOB\s*VALUE\s*(?:\(INR\)|INR)?[:.\s]+)([0-9,]+\.?[0-9]*)/i);
      if (fobMatch) {
        fields['fobValueInr'] = {
          value: parseFloat(fobMatch[1].replace(/,/g, '')),
          confidence: 'HIGH',
          snippet: fobMatch[0],
        };
      } else {
        fields['fobValueInr'] = { value: null, confidence: 'MISSING' };
      }

      // 5. Duty Drawback Claimed
      const dbkMatch = rawText.match(/(?:DBK|DRAWBACK\s*AMOUNT)[:.\s]+([0-9,]+\.?[0-9]*)/i);
      if (dbkMatch) {
        fields['dbkClaimed'] = {
          value: parseFloat(dbkMatch[1].replace(/,/g, '')),
          confidence: 'HIGH',
          snippet: dbkMatch[0],
        };
      }

      // 6. RoDTEP Claimed
      const rodtepMatch = rawText.match(/(?:RODTEP\s*(?:AMOUNT)?[:.\s]+)([0-9,]+\.?[0-9]*)/i);
      if (rodtepMatch) {
        fields['rodtepClaimed'] = {
          value: parseFloat(rodtepMatch[1].replace(/,/g, '')),
          confidence: 'HIGH',
          snippet: rodtepMatch[0],
        };
      }

      // 7. RoSCTL Claimed
      const rosctlMatch = rawText.match(/(?:ROSCTL\s*(?:AMOUNT)?[:.\s]+)([0-9,]+\.?[0-9]*)/i);
      if (rosctlMatch) {
        fields['rosctlClaimed'] = {
          value: parseFloat(rosctlMatch[1].replace(/,/g, '')),
          confidence: 'HIGH',
          snippet: rosctlMatch[0],
        };
      }
      break;
    }

    case 'FIRC_PAYMENT': {
      // 1. Inward Remittance Number (IRM)
      const irmMatch =
        rawText.match(/(?:IRM\s*(?:NO|NUMBER)?[:.\s]+)([A-Z0-9]{8,25})/i) ||
        rawText.match(/(?:INWARD\s*REF(?:ERENCE)?[:.\s]+)([A-Z0-9]{8,25})/i) ||
        rawText.match(/\b(IRM[0-9]{6,16})\b/i);
      if (irmMatch) {
        fields['irmNumber'] = {
          value: irmMatch[1].trim().toUpperCase(),
          confidence: 'HIGH',
          snippet: irmMatch[0],
        };
        addSnippet('IRM Number', irmMatch[0]);
      } else {
        fields['irmNumber'] = { value: null, confidence: 'MISSING' };
      }

      // 2. Sender Reference
      const senderMatch =
        rawText.match(/(?:SENDER\s*REF(?:ERENCE)?|ORDERING\s*CUSTOMER\s*REF)[:.\s]+([A-Z0-9\-_]{4,25})/i) ||
        rawText.match(/(?:REMITTER\s*REF)[:.\s]+([A-Z0-9\-_]{4,25})/i);
      if (senderMatch) {
        fields['senderReference'] = {
          value: senderMatch[1].trim(),
          confidence: 'HIGH',
          snippet: senderMatch[0],
        };
      } else {
        fields['senderReference'] = { value: null, confidence: 'MISSING' };
      }

      // 3. Remittance Currency & Verified Amount
      const amtMatch =
        rawText.match(/(?:REMITTED\s*AMOUNT|FOREIGN\s*CURRENCY\s*AMOUNT|USD)[:.\s]+([0-9,]+\.?[0-9]*)/i) ||
        rawText.match(/(?:\$|USD)\s*([0-9,]+\.[0-9]{2})/i);
      if (amtMatch) {
        fields['verifiedAmount'] = {
          value: parseFloat(amtMatch[1].replace(/,/g, '')),
          confidence: 'HIGH',
          snippet: amtMatch[0],
        };
      } else {
        fields['verifiedAmount'] = { value: null, confidence: 'MISSING' };
      }

      // 4. Value Date & Credit Date
      const credDateMatch = rawText.match(
        /(?:CREDIT\s*DATE|DATE\s*OF\s*CREDIT)[:.\s]+([0-9]{1,2}[-.\/][0-9]{1,2}[-.\/][0-9]{2,4}|[0-9]{4}[-.\/][0-9]{1,2}[-.\/][0-9]{1,2})/i
      );
      if (credDateMatch) {
        fields['creditDate'] = {
          value: parseDate(credDateMatch[1]),
          confidence: 'HIGH',
          snippet: credDateMatch[0],
        };
      } else {
        fields['creditDate'] = { value: null, confidence: 'MISSING' };
      }

      const valDateMatch = rawText.match(
        /(?:VALUE\s*DATE)[:.\s]+([0-9]{1,2}[-.\/][0-9]{1,2}[-.\/][0-9]{2,4}|[0-9]{4}[-.\/][0-9]{1,2}[-.\/][0-9]{1,2})/i
      );
      if (valDateMatch) {
        fields['valueDate'] = {
          value: parseDate(valDateMatch[1]),
          confidence: 'HIGH',
          snippet: valDateMatch[0],
        };
      }

      // 5. Realised Exchange Rate & INR Amount
      const exMatch = rawText.match(/(?:CONVERSION\s*RATE|EXCHANGE\s*RATE)[:.\s]+([0-9]{2,3}\.[0-9]{2,4})/i);
      if (exMatch) {
        fields['exchangeRate'] = {
          value: parseFloat(exMatch[1]),
          confidence: 'HIGH',
          snippet: exMatch[0],
        };
      }

      const inrMatch = rawText.match(/(?:INR\s*AMOUNT|NET\s*CREDITED\s*INR)[:.\s]+([0-9,]+\.?[0-9]*)/i);
      if (inrMatch) {
        fields['inrAmount'] = {
          value: parseFloat(inrMatch[1].replace(/,/g, '')),
          confidence: 'HIGH',
          snippet: inrMatch[0],
        };
      }
      break;
    }

    case 'BRC_COPY_1':
    case 'BRC_COPY_2': {
      // BRC Number
      const brcMatch =
        rawText.match(/(?:BRC\s*(?:NO|NUMBER)?|STATEMENT\s*NO)[:.\s]+([A-Z0-9\-_]{6,30})/i) ||
        rawText.match(/\b(BRC-[A-Z0-9\-_]{6,20})\b/i);
      if (brcMatch) {
        fields['brcNumber'] = {
          value: brcMatch[1].trim(),
          confidence: 'HIGH',
          snippet: brcMatch[0],
        };
      } else {
        fields['brcNumber'] = { value: null, confidence: 'MISSING' };
      }

      // Issue Date
      const issueDateMatch = rawText.match(
        /(?:DATE\s*OF\s*ISSUE|ISSUE\s*DATE)[:.\s]+([0-9]{1,2}[-.\/][0-9]{1,2}[-.\/][0-9]{2,4}|[0-9]{4}[-.\/][0-9]{1,2}[-.\/][0-9]{1,2})/i
      );
      if (issueDateMatch) {
        fields['issueDate'] = {
          value: parseDate(issueDateMatch[1]),
          confidence: 'HIGH',
          snippet: issueDateMatch[0],
        };
      }

      // Realisation Date
      const realDateMatch = rawText.match(
        /(?:REALIS?ATION\s*DATE|DATE\s*OF\s*REALIS?ATION)[:.\s]+([0-9]{1,2}[-.\/][0-9]{1,2}[-.\/][0-9]{2,4}|[0-9]{4}[-.\/][0-9]{1,2}[-.\/][0-9]{1,2})/i
      );
      if (realDateMatch) {
        fields['realisationDate'] = {
          value: parseDate(realDateMatch[1]),
          confidence: 'HIGH',
          snippet: realDateMatch[0],
        };
      }

      // Realised Amount
      const realAmtMatch = rawText.match(/(?:REALISED\s*AMOUNT|NET\s*REALISED)[:.\s]+([0-9,]+\.?[0-9]*)/i);
      if (realAmtMatch) {
        fields['realisedAmount'] = {
          value: parseFloat(realAmtMatch[1].replace(/,/g, '')),
          confidence: 'HIGH',
          snippet: realAmtMatch[0],
        };
      }
      break;
    }

    case 'BILL_OF_LADING': {
      // BL Number
      const blMatch = rawText.match(/(?:B\/L\s*NO|BILL\s*OF\s*LADING\s*NO)[:.\s]+([A-Z0-9\-_]{6,25})/i);
      if (blMatch) {
        fields['blNumber'] = {
          value: blMatch[1].trim(),
          confidence: 'HIGH',
          snippet: blMatch[0],
        };
      } else {
        fields['blNumber'] = { value: null, confidence: 'MISSING' };
      }

      // Vessel Name
      const vesselMatch = rawText.match(/(?:VESSEL\s*(?:\/\s*VOYAGE)?|OCEAN\s*VESSEL)[:.\s]+([A-Z0-9\s.\-_]{4,30})/i);
      if (vesselMatch) {
        fields['vesselName'] = {
          value: vesselMatch[1].trim(),
          confidence: 'HIGH',
          snippet: vesselMatch[0],
        };
      }
      break;
    }
  }

  // Determine overall review status
  const hasMissing = Object.values(fields).some((f) => f.confidence === 'MISSING');
  const reviewStatus: ReviewStatus = hasMissing ? 'NEEDS_REVIEW' : 'EXTRACTED';

  return {
    category,
    rawText: rawText.slice(0, 5000), // preserve first 5k characters for review snippet
    pageCount,
    reviewStatus,
    fields,
    snippets,
  };
}

function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const parts = dateStr.replace(/[\/\.]/g, '-').split('-');
  if (parts.length !== 3) return null;

  // If YYYY-MM-DD
  if (parts[0].length === 4) {
    return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  }

  // DD-MM-YYYY
  if (parts[2].length === 4) {
    return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }

  // DD-MM-YY
  if (parts[2].length === 2) {
    return `20${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }

  return null;
}
