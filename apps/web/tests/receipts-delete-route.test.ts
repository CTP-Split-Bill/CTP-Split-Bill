// DELETE/restore against real PGlite data, including visibility and preservation.
// Only identity, Next navigation/cache and blob storage are mocked.
// Spec: docs/specs/receipts/delete.md.
import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@project/db";
import { completeReceiptParsing, hashPickToken } from "@project/domain";

const identity = vi.hoisted(() => ({ userId: "delete-owner" }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const storage = vi.hoisted(() => ({ downloadAttachment: vi.fn() }));
const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((path: string) => { throw new Error(`REDIRECT ${path}`); }),
}));
vi.mock("@project/auth", () => ({ currentUserId: async () => identity.userId }));
vi.mock("next/cache", () => cache);
vi.mock("next/navigation", () => navigation);
vi.mock("@project/services", () => storage);

const receiptRoute = await import("../app/api/receipts/[id]/route");
const restoreRoute = await import("../app/api/receipts/[id]/restore/route");
const summaryProjection = await import("../../../packages/domain/src/receipt-summaries");
const historyRoute = await import("../app/api/receipts/route");
const summaryRoute = await import("../app/api/receipts/summary/route");
const imageRoute = await import("../app/api/receipts/[id]/image/route");
const billsRoute = await import("../app/api/receipts/[id]/bills/route");
const billRoute = await import("../app/api/bills/[billsId]/route");
const picksRoute = await import("../app/api/picks/[token]/route");
const doneRoute = await import("../app/api/picks/[token]/done/route");
const { loadStep } = await import("../app/receipts/[id]/step-guard");

let receiptId: string;
let token: string;
const context = (id = receiptId) => ({ params: Promise.resolve({ id }) });
const remove = (id = receiptId) => receiptRoute.DELETE(
  new Request(`http://test/api/receipts/${id}`, { method: "DELETE" }), context(id),
);
const restore = (id = receiptId) => restoreRoute.POST(
  new Request(`http://test/api/receipts/${id}/restore`, { method: "POST" }), context(id),
);
const snapshot = () => prisma.receipt.findUniqueOrThrow({
  where: { id: receiptId },
  include: {
    participants: { orderBy: { id: "asc" } },
    items: {
      orderBy: { lineNumber: "asc" },
      include: { sharedAllocations: { orderBy: { participantId: "asc" } } },
    },
    bills: { orderBy: { id: "asc" } },
  },
});

beforeAll(async () => {
  await prisma.user.createMany({ data: [
    { id: "delete-owner", name: "Owner", email: "delete-owner@example.com" },
    { id: "delete-other", name: "Other", email: "delete-other@example.com" },
  ] });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  identity.userId = "delete-owner";
  cache.revalidatePath.mockClear();
  navigation.notFound.mockClear();
  navigation.redirect.mockClear();
  storage.downloadAttachment.mockReset().mockResolvedValue({
    data: Uint8Array.from([137, 80, 78, 71]),
  });
  token = randomBytes(32).toString("base64url");
  const receipt = await prisma.receipt.create({
    data: {
      ownerId: identity.userId, imageBlobName: "delete/photo.png", imageContentType: "image/png",
      title: "Dinner", merchantName: "Bistro", parseStatus: "SUCCEEDED", revision: 7,
      splitMode: "SHARED_ITEMS", reviewedAt: new Date(0), picksOpenedAt: new Date(0),
      subtotal: "20.00", tax: "2.00", tip: "4.00", total: "26.00",
      participants: { create: [
        { displayName: "Alex", joinedAt: new Date(0) },
        { displayName: "Sam", joinedAt: new Date(1), pickTokenHash: hashPickToken(token), picksSubmittedAt: new Date(2) },
      ] },
      items: { create: [
        { lineNumber: 1, name: "Dinner", quantity: "1", unitPrice: "16.00", totalPrice: "16.00", isVerified: true },
        { lineNumber: 2, name: "Side", quantity: "1", unitPrice: "4.00", totalPrice: "4.00", isVerified: true },
      ] },
    },
    include: { participants: { orderBy: { joinedAt: "asc" } }, items: { orderBy: { lineNumber: "asc" } } },
  });
  receiptId = receipt.id;
  await prisma.receipt.update({
    where: { id: receiptId }, data: { paidByParticipantId: receipt.participants[0].id },
  });
  await prisma.sharedItemAllocation.createMany({
    data: receipt.participants.map((p) => ({ receiptId, itemId: receipt.items[0].id, participantId: p.id })),
  });
  await prisma.receiptItem.update({
    where: { id: receipt.items[1].id }, data: { assignedParticipantId: receipt.participants[0].id },
  });
});

