import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@project/db";

const identity = vi.hoisted(() => ({ userId: "summary-owner" }));
vi.mock("@project/auth", () => ({ currentUserId: async () => identity.userId }));
const { GET } = await import("../app/api/receipts/summary/route");

const request = () => GET();

beforeAll(async () => {
  await prisma.user.createMany({ data: [
    { id: "summary-owner", name: "Owner", email: "summary-owner@example.com" },
    { id: "summary-foreign", name: "Foreign", email: "summary-foreign@example.com" },
    { id: "summary-empty-owner", name: "Empty", email: "summary-empty@example.com" },
  ], skipDuplicates: true });
});

beforeEach(async () => {
  identity.userId = "summary-owner";
  await prisma.receipt.updateMany({ where: { id: { startsWith: "summary-" } }, data: { paidByParticipantId: null, organizerParticipantId: null } });
  await prisma.bill.deleteMany({ where: { receiptId: { startsWith: "summary-" } } });
  await prisma.receiptItem.deleteMany({ where: { receiptId: { startsWith: "summary-" } } });
  await prisma.participant.deleteMany({ where: { receiptId: { startsWith: "summary-" } } });
  await prisma.receipt.deleteMany({ where: { id: { startsWith: "summary-" } } });
  await prisma.receipt.create({ data: {
    id: "summary-draft", ownerId: "summary-owner", title: "Draft receipt",
    imageBlobName: "summary/draft.jpg", imageContentType: "image/jpeg",
    status: "DRAFT", total: "12.50", createdAt: new Date("2026-01-01T00:00:00Z"),
    participants: { create: [{ id: "summary-draft-payer", displayName: "Alex" }, { id: "summary-draft-other", displayName: "Sam" }] },
  } });
  await prisma.receipt.create({ data: {
    id: "summary-final", ownerId: "summary-owner", title: "Dinner",
    imageBlobName: "summary/final.jpg", imageContentType: "image/jpeg",
    status: "FINALIZED", subtotal: "10.00", tax: "0.00", tip: "0.00", total: "10.00",
    finalizedAt: new Date("2026-02-01T00:00:00Z"), createdAt: new Date("2026-02-01T00:00:00Z"),
    participants: { create: [{ id: "summary-final-payer", displayName: "Pat" }, { id: "summary-final-paid", displayName: "Lee" }, { id: "summary-final-zero", displayName: "Jo" }] },
    bills: { create: [
      { id: "summary-bill-payer", participantId: "summary-final-payer", subtotal: "5", taxShare: "0", tipShare: "0", amountOwed: "5" },
      { id: "summary-bill-paid", participantId: "summary-final-paid", subtotal: "5", taxShare: "0", tipShare: "0", amountOwed: "5", paidAt: new Date() },
      { id: "summary-bill-zero", participantId: "summary-final-zero", subtotal: "0", taxShare: "0", tipShare: "0", amountOwed: "0" },
    ] },
  } });
  await prisma.receipt.update({ where: { id: "summary-final" }, data: { paidByParticipantId: "summary-final-payer" } });
  await prisma.receipt.create({ data: {
    id: "summary-unpaid", ownerId: "summary-owner", title: "Unpaid",
    imageBlobName: "summary/unpaid.jpg", imageContentType: "image/jpeg",
    status: "FINALIZED", subtotal: "9.25", tax: "0.00", tip: "0.00", total: "9.25",
    finalizedAt: new Date("2026-03-01T00:00:00Z"), createdAt: new Date("2026-03-01T00:00:00Z"),
    participants: { create: { id: "summary-unpaid-person", displayName: "Kim" } },
    bills: { create: { id: "summary-unpaid-bill", participantId: "summary-unpaid-person", subtotal: "9.25", taxShare: "0", tipShare: "0", amountOwed: "9.25" } },
  } });
  await prisma.receipt.create({ data: {
    id: "summary-foreign-receipt", ownerId: "summary-foreign", title: "Private",
    imageBlobName: "summary/foreign.jpg", imageContentType: "image/jpeg",
  } });
  await prisma.receipt.createMany({ data: ["summary-tie-b", "summary-tie-a"].map((id) => ({
    id, ownerId: "summary-owner", title: id, imageBlobName: `${id}.jpg`,
    imageContentType: "image/jpeg", status: "DRAFT" as const,
    createdAt: new Date("2026-02-15T00:00:00Z"),
  })) });
  await prisma.receipt.create({ data: {
    id: "summary-no-bills", ownerId: "summary-owner", title: "No bills",
    imageBlobName: "summary/no-bills.jpg", imageContentType: "image/jpeg",
    status: "FINALIZED", subtotal: "1.00", tax: "0.00", tip: "0.00", total: "1.00",
    finalizedAt: new Date("2026-02-20T00:00:00Z"), createdAt: new Date("2026-02-20T00:00:00Z"),
  } });
});

