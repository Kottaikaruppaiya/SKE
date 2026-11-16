import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/db.ts';

test('CRUD & Data Sync: Shipment Update, Recalculation & Allocation Guards', async () => {
  const shipments = await db.getShipments({});
  assert.ok(shipments.length > 0, 'Shipments must exist in database');

  const testShipment = shipments.find(s => s.invoiceNumber === 'SKE/26-27/020') || shipments[0];
  const originalUsd = testShipment.invoiceValueUsd;
  const originalRate = testShipment.sbExchangeRate;
  const originalFob = testShipment.fobValueInr;

  // 1. Updating exchange rate triggers auto-recalculation of FOB INR
  const newRate = 85.5;
  const updated1 = await db.updateShipment(testShipment.id, {
    sbExchangeRate: newRate,
  }, 'user-admin-1');

  assert.equal(updated1.sbExchangeRate, 85.5);
  const expectedFob = Math.round(testShipment.invoiceValueUsd * 85.5 * 100) / 100;
  assert.equal(updated1.fobValueInr, expectedFob);

  // 2. Cannot reduce invoiceValueUsd below active allocated amount
  const allocated = testShipment.totalPaidUsd || 0;
  if (allocated > 0) {
    await assert.rejects(
      async () => {
        await db.updateShipment(testShipment.id, {
          invoiceValueUsd: allocated - 100,
        }, 'user-admin-1');
      },
      /Cannot reduce Invoice Value.*below already allocated payment amount/i
    );
  }

  // Restore original state
  await db.updateShipment(testShipment.id, {
    sbExchangeRate: originalRate,
    fobValueInr: originalFob,
  }, 'user-admin-1');
});

test('Dependency Protection: deleteShipment blocks deletion of shipment with active allocations or BRC', async () => {
  const shipments = await db.getShipments({});
  const activeShipment = shipments.find(s => (s.allocations && s.allocations.length > 0) || (s.totalPaidUsd ?? 0) > 0);

  if (activeShipment) {
    // Attempting to delete must throw a clear dependency error
    await assert.rejects(
      async () => {
        await db.deleteShipment(activeShipment.id, 'user-admin-1');
      },
      /Cannot delete shipment.*active FIRC payment allocations/i
    );
  }
});

test('Archival & Restoration Workflow: Preserves financial dependencies safely', async () => {
  // Create a temporary shipment to test clean delete vs archive
  const consignees = await db.getConsignees();
  await assert.rejects(
    async () => {
      await db.createShipment({
        financialYearId: 'fy-2026-27',
        invoiceNumber: 'SKE/26-27/NO-FIRC-REJECT',
        invoiceDate: '2026-11-01',
        consigneeId: consignees[0].id,
        portCode: 'INNSA1',
        packageCount: 10,
        invoiceValueUsd: 5000,
        shippingBillNumber: 'SB-TEST-998',
        shippingBillDate: '2026-11-02',
        sbExchangeRate: 84.5,
        fobValueInr: 422500,
      }, 'user-admin-1');
    },
    /Mandatory Rule Violation.*FIRC/i
  );

  const tempShipment = await db.createShipment({
    financialYearId: 'fy-2026-27',
    invoiceNumber: 'SKE/26-27/TEST-ARCHIVE',
    invoiceDate: '2026-11-01',
    consigneeId: consignees[0].id,
    portCode: 'INNSA1',
    packageCount: 10,
    invoiceValueUsd: 5000,
    shippingBillNumber: 'SB-TEST-999',
    shippingBillDate: '2026-11-02',
    sbExchangeRate: 84.5,
    fobValueInr: 422500,
    initialFircDocumentUploaded: true,
  }, 'user-admin-1');

  // Archive shipment
  const archived = await db.archiveShipment(tempShipment.id, 'Test archival', 'user-admin-1');
  assert.equal(archived.isArchived, true);

  // Verify archived shipment does not appear in default active shipment list
  const activeList = await db.getShipments({ financialYearId: 'fy-2026-27' });
  assert.equal(activeList.some(s => s.id === tempShipment.id), false, 'Archived shipment must be excluded from default list');

  // Verify archived shipment appears when explicitly requested
  const allList = await db.getShipments({ financialYearId: 'fy-2026-27', includeArchived: true });
  assert.equal(allList.some(s => s.id === tempShipment.id), true, 'Archived shipment must be present when includeArchived=true');

  // Restore shipment
  const restored = await db.restoreShipment(tempShipment.id, 'user-admin-1');
  assert.equal(restored.isArchived, false);

  // Clean delete of unallocated shipment succeeds
  const deleteRes = await db.deleteShipment(tempShipment.id, 'user-admin-1');
  assert.equal(deleteRes.success, true);
});

