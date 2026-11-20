// Group link API against migrated PGlite; only owner identity and cache are mocked.
// PostgreSQL lock contention has a separate drill (receipts/guest-picks.md).
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@project/db";
import { replaceReceiptParticipants, setPicking } from "@project/domain";

const identity = vi.hoisted(() => ({ userId: "groups-owner" }));
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("@project/auth", () => ({ currentUserId: async () => identity.userId }));
vi.mock("next/cache", () => cache);
const owner = await import("../app/api/receipts/[id]/group-link/route");
const group = await import("../app/api/groups/[token]/route");
const claimRoute = await import("../app/api/groups/[token]/claim/route");
const personal = await import("../app/api/receipts/[id]/participants/[participantId]/pick-link/route");
const picks = await import("../app/api/picks/[token]/route");
const done = await import("../app/api/picks/[token]/done/route");
const detail = await import("../app/api/receipts/[id]/route");

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });
const receiptParams = (id: string) => ({ params: Promise.resolve({ id }) });
const participantParams = (id: string, participantId: string) => ({ params: Promise.resolve({ id, participantId }) });
const request = (path: string, method = "GET", body?: unknown) => new Request(`http://test${path}`, {
  method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
});
const issue = (id: string) => owner.POST(request(`/api/receipts/${id}/group-link`, "POST"), receiptParams(id));
const revoke = (id: string) => owner.DELETE(request(`/api/receipts/${id}/group-link`, "DELETE"), receiptParams(id));
const read = (token: string) => group.GET(request(`/api/groups/${token}`), tokenParams(token));
const claim = (token: string, participantId: string) => claimBody(token, { participantId });
const claimBody = (token: string, body: unknown) => claimRoute.POST(request(`/api/groups/${token}/claim`, "POST", body), tokenParams(token));
const readPersonal = (token: string) => picks.GET(request(`/api/picks/${token}`), tokenParams(token));
const receiptRow = (id: string) => prisma.receipt.findUniqueOrThrow({ where: { id } });
const participantRow = (id: string) => prisma.participant.findUniqueOrThrow({ where: { id } });
const guestHeaders = (res: Response) => {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
};
async function returnedToken(res: Response, prefix: "g" | "p") {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Object.keys(body)).toEqual(["url"]);
  expect(body.url).toMatch(new RegExp(`^http://test/${prefix}/[A-Za-z0-9_-]{43}$`));
  return new URL(body.url).pathname.slice(3);
}
const groupToken = async (id: string) => returnedToken(await issue(id), "g");
const personalToken = async (id: string, participantId: string) => returnedToken(await personal.POST(
  request(`/api/receipts/${id}/participants/${participantId}/pick-link`, "POST"), participantParams(id, participantId)), "p");

function noPrivateData(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of ["groups-owner", "+12125550888", "maya-groups@example.com", "secret-blob.jpg", "secret-extraction"]) {
    expect(serialized).not.toContain(secret);
  }
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [key, child] of Object.entries(v)) {
        expect(["phone", "email", "ownerId", "groupTokenHash", "pickTokenHash", "imageBlobName", "extraction", "parseError"]).not.toContain(key);
        walk(child);
      }
    }
  };
  walk(value);
}

