// Picks board model (docs/specs/bills/split-screen.md): the board built from
// receipt detail, the editing draft, coverage, readiness, running totals
// formatted for display, and the save plan. Pure: no React, no fetch.
import { boardTotals } from "@project/domain/allocate";

type Money = { toString(): string } | string | null;

export type BoardPerson = {
  id: string;
  name: string;
  joinedAt: string;
  hasPickLink: boolean;
  done: boolean;
};

export type BoardItem = { id: string; name: string; totalPrice: string | null; people: string[] };

export type SplitMode = "EVEN" | "ITEMIZED" | "SHARED_ITEMS";

export type BoardReceipt = {
  id: string;
  revision: number;
  finalized: boolean;
  pickingOpen: boolean;
  splitMode: SplitMode;
  subtotal: string | null;
  tax: string | null;
  tip: string | null;
  total: string | null;
  organizerId: string | null;
  people: BoardPerson[];
  items: BoardItem[];
  // Finalized receipts: amount owed per participant, from their bills.
  billAmounts: Record<string, string> | null;
};

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());
const money = (value: Money) => (value === null ? null : value.toString());

export function toBoardReceipt(
  r: {
    id: string;
    revision: number;
    status: string;
    picksOpenedAt: Date | string | null;
    splitMode: string;
    subtotal: Money;
    tax: Money;
    tip: Money;
    total: Money;
    organizerParticipantId: string | null;
    participants: {
      id: string;
      displayName: string;
      joinedAt: Date | string;
      hasPickLink: boolean;
      picksSubmittedAt: Date | string | null;
    }[];
    items: {
      id: string;
      name: string | null;
      lineNumber: number;
      totalPrice: Money;
      assignedParticipantId: string | null;
      sharedAllocations: { participantId: string }[];
    }[];
  },
  bills: { participantId: string; amountOwed: string }[] | null = null,
): BoardReceipt {
  const organizerId = r.organizerParticipantId;
  // The organizer first, then the roster order.
  const people = [...r.participants]
    .sort((a, b) => Number(b.id === organizerId) - Number(a.id === organizerId))
    .map((p) => ({
      id: p.id,
      name: p.displayName,
      joinedAt: iso(p.joinedAt)!,
      hasPickLink: p.hasPickLink,
      done: p.picksSubmittedAt !== null,
    }));
  return {
    id: r.id,
    revision: r.revision,
    finalized: r.status === "FINALIZED",
    pickingOpen: r.status === "DRAFT" && r.picksOpenedAt !== null,
    splitMode: (["EVEN", "ITEMIZED", "SHARED_ITEMS"].includes(r.splitMode) ? r.splitMode : "ITEMIZED") as SplitMode,
    subtotal: money(r.subtotal),
    tax: money(r.tax),
    tip: money(r.tip),
    total: money(r.total),
    organizerId,
    people,
    items: [...r.items]
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((item) => ({
        id: item.id,
        name: item.name?.trim() || `Item ${item.lineNumber}`,
        totalPrice: money(item.totalPrice),
        people:
          item.assignedParticipantId !== null
            ? [item.assignedParticipantId]
            : item.sharedAllocations.map((s) => s.participantId),
      })),
    billAmounts: bills ? Object.fromEntries(bills.map((b) => [b.participantId, b.amountOwed])) : null,
  };
}

// ---- Editing draft ----

export type SplitChoice = "EVEN" | "BY_ITEM";

export type Draft = { split: SplitChoice; people: Record<string, string[]> };

export function draftFrom(receipt: BoardReceipt): Draft {
  return {
    split: receipt.splitMode === "EVEN" ? "EVEN" : "BY_ITEM",
    people: Object.fromEntries(receipt.items.map((item) => [item.id, receipt.splitMode === "EVEN" ? [] : item.people])),
  };
}

// The roster order, so a chip list and a request body never depend on the
// order people were checked.
function inRosterOrder(receipt: BoardReceipt, ids: string[]): string[] {
  const set = new Set(ids);
  return receipt.people.map((p) => p.id).filter((id) => set.has(id));
}

export function togglePerson(receipt: BoardReceipt, draft: Draft, itemId: string, personId: string): Draft {
  const current = draft.people[itemId] ?? [];
  const next = current.includes(personId) ? current.filter((id) => id !== personId) : [...current, personId];
  return { ...draft, people: { ...draft.people, [itemId]: inRosterOrder(receipt, next) } };
}

// By item saves as SHARED_ITEMS when any item has two or more people; a
// receipt already in SHARED_ITEMS stays there, since that needs no request.
export function draftMode(receipt: BoardReceipt, draft: Draft): SplitMode {
  if (draft.split === "EVEN") return "EVEN";
  if (receipt.splitMode === "SHARED_ITEMS") return "SHARED_ITEMS";
  return Object.values(draft.people).some((ids) => ids.length >= 2) ? "SHARED_ITEMS" : "ITEMIZED";
}

