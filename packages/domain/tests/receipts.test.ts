// Receipt ownership and the executable seed/finalize drill against PGlite.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prisma } from "@project/db";
import { seedDemo } from "../../db/src/seed";
import { seedExamples } from "../../db/src/seed-examples";
import { finalizeReceipt, getReceipt, listReceiptBills, listReceipts, updateReceipt } from "../src";

describe("example receipts", () => {
  it("gives the signed-in account a reviewed draft that is 2.50 short, for the finalize mismatch drill", async () => {
    const user = await prisma.user.create({ data: { name: "Example owner", email: "examples@example.com" } });
    await seedExamples("examples@example.com");
    await seedExamples("examples@example.com");
    const id = `example-${user.id}-taco-stand`;
    const mismatch = await getReceipt(user.id, id);
    expect(mismatch.status).toBe("DRAFT");
    expect(mismatch.reviewedAt).not.toBeNull();
    expect(mismatch.organizerParticipantId).toBe(`${id}-me`);
    expect(mismatch.participants).toHaveLength(2);
    expect(mismatch.totals).toEqual({
      itemsTotal: "61.50", itemsDifference: "2.50", amountsDifference: "0.00", reconciled: false,
    });
    const stranger = await prisma.user.create({ data: { name: "Stranger", email: "stranger@example.com" } });
    await expect(getReceipt(stranger.id, id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("receipt-owned seed drill", () => {
  it("seeds idempotently, scopes history, confirms and finalizes the demo receipt", async () => {
    await seedDemo();
    await seedDemo();
    expect(await prisma.participant.count({ where: { receiptId: "seed-receipt-demo" } })).toBe(2);
    expect((await listReceipts("demo-user")).map((receipt) => receipt.id)).toEqual(["seed-receipt-demo"]);
    await expect(getReceipt("other-user", "seed-receipt-demo")).rejects.toMatchObject({ status: 404 });
    await expect(getReceipt("demo-user", undefined as unknown as string)).rejects.toMatchObject({ status: 404 });
    const receipt = await getReceipt("demo-user", "seed-receipt-demo");
    expect(receipt.ownerId).toBe("demo-user");
    const reviewed = await updateReceipt("demo-user", receipt.id, { expectedRevision: receipt.revision, reviewConfirmed: true });
    expect(reviewed.reviewedAt).not.toBeNull();
    await finalizeReceipt("demo-user", receipt.id, { expectedRevision: reviewed.revision });
    const bills = await listReceiptBills("demo-user", receipt.id);
    const cents = bills.reduce((sum, bill) => sum + Math.round(Number(bill.amountOwed) * 100), 0);
    expect(cents).toBe(3866);
    expect(bills.map((bill) => bill.amountOwed)).toEqual(["19.33", "19.33"]);
    expect(bills.map((bill) => bill.settled)).toEqual([true, false]);
    const finalized = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    await seedDemo();
    expect(await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(finalized);
    expect(await listReceiptBills("demo-user", receipt.id)).toEqual(bills);
    await expect(listReceiptBills("other-user", receipt.id)).rejects.toMatchObject({ status: 404 });
    await expect(finalizeReceipt("demo-user", receipt.id, { expectedRevision: reviewed.revision })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects unknown users for both receipt history and details", async () => {
    await expect(listReceipts("missing-user")).rejects.toMatchObject({ status: 401 });
    await expect(getReceipt("missing-user", "seed-receipt-demo")).rejects.toMatchObject({ status: 401 });
  });
});

describe("default payer", () => {
  // A reviewed EVEN receipt with an organizer and a guest; payer as given.
  async function draft(id: string, paidBy: "me" | "guest" | null) {
    const owner = await prisma.user.create({ data: { name: `Owner ${id}`, email: `${id}@example.com` } });
    await prisma.receipt.create({
      data: {
        id, ownerId: owner.id, title: "Lunch", imageBlobName: `seed/${id}.jpg`, imageContentType: "image/jpeg",
        parseStatus: "SUCCEEDED", subtotal: "20.00", tax: "0.00", tip: "0.00", total: "20.00",
        items: { create: [{ lineNumber: 1, name: "Pizza", quantity: "1", unitPrice: "20.00", totalPrice: "20.00" }] },
        participants: { create: [{ id: `${id}-me`, displayName: "Alex" }, { id: `${id}-guest`, displayName: "Sam" }] },
      },
    });
    await prisma.receipt.update({
      where: { id },
      data: { organizerParticipantId: `${id}-me`, paidByParticipantId: paidBy && `${id}-${paidBy}` },
    });
    const receipt = await getReceipt(owner.id, id);
    const reviewed = await updateReceipt(owner.id, id, { expectedRevision: receipt.revision, reviewConfirmed: true });
    return { owner: owner.id, revision: reviewed.revision };
  }

  it("makes the organizer the payer when none is chosen, so their own bill is settled", async () => {
    const { owner, revision } = await draft("payer-default", null);
    const finalized = await finalizeReceipt(owner, "payer-default", { expectedRevision: revision });
    expect(finalized.paidByParticipantId).toBe("payer-default-me");
    const bills = await listReceiptBills(owner, "payer-default");
    // Both joined together, so bills tie-break by id: Sam (…-guest) first.
    expect(bills.map((b) => [b.displayName, b.settled, b.outstandingAmount])).toEqual([
      ["Sam", false, "10.00"], ["Alex", true, "0.00"],
    ]);
  });

  it("keeps a payer that was chosen", async () => {
    const { owner, revision } = await draft("payer-guest", "guest");
    const finalized = await finalizeReceipt(owner, "payer-guest", { expectedRevision: revision });
    expect(finalized.paidByParticipantId).toBe("payer-guest-guest");
  });

  it("backfills receipts finalized without a payer (migration 0008)", async () => {
    const { owner, revision } = await draft("payer-backfill", null);
    await finalizeReceipt(owner, "payer-backfill", { expectedRevision: revision });
    // Recreate the old state: finalized with no payer.
    await prisma.receipt.update({ where: { id: "payer-backfill" }, data: { paidByParticipantId: null } });
    const before = await listReceiptBills(owner, "payer-backfill");
    expect(before.map((b) => b.settled)).toEqual([false, false]);
    const sql = readFileSync(new URL("../../db/prisma/migrations/0008_default_payer.sql", import.meta.url), "utf8");
    await prisma.$executeRawUnsafe(sql.replace(/^\s*(BEGIN|COMMIT);\s*$/gm, "").replace(/--.*$/gm, ""));
    const after = await listReceiptBills(owner, "payer-backfill");
    expect(after.map((b) => [b.displayName, b.settled])).toEqual([["Sam", false], ["Alex", true]]);
  });
});
