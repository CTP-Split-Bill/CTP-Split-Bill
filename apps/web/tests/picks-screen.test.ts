// Picks step (docs/specs/bills/split-screen.md): the board model, readiness,
// running totals against the preview route, the save plan run against the
// real routes, the organizer's toggles, and static renders of each state.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@project/db";

const identity = vi.hoisted(() => ({ userId: "picks-owner" }));
vi.mock("@project/auth", () => ({ currentUserId: async () => identity.userId }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));

const form = await import("../app/receipts/[id]/picks/picks-form");
const { PicksBoard } = await import("../app/receipts/[id]/picks/PicksBoard");
const { getReceipt, previewReceipt } = await import("@project/domain");
const { PATCH } = await import("../app/api/receipts/[id]/route");
const { PUT: PUT_ASSIGNMENTS } = await import("../app/api/receipts/[id]/assignments/route");
const { PUT: PUT_SHARED } = await import("../app/api/receipts/[id]/shared-allocations/route");

type BoardReceipt = import("../app/receipts/[id]/picks/picks-form").BoardReceipt;

// The seed receipt's shape: Salmon roll 16, Miso soup 4, Edamame 10;
// 30.00 + 2.66 + 6.00 = 38.66.
function board(overrides: Partial<BoardReceipt> = {}): BoardReceipt {
  return {
    id: "r1",
    revision: 3,
    finalized: false,
    pickingOpen: true,
    splitMode: "ITEMIZED",
    subtotal: "30",
    tax: "2.66",
    tip: "6",
    total: "38.66",
    organizerId: "me",
    people: [
      { id: "me", name: "Demo User", joinedAt: "2026-01-01T00:00:00.000Z", hasPickLink: false, done: false },
      { id: "sam", name: "Sam", joinedAt: "2026-01-01T00:00:01.000Z", hasPickLink: true, done: false },
      { id: "maya", name: "Maya", joinedAt: "2026-01-01T00:00:02.000Z", hasPickLink: false, done: false },
    ],
    items: [
      { id: "salmon", name: "Salmon roll", totalPrice: "16", people: [] },
      { id: "miso", name: "Miso soup", totalPrice: "4", people: [] },
      { id: "edamame", name: "Edamame", totalPrice: "10", people: [] },
    ],
    billAmounts: null,
    ...overrides,
  };
}

const two = (overrides: Partial<BoardReceipt> = {}) =>
  board({ people: board().people.slice(0, 2), ...overrides });

function withPeople(r: BoardReceipt, people: Record<string, string[]>): BoardReceipt {
  return { ...r, items: r.items.map((i) => ({ ...i, people: people[i.id] ?? [] })) };
}

describe("loading receipt detail", () => {
  it("puts the organizer first, orders items by line and reads people from either representation", () => {
    const r = form.toBoardReceipt({
      id: "r", revision: 2, status: "DRAFT", picksOpenedAt: new Date(), splitMode: "SHARED_ITEMS",
      subtotal: "14", tax: "0", tip: null, total: "14", organizerParticipantId: "me",
      participants: [
        { id: "sam", displayName: "Sam", joinedAt: new Date(0), hasPickLink: true, picksSubmittedAt: new Date() },
        { id: "me", displayName: "Demo", joinedAt: new Date(1), hasPickLink: false, picksSubmittedAt: null },
      ],
      items: [
        { id: "b", name: "Tea", lineNumber: 2, totalPrice: "4", assignedParticipantId: null, sharedAllocations: [{ participantId: "sam" }, { participantId: "me" }] },
        { id: "a", name: " ", lineNumber: 1, totalPrice: "10", assignedParticipantId: "sam", sharedAllocations: [] },
      ],
    });
    expect(r.people.map((p) => p.id)).toEqual(["me", "sam"]);
    expect(r.people[1].done).toBe(true);
    expect(r.pickingOpen).toBe(true);
    expect(r.items).toEqual([
      { id: "a", name: "Item 1", totalPrice: "10", people: ["sam"] },
      { id: "b", name: "Tea", totalPrice: "4", people: ["sam", "me"] },
    ]);
  });

  it("is never picking open once finalized", () => {
    const r = form.toBoardReceipt({
      id: "r", revision: 2, status: "FINALIZED", picksOpenedAt: new Date(), splitMode: "EVEN",
      subtotal: "1", tax: "0", tip: null, total: "1", organizerParticipantId: null, participants: [], items: [],
    }, [{ participantId: "x", amountOwed: "1.00" }]);
    expect(r).toMatchObject({ finalized: true, pickingOpen: false, billAmounts: { x: "1.00" } });
  });
});

