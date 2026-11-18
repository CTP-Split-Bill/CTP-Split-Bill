// The home list (docs/specs/bills/list-screen.md): sections by what each
// receipt needs next, row status copy, and the ⋯ menu as its own Tab stop.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReceiptSummary } from "@project/domain";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const { BillList, Sections } = await import("../app/BillList");
const { deleteDialogCopy, listSummary, receiptName, receiptSection, receiptState, receiptStatus, rowLabel, sumMoney, toBillRowProps } =
  await import("../app/lib/format");

function summary(patch: Partial<ReceiptSummary> = {}): ReceiptSummary {
  return {
    id: "r 1", status: "DRAFT", merchantName: "Noodle Bar", title: null, total: "12.50",
    createdAt: "2026-11-02T00:00:00.000Z", payerName: null, participantCount: 2,
    settled: null, unpaidCount: null, outstanding: null, nextStep: "items", picks: null, ...patch,
  };
}

const finalized = (unpaidCount: number | null, outstanding: string | null = null) =>
  ({ status: "FINALIZED", nextStep: null, unpaidCount, outstanding, settled: unpaidCount === null ? null : unpaidCount === 0 }) as const;

function toItem(r: ReceiptSummary) {
  return {
    id: r.id, name: receiptName(r), section: receiptSection(r), row: toBillRowProps(r), dialog: deleteDialogCopy(r),
    outstanding: r.outstanding, unpaidCount: r.unpaidCount,
  };
}

function renderSections(receipts: ReceiptSummary[], editing: boolean) {
  const items = receipts.map(toItem);
  return renderToStaticMarkup(h(Sections, {
    sections: [{ key: "progress", items }], editing, settledOpen: true, onToggleSettled() {},
    settledId: "s", registerTrigger() {}, onDelete() {},
  }));
}

function render(receipts: ReceiptSummary[]) {
  return renderToStaticMarkup(h(BillList, {
    empty: h("p", null, "EMPTY"),
    items: receipts.map((r) => ({
      id: r.id, name: receiptName(r), section: receiptSection(r), row: toBillRowProps(r), dialog: deleteDialogCopy(r),
      outstanding: r.outstanding, unpaidCount: r.unpaidCount,
    })),
  }));
}

describe("BillList", () => {
  it("hides delete controls until Edit, behind one Edit toggle", () => {
    const html = render([summary(), summary({ id: "r 2", merchantName: "Taco Bar" })]);
    expect(html).toMatch(/<button[^>]*>Edit<\/button>/);
    expect(html).not.toContain('aria-label="Delete');
  });

  it("in Edit mode, puts a Delete button beside each row link, not inside it", () => {
    const html = renderSections([summary()], true);
    const link = html.match(/<a[^>]*href="\/receipts\/r%201"[^>]*>[\s\S]*?<\/a>/)?.[0];
    expect(link).toContain("Noodle Bar");
    expect(link).toContain('aria-label="Noodle Bar, $12.50, Next: check items"');
    expect(link).not.toContain("<button");
    const after = html.slice(html.indexOf(link!) + link!.length);
    expect(after).toMatch(/<button[^>]*aria-label="Delete Noodle Bar"[^>]*>Delete<\/button>/);
    expect(renderSections([summary()], false)).not.toContain('aria-label="Delete');
  });

  it("groups receipts into sections in order and hides empty ones", () => {
    const html = render([
      summary({ id: "paid", merchantName: "Paid Place", ...finalized(0, "0.00") }),
      summary({ id: "draft", merchantName: "Draft Diner" }),
    ]);
    expect(html).toMatch(/>In progress <span[^>]*>1<\/span><\/h2>/);
    expect(html).not.toContain("Waiting on payment");
    expect(html.indexOf("In progress")).toBeLessThan(html.indexOf(">Settled <"));
  });

  it("collapses Settled behind a toggle when other sections exist", () => {
    const html = render([
      summary({ id: "paid", merchantName: "Paid Place", ...finalized(0, "0.00") }),
      summary({ id: "owed", merchantName: "Owed Grill", ...finalized(1, "9.00") }),
    ]);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>[\s\S]*Settled <span[^>]*>1<\/span><\/button>/);
    expect(html).toContain("$9.00 left");
    expect(html).toContain("Owed Grill");
    expect(html).not.toContain("Paid Place");
  });

  it("shows Settled open with a plain heading when it is the only section", () => {
    const html = render([summary({ id: "paid", merchantName: "Paid Place", ...finalized(0, "0.00") })]);
    expect(html).toMatch(/<h2[^>]*>Settled <span[^>]*>1<\/span><\/h2>/);
    expect(html).not.toContain('aria-controls');
    expect(html).toContain("Paid Place");
  });

  it("shows the empty state when there are no receipts", () => {
    expect(render([])).toBe("<p>EMPTY</p>");
  });
});

describe("receiptSection", () => {
  it.each([
    { name: "a draft", patch: {}, section: "progress" },
    { name: "someone still owing", patch: finalized(2, "48.20"), section: "owed" },
    { name: "all paid", patch: finalized(0, "0.00"), section: "settled" },
    { name: "no bills", patch: finalized(null), section: "settled" },
  ])("puts $name in $section", ({ patch, section }) => {
    expect(receiptSection(summary(patch as Partial<ReceiptSummary>))).toBe(section);
  });
});

