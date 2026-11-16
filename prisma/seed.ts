/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PrismaClient } from '@prisma/client';
import { createInitialSeedState } from './seedData.ts';

export async function seedPrismaDatabase(prisma: PrismaClient, options?: { preserveUsersAndSettings?: boolean }) {
  const seed = createInitialSeedState();

  await prisma.$transaction(async (tx) => {
    if (!options?.preserveUsersAndSettings) {
      for (const user of seed.users) {
        await tx.user.upsert({
          where: { email: user.email },
          update: {},
          create: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            isActive: user.isActive,
            mustChangePassword: Boolean(user.mustChangePassword),
            passwordHash: user.passwordHash || '',
          },
        });
      }
    }

    for (const fy of seed.financialYears) {
      await tx.financialYear.upsert({
        where: { label: fy.label },
        update: {
          startDate: new Date(fy.startDate),
          endDate: new Date(fy.endDate),
          isCurrent: fy.isCurrent,
        },
        create: {
          id: fy.id,
          label: fy.label,
          startDate: new Date(fy.startDate),
          endDate: new Date(fy.endDate),
          isCurrent: fy.isCurrent,
        },
      });
    }

    for (const c of seed.consignees) {
      await tx.consigneeMaster.upsert({
        where: { name: c.name },
        update: {},
        create: {
          id: c.id,
          name: c.name,
          country: c.country,
          portOfDischarge: c.portOfDischarge || null,
          paymentTerms: c.paymentTerms || null,
          currency: c.currency || 'USD',
          contactEmail: c.contactEmail || null,
          isActive: c.isActive,
        },
      });
    }

    for (const b of seed.banks) {
      await tx.bankMaster.upsert({
        where: { name: b.name },
        update: {},
        create: {
          id: b.id,
          name: b.name,
          branch: b.branch || null,
          adCode: b.adCode || null,
          ifscCode: b.ifscCode || null,
          swiftCode: b.swiftCode || null,
          accountNumber: b.accountNumber || null,
          isActive: b.isActive,
        },
      });
    }

    for (const s of seed.shipments) {
      await tx.shipment.upsert({
        where: { id: s.id },
        update: {},
        create: {
          id: s.id,
          financialYearId: s.financialYearId,
          invoiceNumber: s.invoiceNumber,
          normalizedInvoiceKey: s.normalizedInvoiceKey,
          invoiceDate: new Date(s.invoiceDate),
          consigneeId: s.consigneeId,
          portCode: s.portCode,
          packageCount: s.packageCount ?? 0,
          invoiceValueUsd: s.invoiceValueUsd,
          shippingBillNumber: s.shippingBillNumber,
          shippingBillDate: new Date(s.shippingBillDate),
          sbExchangeRate: s.sbExchangeRate,
          fobValueInr: s.fobValueInr,
          blNumber: s.blNumber || null,
          blDate: s.blDate ? new Date(s.blDate) : null,
          vesselName: s.vesselName || null,
          paymentStatus: s.paymentStatus,
          reviewStatus: s.reviewStatus,
          remarks: s.remarks || null,
          isArchived: Boolean(s.isArchived),
        },
      });
    }

    for (const item of seed.invoiceItems) {
      await tx.invoiceItem.upsert({
        where: { id: item.id },
        update: {},
        create: {
          id: item.id,
          shipmentId: item.shipmentId,
          description: item.description,
          hsnCode: item.hsnCode || null,
          quantity: item.quantity,
          unit: item.unit,
          rateUsd: item.rateUsd,
          amountUsd: item.amountUsd,
        },
      });
    }

    for (const p of seed.payments) {
      await tx.payment.upsert({
        where: { irmNumber: p.irmNumber },
        update: {},
        create: {
          id: p.id,
          irmNumber: p.irmNumber,
          senderReference: p.senderReference || null,
          currency: p.currency,
          verifiedAmount: p.verifiedAmount,
          inrAmount: p.inrAmount ?? null,
          exchangeRate: p.exchangeRate ?? null,
          valueDate: new Date(p.valueDate),
          creditDate: new Date(p.creditDate),
          fircIssueDate: p.fircIssueDate ? new Date(p.fircIssueDate) : null,
          bankId: p.bankId,
          purposeCode: p.purposeCode || 'P0102',
          remarks: p.remarks || null,
        },
      });
    }

    for (const a of seed.allocations) {
      await tx.paymentAllocation.upsert({
        where: { id: a.id },
        update: {},
        create: {
          id: a.id,
          paymentId: a.paymentId,
          shipmentId: a.shipmentId,
          allocatedAmountUsd: a.allocatedAmountUsd,
          notes: a.notes || null,
          allocatedAt: new Date(a.allocatedAt),
          allocatedByUserId: a.allocatedByUserId,
        },
      });
    }

    for (const inc of seed.incentives) {
      await tx.incentiveRecord.upsert({
        where: { id: inc.id },
        update: {},
        create: {
          id: inc.id,
          shipmentId: inc.shipmentId,
          type: inc.type,
          claimedAmount: inc.claimedAmount,
          status: inc.status,
          receivedAmount: inc.receivedAmount,
          receivedDate: inc.receivedDate ? new Date(inc.receivedDate) : null,
          scrollNumber: inc.scrollNumber || null,
          remarks: inc.remarks || null,
        },
      });
    }

    for (const brc of seed.brcRecords) {
      await tx.brcRecord.upsert({
        where: { shipmentId: brc.shipmentId },
        update: {},
        create: {
          id: brc.id,
          shipmentId: brc.shipmentId,
          brcNumber: brc.brcNumber || null,
          issueDate: brc.issueDate ? new Date(brc.issueDate) : null,
          realisationDate: brc.realisationDate ? new Date(brc.realisationDate) : null,
          realisedAmount: brc.realisedAmount ?? null,
          realisedCurrency: brc.realisedCurrency || 'USD',
          uploadMode: brc.uploadMode,
          statutoryDeadline: brc.statutoryDeadline ? new Date(brc.statutoryDeadline) : null,
          status: brc.status,
          remarks: brc.remarks || null,
        },
      });
    }

    for (const doc of seed.documents) {
      await tx.document.upsert({
        where: { id: doc.id },
        update: {},
        create: {
          id: doc.id,
          shipmentId: doc.shipmentId || null,
          paymentId: doc.paymentId || null,
          category: doc.category,
          originalFilename: doc.originalFilename,
          storedPath: doc.storedPath,
          mimeType: doc.mimeType,
          fileSizeBytes: BigInt(doc.fileSizeBytes),
          version: doc.version,
          isCurrent: doc.isCurrent,
          reviewStatus: doc.reviewStatus,
          uploadedByUserId: doc.uploadedByUserId,
        },
      });
    }

    for (const gst of seed.gstEntries) {
      await tx.gstEntry.upsert({
        where: { entryNumber: gst.id },
        update: {},
        create: {
          id: gst.id,
          entryNumber: gst.id,
          entryDate: new Date(gst.entryDate),
          consigneeId: gst.consigneeId,
          igst: gst.igst,
          cgst: gst.cgst,
          sgst: gst.sgst,
          totalGst: gst.totalGst,
          refundEligible: gst.refundEligible,
          difference: gst.difference,
          result: gst.result,
          remarks: gst.remarks || null,
        },
      });
    }

    for (const sup of seed.suppliers) {
      await tx.supplier.upsert({
        where: { gstin: sup.gstin },
        update: {},
        create: {
          id: sup.id,
          gstin: sup.gstin,
          legalName: sup.legalName,
          tradeName: sup.tradeName || null,
          address: sup.address || null,
          state: sup.state || null,
        },
      });
    }

    for (const inv of seed.b2bInvoices) {
      await tx.b2bInvoice.upsert({
        where: {
          supplierGstin_invoiceNumber_invoiceType: {
            supplierGstin: inv.supplierGstin,
            invoiceNumber: inv.invoiceNumber,
            invoiceType: inv.invoiceType,
          },
        },
        update: {},
        create: {
          id: inv.id,
          supplierId: inv.supplierId,
          supplierGstin: inv.supplierGstin,
          supplierName: inv.supplierName,
          invoiceNumber: inv.invoiceNumber,
          invoiceType: inv.invoiceType,
          invoiceDate: new Date(inv.invoiceDate),
          invoiceValue: inv.invoiceValue,
          placeOfSupply: inv.placeOfSupply || null,
          reverseCharge: inv.reverseCharge,
          taxableValue: inv.taxableValue,
          integratedTax: inv.integratedTax,
          centralTax: inv.centralTax,
          stateUtTax: inv.stateUtTax,
          cess: inv.cess,
          totalGst: inv.totalGst,
          gstrPeriod: inv.gstrPeriod,
          periodKey: inv.periodKey,
          financialYear: inv.financialYear,
          filingDate: inv.filingDate ? new Date(inv.filingDate) : null,
          itcAvailability: inv.itcAvailability,
          reason: inv.reason || null,
          applicableTaxRate: inv.applicableTaxRate ?? 100,
          source: inv.source || 'GSTR-1',
          irn: inv.irn || null,
          irnDate: inv.irnDate ? new Date(inv.irnDate) : null,
        },
      });
    }

    if (!options?.preserveUsersAndSettings) {
      for (const [key, value] of Object.entries(seed.settings)) {
        await tx.appSetting.upsert({
          where: { key },
          update: {},
          create: {
            key,
            value: String(value),
          },
        });
      }
    }
  });
}

// Execute standalone when run directly via `npx tsx prisma/seed.ts`
const isDirectRun = process.argv[1]?.endsWith('seed.ts');
if (isDirectRun) {
  const prisma = new PrismaClient();
  seedPrismaDatabase(prisma)
    .then(() => {
      console.log('[Prisma Seed] Seeded PostgreSQL database successfully.');
    })
    .catch((err) => {
      console.error('[Prisma Seed] Failed:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