async function draft() {
  const receipt = await prisma.receipt.create({
    data: {
      ownerId: "groups-owner", imageBlobName: "secret-blob.jpg", imageContentType: "image/jpeg",
      extraction: { secret: "secret-extraction" }, merchantName: "Noodle Bar",
      purchasedAt: new Date("2026-01-01T00:00:00Z"), parseStatus: "SUCCEEDED", reviewedAt: new Date(0),
      subtotal: "12", tax: "0", tip: "0", total: "12", splitMode: "EVEN",
      participants: { create: [
        { displayName: "Alex", phone: "+12125550888", joinedAt: new Date(0) },
        { displayName: "Maya", email: "maya-groups@example.com", joinedAt: new Date(1) },
        { displayName: "Sam", joinedAt: new Date(2) },
      ] },
      items: { create: { lineNumber: 1, name: "Soup", quantity: "1", unitPrice: "12", totalPrice: "12" } },
    },
    include: { participants: { orderBy: { joinedAt: "asc" } }, items: true },
  });
  const [alex, maya, sam] = receipt.participants;
  await prisma.receipt.update({ where: { id: receipt.id }, data: { organizerParticipantId: alex.id, paidByParticipantId: alex.id } });
  return { receipt, alex, maya, sam, item: receipt.items[0] };
}
let d: Awaited<ReturnType<typeof draft>>;
beforeAll(async () => {
  await prisma.user.createMany({ data: [
    { id: "groups-owner", name: "Owner", email: "groups-owner@example.com" },
    { id: "groups-other", name: "Other", email: "groups-other@example.com" },
  ] });
});
beforeEach(async () => {
  vi.restoreAllMocks();
  identity.userId = "groups-owner";
  cache.revalidatePath.mockClear();
  d = await draft();
});

describe("owner group-link management", () => {
  it("issues once with hash-only storage and rotates/revokes without changing revision", async () => {
    const response = await issue(d.receipt.id);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const first = await returnedToken(response, "g");
    expect((await receiptRow(d.receipt.id)).groupTokenHash).toBe(hash(first));
    expect(JSON.stringify(await receiptRow(d.receipt.id))).not.toContain(first);
    const second = await groupToken(d.receipt.id);
    expect(second).not.toBe(first);
    expect((await read(first)).status).toBe(404);
    expect((await read(second)).status).toBe(200);
    for (let i = 0; i < 2; i++) {
      const res = await revoke(d.receipt.id);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    }
    expect((await read(second)).status).toBe(404);
    expect(await receiptRow(d.receipt.id)).toMatchObject({ groupTokenHash: null, revision: 1 });
    expect(cache.revalidatePath).toHaveBeenCalledWith(`/api/receipts/${d.receipt.id}`);
  });

  it.each(["DRAFT", "FINALIZED", "PARSING", "OPEN"])("works in state %s", async (state) => {
    await prisma.receipt.update({ where: { id: d.receipt.id }, data: {
      ...(state === "FINALIZED" ? { status: "FINALIZED" } : {}),
      ...(state === "PARSING" ? { parseStatus: "PARSING" } : {}),
      ...(state === "OPEN" ? { picksOpenedAt: new Date(0) } : {}),
    } });
    await groupToken(d.receipt.id);
    await groupToken(d.receipt.id);
    expect((await revoke(d.receipt.id)).status).toBe(204);
    expect((await receiptRow(d.receipt.id)).revision).toBe(1);
  });

  it("rejects missing identity and foreign, unknown or deleted receipts without changing tokens", async () => {
    const token = await groupToken(d.receipt.id);
    for (const userId of ["", "no-user", "groups-other"]) {
      identity.userId = userId;
      const status = userId === "groups-other" ? 404 : 401;
      expect((await issue(d.receipt.id)).status).toBe(status);
      expect((await revoke(d.receipt.id)).status).toBe(status);
    }
    identity.userId = "groups-owner";
    for (const id of ["missing", ""]) {
      expect((await issue(id)).status).toBe(404);
      expect((await revoke(id)).status).toBe(404);
    }
    await prisma.receipt.update({ where: { id: d.receipt.id }, data: { deletedAt: new Date() } });
    expect((await issue(d.receipt.id)).status).toBe(404);
    expect((await revoke(d.receipt.id)).status).toBe(404);
    expect((await receiptRow(d.receipt.id)).groupTokenHash).toBe(hash(token));
  });

  it("presents only hasGroupLink in receipt detail and mutation responses", async () => {
    const readDetail = () => detail.GET(request(`/api/receipts/${d.receipt.id}`), receiptParams(d.receipt.id));
    expect(await (await readDetail()).json()).toMatchObject({ hasGroupLink: false });
    const token = await groupToken(d.receipt.id);
    const body = await (await readDetail()).json();
    expect(body.hasGroupLink).toBe(true);
    expect(body).not.toHaveProperty("groupTokenHash");
    expect(JSON.stringify(body)).not.toContain(hash(token));
    const mutation = await setPicking("groups-owner", d.receipt.id, { open: true });
    expect(mutation.hasGroupLink).toBe(true);
    expect(mutation).not.toHaveProperty("groupTokenHash");
    await revoke(d.receipt.id);
    expect(await (await readDetail()).json()).toMatchObject({ hasGroupLink: false });
  });
});