describe("GET /api/receipts/summary", () => {
  it("returns only the owner's summaries newest first with raw values and participant counts", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: "summary-unpaid", status: "FINALIZED", merchantName: null, title: "Unpaid", total: "9.25", createdAt: "2026-03-01T00:00:00.000Z", payerName: null, participantCount: 1, settled: false, unpaidCount: 1, outstanding: "9.25", nextStep: null, picks: null },
      { id: "summary-no-bills", status: "FINALIZED", merchantName: null, title: "No bills", total: "1.00", createdAt: "2026-02-20T00:00:00.000Z", payerName: null, participantCount: 0, settled: null, unpaidCount: null, outstanding: null, nextStep: null, picks: null },
      { id: "summary-tie-a", status: "DRAFT", merchantName: null, title: "summary-tie-a", total: null, createdAt: "2026-02-15T00:00:00.000Z", payerName: null, participantCount: 0, settled: null, unpaidCount: null, outstanding: null, nextStep: "scan", picks: null },
      { id: "summary-tie-b", status: "DRAFT", merchantName: null, title: "summary-tie-b", total: null, createdAt: "2026-02-15T00:00:00.000Z", payerName: null, participantCount: 0, settled: null, unpaidCount: null, outstanding: null, nextStep: "scan", picks: null },
      { id: "summary-final", status: "FINALIZED", merchantName: null, title: "Dinner", total: "10.00", createdAt: "2026-02-01T00:00:00.000Z", payerName: "Pat", participantCount: 3, settled: true, unpaidCount: 0, outstanding: "0.00", nextStep: null, picks: null },
      { id: "summary-draft", status: "DRAFT", merchantName: null, title: "Draft receipt", total: "12.50", createdAt: "2026-01-01T00:00:00.000Z", payerName: null, participantCount: 2, settled: null, unpaidCount: null, outstanding: null, nextStep: "scan", picks: null },
    ]);
  });

  it("counts only the unsettled bills in unpaidCount", async () => {
    await prisma.receipt.create({ data: {
      id: "summary-partly", ownerId: "summary-owner", title: "Partly paid",
      imageBlobName: "summary/partly.jpg", imageContentType: "image/jpeg",
      status: "FINALIZED", subtotal: "30.00", tax: "0.00", tip: "0.00", total: "30.00",
      finalizedAt: new Date("2026-04-01T00:00:00Z"), createdAt: new Date("2026-04-01T00:00:00Z"),
      participants: { create: ["a", "b", "c"].map((p) => ({ id: `summary-partly-${p}`, displayName: p })) },
      bills: { create: [
        { participantId: "summary-partly-a", subtotal: "10", taxShare: "0", tipShare: "0", amountOwed: "10" },
        { participantId: "summary-partly-b", subtotal: "10", taxShare: "0", tipShare: "0", amountOwed: "10" },
        { participantId: "summary-partly-c", subtotal: "10", taxShare: "0", tipShare: "0", amountOwed: "10", paidAt: new Date() },
      ] },
    } });
    const partly = (await (await request()).json()).find((r: { id: string }) => r.id === "summary-partly");
    expect(partly).toMatchObject({ settled: false, unpaidCount: 2, outstanding: "20.00", nextStep: null, picks: null });
  });

  it("names a draft's next step with the step rules and clears it once finalized", async () => {
    const id = "summary-steps";
    const read = async () => (await (await request()).json()).find((r: { id: string }) => r.id === id);
    await prisma.receipt.create({ data: {
      id, ownerId: "summary-owner", title: "Steps", imageBlobName: "summary/steps.jpg",
      imageContentType: "image/jpeg", status: "DRAFT", parseStatus: "PARSING", splitMode: "ITEMIZED",
      participants: { create: [{ id: "summary-steps-me", displayName: "Me" }, { id: "summary-steps-guest", displayName: "Sam" }] },
    } });
    expect((await read()).nextStep).toBe("scan");
    await prisma.receipt.update({ where: { id }, data: { parseStatus: "SUCCEEDED" } });
    expect((await read()).nextStep).toBe("items");
    await prisma.receipt.update({ where: { id }, data: { reviewedAt: new Date(), organizerParticipantId: "summary-steps-me" } });
    await prisma.receiptItem.create({ data: { receiptId: id, lineNumber: 1, name: "Ramen", totalPrice: "12.00" } });
    expect((await read()).nextStep).toBe("picks");
    await prisma.receiptItem.updateMany({ where: { receiptId: id }, data: { assignedParticipantId: "summary-steps-guest" } });
    expect((await read()).nextStep).toBe("finalize");
    await prisma.receipt.update({ where: { id }, data: {
      status: "FINALIZED", finalizedAt: new Date(), subtotal: "12.00", tax: "0.00", tip: "0.00", total: "12.00",
    } });
    expect((await read()).nextStep).toBeNull();
  });

  it("asks for people when the organizer is the only participant", async () => {
    await prisma.receipt.create({ data: {
      id: "summary-alone", ownerId: "summary-owner", title: "Alone", imageBlobName: "summary/alone.jpg",
      imageContentType: "image/jpeg", status: "DRAFT", parseStatus: "SUCCEEDED", reviewedAt: new Date(),
      participants: { create: [{ id: "summary-alone-me", displayName: "Me" }] },
    } });
    await prisma.receipt.update({ where: { id: "summary-alone" }, data: { organizerParticipantId: "summary-alone-me" } });
    const alone = (await (await request()).json()).find((r: { id: string }) => r.id === "summary-alone");
    expect(alone.nextStep).toBe("participants");
  });

  it("reports picks progress without counting the organizer", async () => {
    const id = "summary-picks";
    const read = async () => (await (await request()).json()).find((r: { id: string }) => r.id === id).picks;
    await prisma.receipt.create({ data: {
      id, ownerId: "summary-owner", title: "Picks", imageBlobName: "summary/picks.jpg",
      imageContentType: "image/jpeg", status: "DRAFT",
      participants: { create: ["me", "a", "b", "c"].map((p) => ({ id: `summary-picks-${p}`, displayName: p })) },
    } });
    await prisma.receipt.update({ where: { id }, data: { organizerParticipantId: "summary-picks-me" } });
    expect(await read()).toBeNull();
    await prisma.receipt.update({ where: { id }, data: { picksOpenedAt: new Date() } });
    await prisma.participant.updateMany({
      where: { id: { in: ["summary-picks-me", "summary-picks-a", "summary-picks-b"] } },
      data: { picksSubmittedAt: new Date() },
    });
    expect(await read()).toEqual({ open: true, done: 2, total: 3 });
    await prisma.receipt.update({ where: { id }, data: { picksOpenedAt: null } });
    expect(await read()).toEqual({ open: false, done: 2, total: 3 });
  });

  it("excludes soft-deleted receipts", async () => {
    await prisma.receipt.update({ where: { id: "summary-draft" }, data: { deletedAt: new Date() } });
    const response = await request();
    expect((await response.json()).map((receipt: { id: string }) => receipt.id)).not.toContain("summary-draft");
  });

  it("returns an empty list for an owner with no receipts", async () => {
    identity.userId = "summary-empty-owner";
    expect(await (await request()).json()).toEqual([]);
  });

  it("returns the standard 401 envelope for missing or unknown users", async () => {
    for (const userId of ["", "summary-unknown"]) {
      identity.userId = userId;
      const response = await request();
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    }
  });
});