test('Payment Integrity: Cannot reduce verified amount below allocations, and cannot delete active payment', async () => {
  const payments = await db.getPayments();
  const paymentWithAlloc = payments.find(p => p.allocations && p.allocations.length > 0);

  if (paymentWithAlloc) {
    const allocated = paymentWithAlloc.totalAllocatedUsd || 0;
    // 1. Cannot reduce verified amount below allocated
    await assert.rejects(
      async () => {
        await db.updatePayment(paymentWithAlloc.id, {
          verifiedAmount: allocated - 100,
        }, 'user-admin-1');
      },
      /Cannot reduce payment verified amount.*below active allocations/i
    );

    // 2. Cannot delete payment with active allocations
    await assert.rejects(
      async () => {
        await db.deletePayment(paymentWithAlloc.id, 'user-admin-1');
      },
      /Cannot delete FIRC payment.*active allocation/i
    );
  }
});

test('Foreign Key Protection: Cannot delete Consignee or Bank referenced by shipments or payments', async () => {
  const consignees = await db.getConsignees();
  const shipments = await db.getShipments({});
  const usedConsignee = consignees.find(c => shipments.some(s => s.consigneeId === c.id));

  if (usedConsignee) {
    await assert.rejects(
      async () => {
        await db.deleteConsignee(usedConsignee.id, 'user-admin-1');
      },
      /Cannot delete Consignee.*referenced by.*export shipment/i
    );
  }

  const banks = await db.getBanks();
  const payments = await db.getPayments();
  const usedBank = banks.find(b => payments.some(p => p.bankId === b.id));

  if (usedBank) {
    await assert.rejects(
      async () => {
        await db.deleteBank(usedBank.id, 'user-admin-1');
      },
      /Cannot delete Bank.*referenced by.*FIRC payment/i
    );
  }
});

test('Incentive Protection: Cannot delete incentive with received statutory funds', async () => {
  const shipments = await db.getShipments({});
  let receivedIncentiveId: string | null = null;
  for (const s of shipments) {
    if (s.incentives) {
      const inc = s.incentives.find(i => (i.receivedAmount || 0) > 0);
      if (inc) {
        receivedIncentiveId = inc.id;
        break;
      }
    }
  }

  if (receivedIncentiveId) {
    await assert.rejects(
      async () => {
        await db.deleteIncentive(receivedIncentiveId!, 'user-admin-1');
      },
      /Cannot delete incentive claim.*credited.*prohibited/i
    );
  }
});

test('Excel Formula Equivalents: Rate separation and Net Forex Gain/Loss', () => {
  // Column J: Invoice USD
  const invoiceUsd = 40572.0;
  // Column K: Customs SB Rate
  const sbRate = 83.15;
  // Column L: FOB Value INR
  const fobInr = Math.round(invoiceUsd * sbRate * 100) / 100;
  assert.equal(fobInr, 3373561.8);

  // Realised payment at different bank rate
  const allocatedUsd = 40572.0;
  const realisedRate = 84.20;
  const realisedInr = Math.round(allocatedUsd * realisedRate * 100) / 100;
  assert.equal(realisedInr, 3416162.4);

  // Net Forex Gain/Loss = Realised INR - Expected FOB INR
  const netForex = Math.round((realisedInr - fobInr) * 100) / 100;
  assert.equal(netForex, 42600.6);
  assert.ok(netForex > 0, 'Forex gain when realised rate > customs rate');

  // Balance due USD
  const balanceDueUsd = Math.max(0, invoiceUsd - allocatedUsd);
  assert.equal(balanceDueUsd, 0);
});