describe("the board", () => {
  it("shows You for the organizer, Split N ways and unclaimed items", () => {
    const view = form.boardView(withPeople(two(), { edamame: ["me", "sam"], miso: ["sam"] }));
    expect(view.items[0]).toMatchObject({ unclaimed: true, chips: [] });
    expect(view.items[2]).toMatchObject({
      chips: [{ id: "me", label: "You", initial: "D", color: 1 }, { id: "sam", label: "Sam", initial: "S", color: 2 }],
      shareNote: "Split 2 ways",
    });
    expect(view.claimSummary).toBe("1 item unclaimed · $16.00");
    expect(view.allClaimed).toBe(false);
  });

  it("flags nothing in EVEN and says so", () => {
    const view = form.boardView(two({ splitMode: "EVEN" }));
    expect(view.even).toBe(true);
    expect(view.claimSummary).toBeNull();
    expect(view.items.every((i) => !i.unclaimed && i.chips.length === 0)).toBe(true);
  });

  it("derives readiness for everyone but the organizer", () => {
    const view = form.boardView(board({
      people: [
        { ...board().people[0] },
        { ...board().people[1], done: true },
        { ...board().people[2] },
      ],
    }));
    expect(view.people.map((p) => p.readiness)).toEqual([null, "Done", "No link"]);
    expect(form.readiness({ ...board().people[1] })).toBe("Still picking");
    expect(view.doneSummary).toBe("1 of 2 done");
  });
});

describe("people bar and totals bar", () => {
  it("gives each person an initial and a color by roster position, and wraps past six", () => {
    const people = Array.from({ length: 7 }, (_, i) => ({ ...board().people[1], id: `p${i}`, name: ` ${"abcdefg"[i]}x` }));
    const view = form.boardView(board({ people, organizerId: null }));
    expect(view.people.map((p) => [p.initial, p.color])).toEqual([
      ["A", 1], ["B", 2], ["C", 3], ["D", 4], ["E", 5], ["F", 6], ["G", 1],
    ]);
    expect(form.initialOf("  ")).toBe("?");
  });

  it("labels the selected person's total", () => {
    const covered = form.boardView(withPeople(two(), { salmon: ["me"], miso: ["sam"], edamame: ["me", "sam"] }));
    expect(covered.people.map(form.totalLabel)).toEqual(["Your share", "Sam owes"]);
    const partial = form.boardView(withPeople(two(), { miso: ["sam"] }));
    expect(partial.people.map(form.totalLabel)).toEqual(["Your items so far", "Sam's items so far"]);
  });

  it("counts the selected person's items", () => {
    const r = withPeople(two(), { miso: ["sam"], edamame: ["me", "sam"] });
    expect(form.selectedText(form.selectedCount(r, "sam"))).toBe("2 items selected");
    expect(form.selectedText(form.selectedCount(r, "me"))).toBe("1 item selected");
  });

  it("lets anyone change while editing, only the organizer while picking is open", () => {
    expect(form.changeable(two({ pickingOpen: false }), "sam")).toBe(true);
    expect(form.changeable(two(), "me")).toBe(true);
    expect(form.changeable(two(), "sam")).toBe(false);
    expect(form.changeable(two({ organizerId: null }), "me")).toBe(false);
    expect(form.changeable(two({ pickingOpen: false, splitMode: "EVEN" }), "me")).toBe(false);
    expect(form.changeable(two({ pickingOpen: false, finalized: true }), "me")).toBe(false);
  });
});