// The board as the draft would save it, for chips and totals.
export function applyDraft(receipt: BoardReceipt, draft: Draft): BoardReceipt {
  const splitMode = draftMode(receipt, draft);
  return {
    ...receipt,
    splitMode,
    items: receipt.items.map((item) => ({
      ...item,
      people: splitMode === "EVEN" ? [] : inRosterOrder(receipt, draft.people[item.id] ?? []),
    })),
  };
}

// ---- Save plan ----

export type SaveStep =
  | { kind: "mode"; body: { expectedRevision: number; splitMode: SplitMode } }
  | { kind: "shared"; body: { expectedRevision: number; allocations: { itemId: string; participantIds: string[] }[] } }
  | { kind: "assignments"; body: { expectedRevision: number; assignments: { itemId: string; participantId: string }[] } };

const key = (pairs: [string, string[]][]) =>
  JSON.stringify([...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// The next request a Save sends, given what the server holds now; null when
// the server already matches the draft. Save sends one step, takes the
// receipt it returns, and asks again, so a retry after a partial failure
// sends only what is still different.
export function nextSaveStep(saved: BoardReceipt, draft: Draft): SaveStep | null {
  const target = draftMode(saved, draft);
  const expectedRevision = saved.revision;
  if (target !== saved.splitMode) return { kind: "mode", body: { expectedRevision, splitMode: target } };
  if (target === "EVEN") return null;

  const want = applyDraft(saved, draft).items;
  if (target === "SHARED_ITEMS") {
    const wantShared = want.filter((i) => i.people.length >= 2).map((i): [string, string[]] => [i.id, i.people]);
    const haveShared = saved.items.filter((i) => i.people.length >= 2).map((i): [string, string[]] => [i.id, i.people]);
    if (key(wantShared) !== key(haveShared)) {
      return {
        kind: "shared",
        body: { expectedRevision, allocations: wantShared.map(([itemId, participantIds]) => ({ itemId, participantIds })) },
      };
    }
  }
  const wantOne = want.filter((i) => i.people.length === 1).map((i): [string, string[]] => [i.id, i.people]);
  const haveOne = saved.items.filter((i) => i.people.length === 1).map((i): [string, string[]] => [i.id, i.people]);
  if (key(wantOne) !== key(haveOne)) {
    return {
      kind: "assignments",
      body: { expectedRevision, assignments: wantOne.map(([itemId, [participantId]]) => ({ itemId, participantId })) },
    };
  }
  return null;
}

export function isDirty(saved: BoardReceipt, draft: Draft): boolean {
  return nextSaveStep(saved, draft) !== null;
}

export function saveStepPath(receiptId: string, step: SaveStep): { path: string; method: "PATCH" | "PUT" } {
  const base = `/api/receipts/${encodeURIComponent(receiptId)}`;
  if (step.kind === "mode") return { path: base, method: "PATCH" };
  if (step.kind === "shared") return { path: `${base}/shared-allocations`, method: "PUT" };
  return { path: `${base}/assignments`, method: "PUT" };
}

// Select all / Deselect all for one person in the draft.
export function setPersonOnAll(receipt: BoardReceipt, draft: Draft, personId: string, on: boolean): Draft {
  const people = Object.fromEntries(
    receipt.items.map((item) => {
      const current = (draft.people[item.id] ?? []).filter((id) => id !== personId);
      return [item.id, inRosterOrder(receipt, on ? [...current, personId] : current)];
    }),
  );
  return { ...draft, people };
}

// ---- The organizer's own picks while picking is open ----

export function organizerItems(receipt: BoardReceipt): string[] {
  const me = receipt.organizerId;
  if (me === null) return [];
  return receipt.items.filter((item) => item.people.includes(me)).map((item) => item.id);
}

export function toggleOwnItem(items: string[], itemId: string): string[] {
  return items.includes(itemId) ? items.filter((id) => id !== itemId) : [...items, itemId];
}

// The board with the organizer's pending toggles shown before the server
// confirms them.
export function withOwnItems(receipt: BoardReceipt, itemIds: string[]): BoardReceipt {
  const me = receipt.organizerId;
  if (me === null) return receipt;
  const mine = new Set(itemIds);
  return {
    ...receipt,
    items: receipt.items.map((item) => {
      const others = item.people.filter((id) => id !== me);
      return { ...item, people: inRosterOrder(receipt, mine.has(item.id) ? [...others, me] : others) };
    }),
  };
}

// ---- What the board shows ----

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function dollars(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? "-" : ""}${USD.format(Number(abs / 100n)).replace(/\.00$/, "")}.${(abs % 100n).toString().padStart(2, "0")}`;
}

function cents(value: string | null): bigint | null {
  if (value === null || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
}

function priceText(value: string | null): string {
  const c = cents(value);
  return c === null ? "—" : dollars(c);
}

export type Readiness = "Done" | "Still picking" | "No link";

export function readiness(person: BoardPerson): Readiness {
  if (person.done) return "Done";
  return person.hasPickLink ? "Still picking" : "No link";
}

// Avatar fills come from six tokens, by roster position (--color-person-*).
export const PERSON_COLORS = 6;

export function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase("en-US") : "?";
}

export type Avatar = { id: string; label: string; initial: string; color: number };

export type ItemView = {
  id: string;
  name: string;
  price: string;
  chips: Avatar[];
  shareNote: string | null;
  unclaimed: boolean;
};

export type PersonView = {
  id: string;
  name: string;
  isOrganizer: boolean;
  initial: string;
  color: number;
  done: boolean;
  readiness: Readiness | null;
  amount: string;
  // The organizer paid the restaurant, so their row is their share, not a debt.
  amountLabel: "Owes" | "Your share" | "Items so far";
};

export type BoardView = {
  even: boolean;
  items: ItemView[];
  people: PersonView[];
  // "2 items unclaimed · $14.00", or "Every item is claimed"; null in EVEN.
  claimSummary: string | null;
  allClaimed: boolean;
  doneSummary: string | null;
  totalsNote: string | null;
  // Every person's amount is known and they add up to the receipt total: the
  // board says so and offers Finalize. The formatted total, or null.
  matchedTotal: string | null;
};

export function boardView(receipt: BoardReceipt): BoardView {
  const even = receipt.splitMode === "EVEN";
  const names = new Map(receipt.people.map((p) => [p.id, p.id === receipt.organizerId ? "You" : p.name]));
  const avatars = new Map(
    receipt.people.map((p, index): [string, Avatar] => [
      p.id,
      { id: p.id, label: names.get(p.id)!, initial: initialOf(p.name), color: (index % PERSON_COLORS) + 1 },
    ]),
  );
  const totals = boardTotals({
    splitMode: receipt.splitMode,
    subtotal: receipt.subtotal,
    tax: receipt.tax,
    tip: receipt.tip,
    participants: receipt.people,
    items: receipt.items,
  });
  const rows = new Map(totals.rows.map((row) => [row.participantId, row]));
  const guests = receipt.people.filter((p) => p.id !== receipt.organizerId);
  const bills = receipt.billAmounts;

  let owedSum = 0n;
  let allOwed = receipt.people.length > 0;
  const people = receipt.people.map((p): PersonView => {
    const row = rows.get(p.id)!;
    const billed = bills?.[p.id];
    const owedCents = billed !== undefined ? cents(billed) : row.amountOwed;
    const owed = owedCents === null ? null : dollars(owedCents);
    if (owedCents !== null) owedSum += owedCents;
    else allOwed = false;
    return {
      id: p.id,
      name: names.get(p.id)!,
      isOrganizer: p.id === receipt.organizerId,
      initial: avatars.get(p.id)!.initial,
      color: avatars.get(p.id)!.color,
      done: p.done,
      readiness: p.id === receipt.organizerId ? null : readiness(p),
      amount: owed ?? dollars(row.itemsCents),
      amountLabel: owed === null ? "Items so far" : p.id === receipt.organizerId ? "Your share" : "Owes",
    };
  });

  const unclaimedCount = totals.unclaimedCount;
  const total = cents(receipt.total);
  return {
    even,
    items: receipt.items.map((item) => ({
      id: item.id,
      name: item.name,
      price: priceText(item.totalPrice),
      chips: even ? [] : item.people.filter((id) => avatars.has(id)).map((id) => avatars.get(id)!),
      shareNote: !even && item.people.length >= 2 ? `Split ${item.people.length} ways` : null,
      unclaimed: !even && item.people.length === 0,
    })),
    people,
    claimSummary: even
      ? null
      : unclaimedCount === 0
        ? "Every item is claimed"
        : `${unclaimedCount} ${unclaimedCount === 1 ? "item" : "items"} unclaimed · ${dollars(totals.unclaimedCents)}`,
    allClaimed: !even && unclaimedCount === 0,
    doneSummary: guests.length ? `${guests.filter((p) => p.done).length} of ${guests.length} done` : null,
    totalsNote:
      totals.owed || bills
        ? null
        : unclaimedCount > 0
          ? "Tax and tip are added once every item is claimed."
          : "Tax and tip are added once the items match the subtotal.",
    matchedTotal: allOwed && total !== null && owedSum === total ? dollars(total) : null,
  };
}

// The totals bar's line for the selected person: "Your share", "Sam owes",
// or "Sam's items so far" before every item is claimed.
export function totalLabel(person: PersonView): string {
  if (person.amountLabel === "Items so far") return person.isOrganizer ? "Your items so far" : `${person.name}'s items so far`;
  if (person.amountLabel === "Your share") return "Your share";
  return `${person.name} owes`;
}

export function selectedCount(receipt: BoardReceipt, personId: string): number {
  return receipt.items.filter((item) => item.people.includes(personId)).length;
}

export function selectedText(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"} selected`;
}

// Whether the board may change this person's items: anyone while editing,
// only the organizer while picking is open (ADR-0017), nobody in EVEN or
// once finalized.
export function changeable(receipt: BoardReceipt, personId: string): boolean {
  if (receipt.finalized || receipt.splitMode === "EVEN") return false;
  return !receipt.pickingOpen || personId === receipt.organizerId;
}