describe("receiptStatus", () => {
  it.each([
    { patch: { nextStep: "scan" }, status: "Next: check the scan" },
    { patch: { nextStep: "items" }, status: "Next: check items" },
    { patch: { nextStep: "participants" }, status: "Next: add people" },
    { patch: { nextStep: "picks" }, status: "Next: assign items" },
    { patch: { nextStep: "picks", picks: { open: false, done: 0, total: 3 } }, status: "Next: assign items" },
    { patch: { nextStep: "picks", picks: { open: false, done: 2, total: 3 } }, status: "Next: assign items · 2 of 3 done" },
    { patch: { nextStep: "picks", picks: { open: true, done: 2, total: 3 } }, status: "Picks open · 2 of 3 done" },
    { patch: { nextStep: "finalize", picks: { open: true, done: 3, total: 3 } }, status: "Picks open · 3 of 3 done" },
    { patch: { nextStep: "finalize" }, status: "Next: finalize" },
    { patch: finalized(2, "48.20"), status: "2 still owe · $48.20 left" },
    { patch: finalized(1, "9.00"), status: "1 still owes · $9.00 left" },
    { patch: finalized(0, "0.00"), status: "All paid" },
    { patch: finalized(null), status: "Finalized" },
  ])("reads $status", ({ patch, status }) => {
    expect(receiptStatus(summary(patch as Partial<ReceiptSummary>))).toBe(status);
  });
});

describe("toBillRowProps and rowLabel", () => {
  it("formats money and date and marks only nameless, totalless drafts untitled", () => {
    expect(toBillRowProps(summary())).toEqual({
      name: "Noodle Bar", untitled: false, total: "$12.50", date: "Nov 2, 2026", status: "Next: check items",
      state: "your-move", stepsDone: 1,
    });
    expect(toBillRowProps(summary(finalized(0, "0.00"))).stepsDone).toBeNull();
    const blank = toBillRowProps(summary({ merchantName: null, total: null, nextStep: "scan" }));
    expect(blank).toMatchObject({ name: "Untitled receipt", untitled: true, total: "—" });
    expect(toBillRowProps(summary({ merchantName: null })).untitled).toBe(false);
  });

  it("leaves a missing total out of the accessible name", () => {
    const row = toBillRowProps(summary({ merchantName: null, total: null, nextStep: "scan" }));
    expect(rowLabel(row)).toBe("Untitled receipt, Next: check the scan");
  });

  it("reads the status separator as a comma", () => {
    const row = toBillRowProps(summary({ nextStep: "picks", picks: { open: true, done: 2, total: 3 } }));
    expect(rowLabel(row)).toBe("Noodle Bar, $12.50, Picks open, 2 of 3 done");
  });
});

describe("deleteDialogCopy", () => {
  it.each([
    { name: "a draft", patch: {}, copy: { people: "2 people", warning: null } },
    { name: "one participant", patch: { participantCount: 1 }, copy: { people: "1 person", warning: null } },
    { name: "a finalized receipt with no one owing", patch: finalized(0, "0.00"), copy: { people: "2 people", warning: null } },
    { name: "a finalized receipt without bills", patch: finalized(null), copy: { people: "2 people", warning: null } },
    { name: "one person owing", patch: finalized(1, "9.00"), copy: { people: "2 people", warning: "1 person still owes $9.00. Their links will stop working." } },
    { name: "several owing", patch: finalized(3, "48.20"), copy: { people: "2 people", warning: "3 people still owe $48.20. Their links will stop working." } },
  ])("words $name", ({ patch, copy }) => {
    expect(deleteDialogCopy(summary(patch as Partial<ReceiptSummary>))).toEqual(copy);
  });
});

describe("receiptState", () => {
  it.each([
    { name: "a draft at a step", patch: {}, state: "your-move" },
    { name: "a draft with picks open", patch: { picks: { open: true, done: 0, total: 2 } }, state: "waiting" },
    { name: "a draft with picks paused", patch: { picks: { open: false, done: 1, total: 2 } }, state: "your-move" },
    { name: "someone still owing", patch: finalized(1, "9.00"), state: "waiting" },
    { name: "all paid", patch: finalized(0, "0.00"), state: "done" },
    { name: "no bills", patch: finalized(null), state: "done" },
  ])("is $state for $name", ({ patch, state }) => {
    expect(receiptState(summary(patch as Partial<ReceiptSummary>))).toBe(state);
  });
});

describe("listSummary", () => {
  const owed = (outstanding: string, unpaidCount: number) => ({ section: "owed" as const, outstanding, unpaidCount });
  const draft = { section: "progress" as const, outstanding: null, unpaidCount: null };
  const settled = { section: "settled" as const, outstanding: "0.00", unpaidCount: 0 };

  it("adds money exactly and counts the people who owe", () => {
    expect(sumMoney(["0.10", "0.20", null])).toBe("0.30");
    expect(listSummary([owed("40.10", 1), owed("8.10", 2), draft])).toEqual({ amount: "$48.20", text: "from 3 people · 1 receipt to finish" });
  });

  it.each([
    { name: "one person owing, nothing to finish", list: [owed("9.00", 1), settled], summary: { amount: "$9.00", text: "from 1 person" } },
    { name: "only drafts", list: [draft, draft], summary: { amount: null, text: "2 receipts to finish" } },
    { name: "everything settled", list: [settled], summary: { amount: null, text: "Everyone has paid you back." } },
  ])("reads $name", ({ list, summary }) => {
    expect(listSummary(list)).toEqual(summary);
  });
});