describe("running totals", () => {
  it("shows what each person owes once every item is covered", () => {
    const view = form.boardView(withPeople(two(), { salmon: ["me"], miso: ["sam"], edamame: ["me", "sam"] }));
    expect(view.people.map((p) => [p.name, p.amountLabel, p.amount])).toEqual([
      ["You", "Your share", "$27.06"],
      ["Sam", "Owes", "$11.60"],
    ]);
    expect(view.totalsNote).toBeNull();
    expect(view.matchedTotal).toBe("$38.66");
    expect(view.claimSummary).toBe("Every item is claimed");
  });

  it("shows only items so far while anything is unclaimed, and they add up with the unclaimed amount", () => {
    const view = form.boardView(withPeople(board(), { miso: ["sam"], edamame: ["me", "sam", "maya"] }));
    expect(view.people.map((p) => [p.amountLabel, p.amount])).toEqual([
      ["Items so far", "$3.34"],
      ["Items so far", "$7.33"],
      ["Items so far", "$3.33"],
    ]);
    expect(view.totalsNote).toBe("Tax and tip are added once every item is claimed.");
    expect(view.matchedTotal).toBeNull();
    expect(view.claimSummary).toBe("1 item unclaimed · $16.00");
  });

  it("splits EVEN receipts at once", () => {
    const view = form.boardView(board({ splitMode: "EVEN" }));
    expect(view.people.map((p) => p.amount)).toEqual(["$12.89", "$12.89", "$12.88"]);
  });

  it("uses the bill amounts on a finalized receipt", () => {
    const view = form.boardView(two({ finalized: true, pickingOpen: false, billAmounts: { me: "27.06", sam: "11.60" } }));
    expect(view.people.map((p) => p.amount)).toEqual(["$27.06", "$11.60"]);
  });

  it("doesn't claim a match when the amounts don't add up to the receipt total", () => {
    const view = form.boardView(withPeople(two({ total: "40.00" }), { salmon: ["me"], miso: ["sam"], edamame: ["me", "sam"] }));
    expect(view.people[0].amountLabel).toBe("Your share");
    expect(view.matchedTotal).toBeNull();
  });

  it("formats dollars with grouping", () => {
    expect(form.dollars(123456789n)).toBe("$1,234,567.89");
    expect(form.dollars(5n)).toBe("$0.05");
  });
});

describe("editing draft and save plan", () => {
  const saved = withPeople(two({ pickingOpen: false }), { salmon: ["me"], miso: ["sam"] });

  it("sends nothing when nothing changed", () => {
    const draft = form.draftFrom(saved);
    expect(form.isDirty(saved, draft)).toBe(false);
    expect(form.nextSaveStep(saved, draft)).toBeNull();
  });

  it("sends only assignments for a one-person change", () => {
    const draft = form.togglePerson(saved, form.draftFrom(saved), "edamame", "sam");
    expect(form.nextSaveStep(saved, draft)).toEqual({
      kind: "assignments",
      body: { expectedRevision: 3, assignments: [
        { itemId: "salmon", participantId: "me" },
        { itemId: "miso", participantId: "sam" },
        { itemId: "edamame", participantId: "sam" },
      ] },
    });
  });

  it("moves an ITEMIZED receipt to SHARED_ITEMS first when an item gets two people", () => {
    let draft = form.togglePerson(saved, form.draftFrom(saved), "salmon", "sam");
    expect(form.nextSaveStep(saved, draft)).toEqual({ kind: "mode", body: { expectedRevision: 3, splitMode: "SHARED_ITEMS" } });
    const after = { ...saved, revision: 4, splitMode: "SHARED_ITEMS" as const };
    expect(form.nextSaveStep(after, draft)).toEqual({
      kind: "shared",
      body: { expectedRevision: 4, allocations: [{ itemId: "salmon", participantIds: ["me", "sam"] }] },
    });
    draft = form.togglePerson(saved, draft, "salmon", "sam");
    expect(form.nextSaveStep(after, draft)).toBeNull();
  });

  it("Select all adds one person to every item and Deselect all removes them", () => {
    const all = form.setPersonOnAll(saved, form.draftFrom(saved), "sam", true);
    expect(all.people).toEqual({ salmon: ["me", "sam"], miso: ["sam"], edamame: ["sam"] });
    expect(form.nextSaveStep(saved, all)?.kind).toBe("mode");
    const none = form.setPersonOnAll(saved, all, "sam", false);
    expect(none.people).toEqual({ salmon: ["me"], miso: [], edamame: [] });
  });

  it("saves Even as one PATCH", () => {
    const draft = { ...form.draftFrom(saved), split: "EVEN" as const };
    expect(form.nextSaveStep(saved, draft)).toEqual({ kind: "mode", body: { expectedRevision: 3, splitMode: "EVEN" } });
    expect(form.nextSaveStep({ ...saved, splitMode: "EVEN" }, draft)).toBeNull();
  });

  it("maps each step to its route", () => {
    expect(form.saveStepPath("r 1", { kind: "mode", body: { expectedRevision: 1, splitMode: "EVEN" } })).toEqual({ path: "/api/receipts/r%201", method: "PATCH" });
    expect(form.saveStepPath("r", { kind: "shared", body: { expectedRevision: 1, allocations: [] } }).path).toBe("/api/receipts/r/shared-allocations");
    expect(form.saveStepPath("r", { kind: "assignments", body: { expectedRevision: 1, assignments: [] } }).path).toBe("/api/receipts/r/assignments");
  });
});