describe("anonymous group GET", () => {
  it("returns the exact draft roster without the organizer or side effects", async () => {
    const token = await groupToken(d.receipt.id);
    await personalToken(d.receipt.id, d.maya.id);
    const before = { receipt: await receiptRow(d.receipt.id), participants: await prisma.participant.findMany({ where: { receiptId: d.receipt.id }, orderBy: { id: "asc" } }) };
    identity.userId = "";
    const res = await read(token);
    guestHeaders(res);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "DRAFT", merchantName: "Noodle Bar", purchasedAt: "2026-01-01T00:00:00.000Z", pickingOpen: false,
      participants: [{ id: d.maya.id, displayName: "Maya", claimed: true }, { id: d.sam.id, displayName: "Sam", claimed: false }],
    });
    noPrivateData(body);
    expect(await receiptRow(d.receipt.id)).toEqual(before.receipt);
    expect(await prisma.participant.findMany({ where: { receiptId: d.receipt.id }, orderBy: { id: "asc" } })).toEqual(before.participants);
  });

  it("supports legacy rosters, nullable metadata and picking-open projection", async () => {
    const token = await groupToken(d.receipt.id);
    await prisma.receipt.update({ where: { id: d.receipt.id }, data: { organizerParticipantId: null, merchantName: null, purchasedAt: null, picksOpenedAt: new Date(0) } });
    const body = await (await read(token)).json();
    expect(body).toMatchObject({ merchantName: null, purchasedAt: null, pickingOpen: true });
    expect(body.participants.map((p: { id: string }) => p.id)).toEqual([d.alex.id, d.maya.id, d.sam.id]);
  });

  it("makes all unavailable token cases identical for GET and claim", async () => {
    const rotated = await groupToken(d.receipt.id);
    const revoked = await groupToken(d.receipt.id);
    await revoke(d.receipt.id);
    const deletedReceipt = await draft();
    const deleted = await groupToken(deletedReceipt.receipt.id);
    await prisma.receipt.update({ where: { id: deletedReceipt.receipt.id }, data: { deletedAt: new Date() } });
    const parsingReceipt = await draft();
    const parsing = await groupToken(parsingReceipt.receipt.id);
    await prisma.receipt.update({ where: { id: parsingReceipt.receipt.id }, data: { parseStatus: "PARSING" } });
    for (const token of ["short", "!".repeat(43), "x".repeat(43), rotated, revoked, deleted, parsing]) {
      for (const res of [await read(token), await claim(token, d.sam.id)]) {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Link not found" } });
        guestHeaders(res);
      }
    }
    expect((await participantRow(d.sam.id)).pickTokenHash).toBeNull();
  });

  it("returns the personal finalized summary without holder identity and includes the organizer", async () => {
    const token = await groupToken(d.receipt.id);
    const samToken = await personalToken(d.receipt.id, d.sam.id);
    await prisma.bill.createMany({ data: [
      { receiptId: d.receipt.id, participantId: d.alex.id, subtotal: "4", taxShare: "0", tipShare: "0", amountOwed: "4" },
      { receiptId: d.receipt.id, participantId: d.maya.id, subtotal: "4", taxShare: "0", tipShare: "0", amountOwed: "4", paidAt: new Date() },
      { receiptId: d.receipt.id, participantId: d.sam.id, subtotal: "0", taxShare: "0", tipShare: "0", amountOwed: "0" },
    ] });
    await prisma.receipt.update({ where: { id: d.receipt.id }, data: { status: "FINALIZED" } });
    const res = await read(token);
    guestHeaders(res);
    const body = await res.json();
    const { participantId: _holder, picksSubmittedAt: _done, ...expected } = await (await readPersonal(samToken)).json();
    expect(body).toEqual(expected);
    expect(Object.keys(body).sort()).toEqual(["status", "revision", "merchantName", "purchasedAt", "currency", "items", "paidBy", "participants"].sort());
    expect(body.participants).toEqual([
      { id: d.alex.id, displayName: "Alex", discountShare: "0.00", amountOwed: "4.00", settled: true },
      { id: d.maya.id, displayName: "Maya", discountShare: "0.00", amountOwed: "4.00", settled: true },
      { id: d.sam.id, displayName: "Sam", discountShare: "0.00", amountOwed: "0.00", settled: true },
    ]);
    noPrivateData(body);
    await prisma.bill.update({ where: { receiptId_participantId: { receiptId: d.receipt.id, participantId: d.maya.id } }, data: { paidAt: null } });
    expect((await (await read(token)).json()).participants[1].settled).toBe(false);
  });
});