describe("receipt DELETE", () => {
  it.each([
    { status: "DRAFT", parseStatus: "NOT_STARTED" },
    { status: "DRAFT", parseStatus: "PARSING" },
    { status: "DRAFT", parseStatus: "FAILED" },
    { status: "DRAFT", parseStatus: "SUCCEEDED" },
    { status: "FINALIZED", parseStatus: "SUCCEEDED" },
  ] as const)("soft-deletes $status/$parseStatus without changing content or children", async (state) => {
    await prisma.receipt.update({ where: { id: receiptId }, data: {
      ...state, finalizedAt: state.status === "FINALIZED" ? new Date(3) : null,
    } });
    if (state.status === "FINALIZED") {
      const receipt = await snapshot();
      await prisma.bill.createMany({ data: receipt.participants.map((p) => ({
        receiptId, participantId: p.id, subtotal: "10.00", taxShare: "1.00", tipShare: "2.00",
        amountOwed: "13.00", paidAt: null,
      })) });
    }
    const before = await snapshot();
    const started = Date.now();
    const response = await remove();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(cache.revalidatePath).toHaveBeenCalledExactlyOnceWith("/");
    const { deletedAt, updatedAt, ...after } = await snapshot();
    const { deletedAt: previousDeletion, updatedAt: previousUpdate, ...unchanged } = before;
    expect(previousDeletion).toBeNull();
    expect(deletedAt).toBeInstanceOf(Date);
    expect(deletedAt!.getTime()).toBeGreaterThanOrEqual(started);
    expect(deletedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(previousUpdate.getTime());
    expect(after).toEqual(unchanged);
  });

  it.each(["", "delete-missing-user"])("returns 401 for identity %j without a write", async (userId) => {
    const before = await snapshot();
    identity.userId = userId;
    const response = await remove();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Unknown user" } });
    expect(await snapshot()).toEqual(before);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["foreign", "unknown", "deleted", "missing", "blank"])("returns 404 for a %s receipt without a write", async (kind) => {
    if (kind === "foreign") identity.userId = "delete-other";
    if (kind === "deleted") await prisma.receipt.update({ where: { id: receiptId }, data: { deletedAt: new Date(0) } });
    const before = await snapshot();
    const id = kind === "unknown" ? "delete-missing" : kind === "missing" ? undefined as unknown as string : kind === "blank" ? " " : receiptId;
    // Pass undefined directly: the remove helper's default would replace it.
    const response = await receiptRoute.DELETE(new Request("http://test/delete", { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Receipt not found" } });
    expect(await snapshot()).toEqual(before);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns 404 on repeat deletion and preserves the original deletion timestamp", async () => {
    expect((await remove()).status).toBe(204);
    const before = await snapshot();
    cache.revalidatePath.mockClear();
    expect((await remove()).status).toBe(404);
    expect(await snapshot()).toEqual(before);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("allows only one of two concurrent deletes", async () => {
    const responses = await Promise.all([remove(), remove()]);
    expect(responses.map((r) => r.status).sort()).toEqual([204, 404]);
    expect((await snapshot()).revision).toBe(7);
    expect(cache.revalidatePath).toHaveBeenCalledTimes(1);
  });

  it("hides the receipt from lists, detail, image, step pages and guest links", async () => {
    const request = new Request("http://test/read");
    const tokenContext = { params: Promise.resolve({ token }) };
    expect((await receiptRoute.GET(request, context())).status).toBe(200);
    expect((await imageRoute.GET(request, context())).status).toBe(200);
    expect((await picksRoute.GET(request, tokenContext)).status).toBe(200);
    await expect(loadStep(receiptId, "items")).resolves.toMatchObject({ id: receiptId });
    for (const response of [await historyRoute.GET(), await summaryRoute.GET()]) {
      expect(response.status).toBe(200);
      expect((await response.json()).map((r: { id: string }) => r.id)).toContain(receiptId);
    }
    expect((await remove()).status).toBe(204);
    storage.downloadAttachment.mockClear();
    for (const response of [await historyRoute.GET(), await summaryRoute.GET()]) {
      expect(response.status).toBe(200);
      expect((await response.json()).map((r: { id: string }) => r.id)).not.toContain(receiptId);
    }
    for (const response of [
      await receiptRoute.GET(request, context()), await imageRoute.GET(request, context()),
      await picksRoute.GET(request, tokenContext),
      await picksRoute.PUT(new Request("http://test/picks", { method: "PUT", body: JSON.stringify({ itemIds: [] }) }), tokenContext),
      await doneRoute.POST(new Request("http://test/done", { method: "POST" }), tokenContext),
    ]) {
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");
    }
    expect(storage.downloadAttachment).not.toHaveBeenCalled();
    for (const step of ["scan", "items", "participants", "picks", "finalize"] as const) {
      await expect(loadStep(receiptId, step)).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("hides finalized bills without removing the snapshots", async () => {
    const receipt = await snapshot();
    await prisma.receipt.update({ where: { id: receiptId }, data: { status: "FINALIZED", finalizedAt: new Date() } });
    const bill = await prisma.bill.create({ data: {
      receiptId, participantId: receipt.participants[0].id, subtotal: "20.00",
      taxShare: "2.00", tipShare: "4.00", amountOwed: "26.00",
    } });
    const request = new Request("http://test/bills");
    const billContext = { params: Promise.resolve({ billsId: bill.id }) };
    expect((await billsRoute.GET(request, context())).status).toBe(200);
    expect((await billRoute.GET(request, billContext)).status).toBe(200);
    expect((await remove()).status).toBe(204);
    expect((await billsRoute.GET(request, context())).status).toBe(404);
    expect((await billRoute.GET(request, billContext)).status).toBe(404);
    expect(await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).toEqual(bill);
  });

  it("rejects an OCR completion after deletion without changing stored data", async () => {
    await prisma.receipt.update({ where: { id: receiptId }, data: { parseStatus: "PARSING" } });
    expect((await remove()).status).toBe(204);
    const before = await snapshot();
    await expect(completeReceiptParsing(identity.userId, receiptId, before.revision,
      "Merchant: Replacement\nDinner 20.00\nSubtotal 20.00\nTax 2.00\nTip 4.00\nTotal 26.00",
    )).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
  });

  it("returns a generic 500 on a database failure without revalidation or partial writes", async () => {
    const before = await snapshot();
    vi.spyOn(prisma.receipt, "updateMany").mockRejectedValueOnce(new Error("private database details"));
    const response = await remove();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "INTERNAL", message: "Something went wrong" } });
    expect(await snapshot()).toEqual(before);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("receipt restore POST", () => {
  it.each([
    { state: { status: "DRAFT", parseStatus: "NOT_STARTED" }, nextStep: "scan", picks: { open: true, done: 1, total: 2 } },
    { state: { status: "DRAFT", parseStatus: "PARSING" }, nextStep: "scan", picks: { open: true, done: 1, total: 2 } },
    { state: { status: "DRAFT", parseStatus: "FAILED" }, nextStep: "finalize", picks: { open: true, done: 1, total: 2 } },
    { state: { status: "DRAFT", parseStatus: "SUCCEEDED" }, nextStep: "finalize", picks: { open: true, done: 1, total: 2 } },
    { state: { status: "FINALIZED", parseStatus: "SUCCEEDED" }, nextStep: null, picks: null },
  ] as const)("restores $state.status/$state.parseStatus with the existing summary and unchanged content", async ({ state, nextStep, picks }) => {
    await prisma.receipt.update({ where: { id: receiptId }, data: {
      ...state, finalizedAt: state.status === "FINALIZED" ? new Date(3) : null,
    } });
    const before = await snapshot();
    expect((await remove()).status).toBe(204);
    cache.revalidatePath.mockClear();
    const response = await restore();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: receiptId, status: state.status, merchantName: "Bistro", title: "Dinner",
      total: "26.00", createdAt: before.createdAt.toISOString(), payerName: "Alex",
      participantCount: 2, settled: null, unpaidCount: null, outstanding: null, nextStep, picks,
    });
    expect(cache.revalidatePath).toHaveBeenCalledExactlyOnceWith("/");
    const { updatedAt, ...after } = await snapshot();
    const { updatedAt: previousUpdate, ...unchanged } = before;
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(previousUpdate.getTime());
    expect(after).toEqual(unchanged);
  });

  it.each([
    { status: "FINALIZED", bill: "unpaid", settled: false, unpaidCount: 1 },
    { status: "FINALIZED", bill: "paid", settled: true, unpaidCount: 0 },
    { status: "FINALIZED", bill: "payer", settled: true, unpaidCount: 0 },
    { status: "FINALIZED", bill: "zero", settled: true, unpaidCount: 0 },
    { status: "DRAFT", bill: "unpaid", settled: null, unpaidCount: null },
  ] as const)("preserves a $status/$bill bill and returns settled=$settled", async ({ status, bill, settled, unpaidCount }) => {
    const receipt = await snapshot();
    const guest = receipt.participants.find((p) => p.id !== receipt.paidByParticipantId)!;
    await prisma.receipt.update({ where: { id: receiptId }, data: {
      status, finalizedAt: status === "FINALIZED" ? new Date(3) : null,
    } });
    await prisma.bill.create({ data: {
      receiptId, participantId: bill === "payer" ? receipt.paidByParticipantId! : guest.id,
      subtotal: bill === "zero" ? "0.00" : "20.00", taxShare: "0.00", tipShare: "0.00",
      amountOwed: bill === "zero" ? "0.00" : "20.00", paidAt: bill === "paid" ? new Date(4) : null,
    } });
    const before = await snapshot();
    expect((await remove()).status).toBe(204);
    const response = await restore();
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary.settled).toBe(settled);
    expect(summary.unpaidCount).toBe(unpaidCount);
    const summaries = await (await summaryRoute.GET()).json();
    expect(summaries.find((r: { id: string }) => r.id === receiptId)).toEqual(summary);
    const { updatedAt: _afterUpdate, ...after } = await snapshot();
    const { updatedAt: _beforeUpdate, ...unchanged } = before;
    expect(after).toEqual(unchanged);
  });

  it("returns exact nullable metadata and no extra summary fields", async () => {
    await prisma.receipt.update({ where: { id: receiptId }, data: {
      merchantName: null, title: null, total: null, paidByParticipantId: null,
    } });
    const before = await snapshot();
    expect((await remove()).status).toBe(204);
    const response = await restore();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: receiptId, status: "DRAFT", merchantName: null, title: null, total: null,
      createdAt: before.createdAt.toISOString(), payerName: null,
      participantCount: 2, settled: null, unpaidCount: null, outstanding: null,
      nextStep: "finalize", picks: { open: true, done: 1, total: 2 },
    });
  });

  it.each(["", "restore-missing-user"])("returns 401 for identity %j without restoring", async (userId) => {
    expect((await remove()).status).toBe(204);
    const before = await snapshot();
    cache.revalidatePath.mockClear();
    identity.userId = userId;
    const response = await restore();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Unknown user" } });
    expect(await snapshot()).toEqual(before);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([false, true])("returns 404 for a foreign receipt with deleted=%s", async (deleted) => {
    if (deleted) expect((await remove()).status).toBe(204);
    const before = await snapshot();
    cache.revalidatePath.mockClear();
    identity.userId = "delete-other";
    const response = await restore();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Receipt not found" } });
    expect(await snapshot()).toEqual(before);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["restore-missing", "", " ", undefined])("returns 404 for receipt ID %j without widening the query", async (id) => {
    expect((await remove()).status).toBe(204);
    const before = await snapshot();
    cache.revalidatePath.mockClear();
    const response = await restoreRoute.POST(new Request("http://test/restore", { method: "POST" }), {
      params: Promise.resolve({ id: id as string }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Receipt not found" } });
    expect(await snapshot()).toEqual(before);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns 409 for a live receipt and for a repeat restore without changing data", async () => {
    const before = await snapshot();
    const response = await restore();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "CONFLICT", message: "Receipt is not deleted" } });
    expect(await snapshot()).toEqual(before);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect((await remove()).status).toBe(204);
    expect((await restore()).status).toBe(200);
    const restored = await snapshot();
    cache.revalidatePath.mockClear();
    expect((await restore()).status).toBe(409);
    expect(await snapshot()).toEqual(restored);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });

  it("allows exactly one of two concurrent restores", async () => {
    expect((await remove()).status).toBe(204);
    cache.revalidatePath.mockClear();
    const responses = await Promise.all([restore(), restore()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await snapshot()).toMatchObject({ deletedAt: null, revision: 7 });
    expect(cache.revalidatePath).toHaveBeenCalledExactlyOnceWith("/");
  });

  it("rolls back restoration if summary projection fails and hides raw errors", async () => {
    expect((await remove()).status).toBe(204);
    const before = await snapshot();
    cache.revalidatePath.mockClear();
    vi.spyOn(summaryProjection, "presentReceiptSummary").mockImplementationOnce(() => {
      throw new Error("private summary failure");
    });
    const response = await restore();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "INTERNAL", message: "Something went wrong" } });
    expect(await snapshot()).toEqual(before);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    // A failed attempt leaves a real deleted receipt that can still be restored.
    expect((await restore()).status).toBe(200);
  });

  it.each(["DRAFT", "FINALIZED"] as const)("restores original %s reads and guest links, then permits re-deletion", async (status) => {
    await prisma.receipt.update({ where: { id: receiptId }, data: {
      status, finalizedAt: status === "FINALIZED" ? new Date(3) : null,
    } });
    let billId: string | undefined;
    if (status === "FINALIZED") {
      const receipt = await snapshot();
      const guest = receipt.participants.find((p) => p.id !== receipt.paidByParticipantId)!;
      billId = (await prisma.bill.create({ data: {
        receiptId, participantId: guest.id, subtotal: "20.00", taxShare: "2.00", tipShare: "4.00", amountOwed: "26.00",
      } })).id;
    }
    const request = new Request("http://test/read");
    const tokenContext = { params: Promise.resolve({ token }) };
    const originalGuest = await (await picksRoute.GET(request, tokenContext)).json();
    expect((await remove()).status).toBe(204);
    expect((await receiptRoute.GET(request, context())).status).toBe(404);
    expect((await imageRoute.GET(request, context())).status).toBe(404);
    expect((await picksRoute.GET(request, tokenContext)).status).toBe(404);
    for (const response of [await historyRoute.GET(), await summaryRoute.GET()]) {
      expect((await response.json()).map((r: { id: string }) => r.id)).not.toContain(receiptId);
    }
    expect((await restore()).status).toBe(200);
    expect((await receiptRoute.GET(request, context())).status).toBe(200);
    const image = await imageRoute.GET(request, context());
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(Uint8Array.from([137, 80, 78, 71]));
    const guest = await picksRoute.GET(request, tokenContext);
    expect(guest.status).toBe(200);
    expect(await guest.json()).toEqual(originalGuest);
    expect((await billsRoute.GET(request, context())).status).toBe(200);
    if (billId) {
      expect((await billRoute.GET(request, { params: Promise.resolve({ billsId: billId }) })).status).toBe(200);
    }
    for (const response of [await historyRoute.GET(), await summaryRoute.GET()]) {
      expect((await response.json()).map((r: { id: string }) => r.id)).toContain(receiptId);
    }
    await expect(loadStep(receiptId, status === "FINALIZED" ? "finalize" : "items")).resolves.toMatchObject({ id: receiptId });
    expect((await restore()).status).toBe(409);
    expect((await remove()).status).toBe(204);
    // Reads cannot implicitly restore a receipt, even when repeated.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await receiptRoute.GET(request, context())).status).toBe(404);
    }
    expect((await snapshot()).deletedAt).not.toBeNull();
  });
});