describe("the organizer's own picks", () => {
  it("toggles a complete set and shows it before the server confirms", () => {
    const r = withPeople(two(), { edamame: ["sam"] });
    const mine = form.toggleOwnItem(form.organizerItems(r), "edamame");
    expect(mine).toEqual(["edamame"]);
    expect(form.withOwnItems(r, mine).items[2].people).toEqual(["me", "sam"]);
    expect(form.withOwnItems(r, []).items[2].people).toEqual(["sam"]);
    expect(form.organizerItems({ ...r, organizerId: null })).toEqual([]);
  });
});

describe("static renders", () => {
  const render = (r: BoardReceipt) => renderToStaticMarkup(h(PicksBoard, { initial: r }));

  it("picking open: You selected, item cards toggle your picks, and the pause button", () => {
    const html = render(withPeople(two(), { miso: ["sam"] }));
    expect(html).toContain("Picks show up here as people make them.");
    expect(html).toMatch(/aria-label="You"[^>]*data-state="on"|data-state="on"[^>]*aria-label="You"/);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("0 items selected");
    expect(html).toContain("Select all");
    expect(html).toContain("Your items so far");
    expect(html).toContain('role="img" aria-label="Sam"');
    expect(html).toContain("Pause picking to edit");
    expect(html).toContain("Unclaimed");
    expect(html).not.toMatch(/Updated \d/);
  });

  it("picking open, every item claimed: the total matches and Finalize leads", () => {
    const html = render(withPeople(two(), { salmon: ["me"], miso: ["sam"], edamame: ["me", "sam"] }));
    expect(html).toContain("Matches the receipt");
    expect(html).toContain("Total $38.66");
    expect(html).toMatch(/href="\/receipts\/r1\/finalize"[^>]*>Continue to Finalize/);
  });

  it("picking open, something unclaimed: no Finalize", () => {
    const html = render(withPeople(two(), { miso: ["sam"] }));
    expect(html).not.toContain("Continue to Finalize");
    expect(html).not.toContain("Matches the receipt");
  });

  it("picking open without an organizer row: the first person, read-only", () => {
    const html = render(two({ organizerId: null }));
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("Select all");
    expect(html).toContain("Pause picking to change Demo User&#x27;s items.");
  });

  it("marks a done guest on their avatar", () => {
    const html = render(two({ people: [two().people[0], { ...two().people[1], done: true }] }));
    expect(html).toContain('aria-label="Sam, done"');
  });

  it("editing: item cards, the split toggle, Save and Open picking", () => {
    const html = render(withPeople(two({ pickingOpen: false }), { salmon: ["me"] }));
    expect(html).toContain("Pick a person, then tap what they had.");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("1 item selected");
    expect(html).toContain("By item");
    expect(html).toContain("Open picking");
  });

  it("every item yours: Deselect all", () => {
    const html = render(withPeople(two({ pickingOpen: false }), { salmon: ["me"], miso: ["me"], edamame: ["me"] }));
    expect(html).toContain("Deselect all");
  });

  it("EVEN: the even note and no flags", () => {
    const html = render(two({ pickingOpen: false, splitMode: "EVEN" }));
    expect(html).toContain("Splitting evenly");
    expect(html).not.toContain("Unclaimed");
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("items selected");
  });

  it("finalized: no buttons", () => {
    const html = render(two({ finalized: true, pickingOpen: false, billAmounts: { me: "27.06", sam: "11.60" } }));
    expect(html).not.toContain("action-bar");
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("Continue to Finalize");
    expect(html).toContain("$27.06");
  });
});

// ---- Against the database: the board agrees with preview, and the save
// plan converges through the real routes. ----

// Each test gets its own receipt, so nothing has to be deleted between them.
let receiptId = "";
let people: string[] = [];
let items: { id: string; totalPrice: string }[] = [];
let counter = 0;
const prices = ["16.00", "4.00", "10.01", "0.99"];