describe("anonymous group claim", () => {
  it.each([false, true])("claims in pickingOpen=%s, returns one personal credential and respects existing pick mode", async (open) => {
    const token = await groupToken(d.receipt.id);
    if (open) await setPicking("groups-owner", d.receipt.id, { open });
    identity.userId = "";
    const res = await claim(token, ` ${d.sam.id} `);
    guestHeaders(res);
    const personalToken = await returnedToken(res, "p");
    expect((await participantRow(d.sam.id)).pickTokenHash).toBe(hash(personalToken));
    expect(JSON.stringify(await participantRow(d.sam.id))).not.toContain(personalToken);
    expect((await readPersonal(personalToken)).status).toBe(200);
    expect((await receiptRow(d.receipt.id)).revision).toBe(1);
    const save = await picks.PUT(request(`/api/picks/${personalToken}`, "PUT", { itemIds: [d.item.id] }), tokenParams(personalToken));
    expect(save.status).toBe(open ? 200 : 409);
  });

  it("allows exactly one concurrent winner and leaves its personal token valid", async () => {
    const token = await groupToken(d.receipt.id);
    const results = await Promise.all([claim(token, d.sam.id), claim(token, d.sam.id)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const winner = await returnedToken(results.find((r) => r.status === 200)!, "p");
    const conflict = results.find((r) => r.status === 409)!;
    guestHeaders(conflict);
    expect(await conflict.json()).toEqual({ error: { code: "CONFLICT", message: "Already claimed" } });
    expect((await participantRow(d.sam.id)).pickTokenHash).toBe(hash(winner));
    expect(await prisma.participant.count({ where: { receiptId: d.receipt.id, pickTokenHash: { not: null } } })).toBe(1);
    expect((await readPersonal(winner)).status).toBe(200);
    expect((await claim(token, d.sam.id)).status).toBe(409);
    expect((await receiptRow(d.receipt.id)).revision).toBe(1);
  });

  it("rejects foreign/missing participants, the organizer, malformed bodies and finalized claims without mutation", async () => {
    const token = await groupToken(d.receipt.id);
    const other = await draft();
    for (const participantId of [other.sam.id, "missing"]) {
      expect((await claim(token, participantId)).status).toBe(404);
    }
    const organizer = await claim(token, d.alex.id);
    expect(organizer.status).toBe(400);
    expect(await organizer.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
    for (const body of ["{bad json", null, {}, { participantId: " " }, { participantId: 4 }, { participantId: "x".repeat(201) }]) {
      const res = await claimBody(token, body);
      expect(res.status).toBe(400);
      guestHeaders(res);
      noPrivateData(await res.json());
    }
    await prisma.receipt.update({ where: { id: d.receipt.id }, data: { status: "FINALIZED" } });
    const before = await receiptRow(d.receipt.id);
    const finalized = await claim(token, d.sam.id);
    expect(finalized.status).toBe(409);
    guestHeaders(finalized);
    expect(await finalized.json()).toEqual({ error: { code: "CONFLICT", message: "Receipt is finalized" } });
    expect(await receiptRow(d.receipt.id)).toEqual(before);
    expect((await participantRow(d.sam.id)).pickTokenHash).toBeNull();
    expect((await participantRow(other.sam.id)).pickTokenHash).toBeNull();
  });

  it("preserves picks/done through group changes, personal rotation, release and reclaim", async () => {
    let token = await groupToken(d.receipt.id);
    const first = await returnedToken(await claim(token, d.sam.id), "p");
    await setPicking("groups-owner", d.receipt.id, { open: true });
    expect((await picks.PUT(request(`/api/picks/${first}`, "PUT", { itemIds: [d.item.id] }), tokenParams(first))).status).toBe(200);
    expect((await done.POST(request(`/api/picks/${first}/done`, "POST"), tokenParams(first))).status).toBe(200);
    const submittedAt = (await participantRow(d.sam.id)).picksSubmittedAt;
    const revision = (await receiptRow(d.receipt.id)).revision;
    token = await groupToken(d.receipt.id);
    await revoke(d.receipt.id);
    expect((await readPersonal(first)).status).toBe(200);
    token = await groupToken(d.receipt.id);
    const rotated = await personalToken(d.receipt.id, d.sam.id);
    expect((await readPersonal(first)).status).toBe(404);
    expect((await (await read(token)).json()).participants[1].claimed).toBe(true);
    expect((await personal.DELETE(request("/personal-link", "DELETE"), participantParams(d.receipt.id, d.sam.id))).status).toBe(204);
    expect((await (await read(token)).json()).participants[1].claimed).toBe(false);
    const reclaimed = await returnedToken(await claim(token, d.sam.id), "p");
    expect((await readPersonal(rotated)).status).toBe(404);
    expect((await readPersonal(reclaimed)).status).toBe(200);
    expect(await participantRow(d.sam.id)).toMatchObject({ picksSubmittedAt: submittedAt });
    expect((await prisma.receiptItem.findUniqueOrThrow({ where: { id: d.item.id } })).assignedParticipantId).toBe(d.sam.id);
    expect((await receiptRow(d.receipt.id)).revision).toBe(revision);
  });

  it("cannot claim a participant removed by the owner", async () => {
    const token = await groupToken(d.receipt.id);
    await replaceReceiptParticipants("groups-owner", d.receipt.id, { expectedRevision: 1, participants: [
      { id: d.alex.id, displayName: "Alex" }, { id: d.maya.id, displayName: "Maya" },
    ] });
    expect((await claim(token, d.sam.id)).status).toBe(404);
    expect(await prisma.participant.findUnique({ where: { id: d.sam.id } })).toBeNull();
  });

  it("rolls back the receipt touch and returns generic failures with guest headers", async () => {
    const token = await groupToken(d.receipt.id);
    const before = await receiptRow(d.receipt.id);
    // A database failure inside the transaction also exercises real rollback;
    // spying on the root Prisma delegate would not intercept tx.participant.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_group_claim() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'private database failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_group_claim BEFORE UPDATE OF pick_token_hash
      ON participants FOR EACH ROW EXECUTE FUNCTION reject_group_claim()`);
    let res: Response;
    try {
      res = await claim(token, d.sam.id);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER reject_group_claim ON participants");
      await prisma.$executeRawUnsafe("DROP FUNCTION reject_group_claim()");
    }
    expect(res.status).toBe(500);
    guestHeaders(res);
    expect(await res.json()).toEqual({ error: { code: "INTERNAL", message: "Something went wrong" } });
    expect(await receiptRow(d.receipt.id)).toEqual(before);
    expect((await participantRow(d.sam.id)).pickTokenHash).toBeNull();
    vi.spyOn(prisma.receipt, "findFirst").mockRejectedValueOnce(new Error("private database failure"));
    const getError = await read(token);
    expect(getError.status).toBe(500);
    guestHeaders(getError);
    expect(await getError.json()).toEqual({ error: { code: "INTERNAL", message: "Something went wrong" } });
  });
});