async function createReceipt() {
  const n = ++counter;
  receiptId = `picks-receipt-${n}`;
  people = [1, 2, 3].map((p) => `picks-${n}-p${p}`);
  items = prices.map((totalPrice, i) => ({ id: `picks-${n}-i${i + 1}`, totalPrice }));
  await prisma.receipt.create({
    data: {
      id: receiptId, ownerId: "picks-owner", title: "Picks", imageBlobName: "x.jpg", imageContentType: "image/jpeg",
      parseStatus: "SUCCEEDED", reviewedAt: new Date(), splitMode: "ITEMIZED",
      subtotal: "31.00", tax: "2.71", tip: "5.13", total: "38.84",
      items: { create: items.map((i, k) => ({ id: i.id, lineNumber: k + 1, name: `Item ${k + 1}`, quantity: "1", unitPrice: i.totalPrice, totalPrice: i.totalPrice, isVerified: true })) },
      participants: { create: people.map((id, k) => ({ id, displayName: `P${k}`, joinedAt: new Date(k * 1000) })) },
    },
  });
}

async function boardFromDb() {
  return form.toBoardReceipt(await getReceipt("picks-owner", receiptId));
}

async function run(step: NonNullable<ReturnType<typeof form.nextSaveStep>>) {
  const { path, method } = form.saveStepPath(receiptId, step);
  const handler = step.kind === "mode" ? PATCH : step.kind === "shared" ? PUT_SHARED : PUT_ASSIGNMENTS;
  const res = await handler(new Request(`http://test${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(step.body),
  }), { params: Promise.resolve({ id: receiptId }) });
  expect(res.status).toBe(200);
  return form.toBoardReceipt(await res.json());
}

async function saveDraft(draft: import("../app/receipts/[id]/picks/picks-form").Draft) {
  let saved = await boardFromDb();
  let sent = 0;
  for (let step = form.nextSaveStep(saved, draft); step; step = form.nextSaveStep(saved, draft)) {
    saved = await run(step);
    expect(++sent).toBeLessThanOrEqual(3);
  }
  return saved;
}

// Deterministic generated drafts: every item gets 1-3 of the people.
function generated(seed: number): Record<string, string[]> {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648);
  return Object.fromEntries(items.map((i) => {
    const picked = people.filter(() => next() % 2 === 0);
    return [i.id, picked.length ? picked : [people[next() % 3]]];
  }));
}

describe("against the routes", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: "picks-owner", name: "Owner", email: "picks-owner@example.com" } });
  });
  beforeEach(createReceipt);

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("saves generated draft %i and the board's amounts equal preview", async (seed) => {
    const initial = await boardFromDb();
    const draft = { split: "BY_ITEM" as const, people: generated(seed) };
    const saved = await saveDraft(draft);
    expect(form.isDirty(saved, draft)).toBe(false);
    expect(Object.fromEntries(saved.items.map((i) => [i.id, i.people]))).toEqual(
      Object.fromEntries(initial.items.map((i) => [i.id, draft.people[i.id]])),
    );
    const preview = await previewReceipt("picks-owner", receiptId, { expectedRevision: saved.revision });
    const view = form.boardView(saved);
    expect(view.people.map((p) => p.amount)).toEqual(
      preview.allocations.map((a) => form.dollars(BigInt(a.amountOwed.replace(".", "")))),
    );
  });

  it("goes from shared back to one person each, then to Even", async () => {
    await saveDraft({ split: "BY_ITEM", people: Object.fromEntries(items.map((i) => [i.id, people])) });
    const back = await saveDraft({ split: "BY_ITEM", people: Object.fromEntries(items.map((i) => [i.id, [people[1]]])) });
    expect(back.items.every((i) => i.people.length === 1 && i.people[0] === people[1])).toBe(true);
    const even = await saveDraft({ split: "EVEN", people: {} });
    expect(even.splitMode).toBe("EVEN");
    expect(even.items.every((i) => i.people.length === 0)).toBe(true);
    const preview = await previewReceipt("picks-owner", receiptId, { expectedRevision: even.revision });
    expect(form.boardView(even).people.map((p) => p.amount)).toEqual(
      preview.allocations.map((a) => form.dollars(BigInt(a.amountOwed.replace(".", "")))),
    );
  });
});
