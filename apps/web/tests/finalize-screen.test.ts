// Finalize screen (docs/specs/receipts/finalize-screen.md): the display model
// and static renders of its states. No DOM, no database.
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
// The panel uses the app router; static renders have none.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
import { MarkPaid } from "../app/receipts/[id]/finalize/MarkPaid";
import { FinalizePanel, type FinalizePanelProps } from "../app/receipts/[id]/finalize/FinalizePanel";
import { BackToReceipts, WhoOwes } from "../app/receipts/[id]/finalize/WhoOwes";
import {
  type Allocation,
  type SummaryBill,
  type SummaryParticipant,
  type SummaryReceipt,
  buildSummary,
  confirmationText,
  mismatchMessages,
  owingText,
  paymentOf,
  readinessLabel,
  stillPickingText,
  unmarkText,
} from "../app/receipts/[id]/finalize/summary";

const people: SummaryParticipant[] = [
  { id: "me", displayName: "Alex", hasPickLink: false, picksSubmittedAt: null },
  { id: "maya", displayName: "Maya", hasPickLink: true, picksSubmittedAt: "2026-11-13T00:00:00.000Z" },
  { id: "sam", displayName: "Sam", hasPickLink: true, picksSubmittedAt: null },
  { id: "jo", displayName: "Jo", hasPickLink: false, picksSubmittedAt: null },
];

const item = (lineNumber: number, name: string | null, totalPrice: string, who: string[]) => ({
  lineNumber, name, totalPrice,
  assignedParticipantId: who.length === 1 ? who[0] : null,
  sharedAllocations: who.length === 1 ? [] : who.map((participantId) => ({ participantId })),
});

// Salmon 16 (Alex), Miso 4 (Sam), Edamame 10 shared three ways; Jo had nothing.
const receipt = (patch: Partial<SummaryReceipt> = {}): SummaryReceipt => ({
  currency: "USD", splitMode: "SHARED_ITEMS", organizerParticipantId: "me", participants: people,
  items: [item(3, "Edamame", "10.00", ["me", "maya", "sam"]), item(1, "Salmon", "16.00", ["me"]), item(2, null, "4.00", ["sam"])],
  ...patch,
});

const allocation = (participantId: string, subtotal: string, taxShare: string, tipShare: string, amountOwed: string): Allocation =>
  ({ participantId, subtotal, taxShare, tipShare, amountOwed });

const picked = [
  allocation("me", "19.34", "1.55", "2.90", "23.79"),
  allocation("maya", "3.33", "0.27", "0.50", "4.10"),
  allocation("sam", "7.33", "0.58", "1.10", "9.01"),
  allocation("jo", "0.00", "0.00", "0.00", "0.00"),
];

// Stored bills for allocations, as the bill projection returns them; "me" paid
// the restaurant. paidAt maps a participant to the time they paid back.
const PAYER = "me";
const billed = (allocations: Allocation[], paidAt: Record<string, string> = {}): SummaryBill[] =>
  allocations.map((a) => {
    const settled = a.participantId === PAYER || a.amountOwed === "0.00" || a.participantId in paidAt;
    return {
      ...a, id: `bill-${a.participantId}`, paidAt: paidAt[a.participantId] ?? null,
      settled, outstandingAmount: settled ? "0.00" : a.amountOwed,
    };
  });
const finalReceipt = (patch: Partial<SummaryReceipt> = {}) => receipt({ paidByParticipantId: PAYER, ...patch });

const even = [
  allocation("me", "3.34", "0.00", "0.00", "3.34"),
  allocation("maya", "3.33", "0.00", "0.00", "3.33"),
  allocation("sam", "3.33", "0.00", "0.00", "3.33"),
];

describe("readiness", () => {
  it("labels each guest from the receipt detail; the organizer has none", () => {
    const label = (id: string) => readinessLabel(people.find((p) => p.id === id)!, "ITEMIZED", "me");
    expect(["me", "maya", "sam", "jo"].map(label)).toEqual([null, "Done picking", "Still picking", "No link"]);
  });

  it("shows no readiness under EVEN", () => {
    expect(readinessLabel(people[1], "EVEN", "me")).toBeNull();
  });
});

describe("buildSummary", () => {
  it("keeps the allocations' order, names the organizer You, and writes each card's quiet line", () => {
    const summary = buildSummary(picked, receipt(), false);
    expect(summary.rows.map((r) => [r.name, r.line, r.owes, r.expandable])).toEqual([
      ["You", "Your share · 2 items", "$23.79", true],
      ["Maya", "Done picking · 1 item", "$4.10", true],
      ["Sam", "Still picking · 2 items", "$9.01", true],
      ["Jo", "No link · 0 items", "$0.00", false],
    ]);
    expect(summary.totals).toEqual({ subtotal: "$30.00", discount: "$0.00", tax: "$2.40", tip: "$4.50", owes: "$36.90" });
    expect(summary.hasDiscount).toBe(false);
  });

  it("lists each person's items in line order, shares marked, adding up to their Items amount", () => {
    const rows = buildSummary(picked, receipt(), false).rows;
    expect(rows[0].items).toEqual([{ label: "Salmon", amount: "$16.00" }, { label: "Edamame (1/3)", amount: "$3.34" }]);
    expect(rows[2].items).toEqual([{ label: "Item 2", amount: "$4.00" }, { label: "Edamame (1/3)", amount: "$3.33" }]);
    expect(rows[3].items).toEqual([]);
  });

  it("swaps readiness for payment state once finalized, keeping You and the item count", () => {
    const rows = buildSummary(billed(picked, { sam: "2026-11-20T15:00:00.000Z" }), finalReceipt(), true).rows;
    expect(rows.map((r) => r.line)).toEqual([
      "Your share · Paid the receipt · 2 items",
      "Not paid back yet · 1 item",
      "Paid back · 2 items",
      "Nothing owed · 0 items",
    ]);
    expect(rows.every((r) => r.readiness === null)).toBe(true);
    expect(rows.map((r) => r.payment?.state)).toEqual(["payer", "unpaid", "paid", "zero"]);
  });

  it("has no payment state on a draft", () => {
    expect(buildSummary(picked, receipt(), false).rows.every((r) => r.payment === null)).toBe(true);
    expect(buildSummary(picked, receipt(), false).owing).toBeNull();
  });

  it("says Even split under EVEN, with no items but an openable breakdown", () => {
    const rows = buildSummary(even, receipt({ splitMode: "EVEN" }), false).rows;
    expect(rows.map((r) => r.line)).toEqual(["Your share · Even split", "Even split", "Even split"]);
    expect(rows.every((r) => r.items.length === 0 && r.expandable)).toBe(true);
  });

  it("shows each person's discount share as a negative amount", () => {
    const summary = buildSummary(
      [
        { participantId: "maya", subtotal: "20.00", discountShare: "2.00", taxShare: "1.80", tipShare: "4.00", amountOwed: "23.80" },
        { participantId: "sam", subtotal: "10.00", discountShare: "1.00", taxShare: "0.90", tipShare: "2.00", amountOwed: "11.90" },
      ],
      receipt({ items: [] }), false,
    );
    expect(summary.hasDiscount).toBe(true);
    expect(summary.rows.map((r) => r.discount)).toEqual(["-$2.00", "-$1.00"]);
    expect(summary.totals).toMatchObject({ discount: "-$3.00", owes: "$35.70" });
  });

  it("sums cents without float drift", () => {
    expect(buildSummary(billed(even), finalReceipt({ splitMode: "EVEN" }), true).totals.owes).toBe("$10.00");
  });
});

describe("still picking line", () => {
  it("counts guests still picking, singular and plural, and is absent at zero", () => {
    expect(stillPickingText(1)).toBe("1 person is still picking");
    expect(stillPickingText(2)).toBe("2 people are still picking");
    expect(stillPickingText(0)).toBeNull();
  });

  it("counts only Still picking people: not No link, not EVEN, not finalized", () => {
    expect(buildSummary(picked, receipt(), false).stillPicking).toBe("1 person is still picking");
    expect(buildSummary(even, receipt({ splitMode: "EVEN" }), false).stillPicking).toBeNull();
    expect(buildSummary(billed(picked), finalReceipt(), true).stillPicking).toBeNull();
  });
});

describe("avatars", () => {
  it("colors people by Picks roster position (organizer first, then join order), not row order", () => {
    const rows = ["sam", "maya", "jo", "me"].map((id) => allocation(id, "0.00", "0.00", "0.00", "0.00"));
    const pick = (finalized: boolean, organizer = "me") => {
      const r = receipt({ items: [], organizerParticipantId: organizer });
      const summary = finalized ? buildSummary(billed(rows), r, true) : buildSummary(rows, r, false);
      return summary.rows.map((row) => [row.initial, row.color]);
    };
    const expected = [["S", 3], ["M", 2], ["J", 4], ["A", 1]];
    expect(pick(false)).toEqual(expected);
    expect(pick(true)).toEqual(expected);
    // An organizer who joined later still comes first.
    expect(pick(true, "jo")[2]).toEqual(["J", 1]);
  });
});

describe("payment", () => {
  it("says who still owes in the list's wording, singular and plural", () => {
    expect(owingText(billed(picked), "USD")).toBe("2 still owe · $13.11 left");
    expect(owingText(billed(picked, { maya: "2026-11-20T00:00:00.000Z" }), "USD")).toBe("1 still owes · $9.01 left");
    expect(owingText(billed(picked, { maya: "2026-11-20T00:00:00.000Z", sam: "2026-11-21T00:00:00.000Z" }), "USD"))
      .toBe("Everyone has paid you back.");
    expect(buildSummary(billed(picked), finalReceipt(), true).owing).toBe("2 still owe · $13.11 left");
  });

  it("counts the payer as settled before zero, and dates a paid-back bill", () => {
    const [me, maya, sam, jo] = billed(picked, { me: "2026-11-19T00:00:00.000Z", sam: "2026-11-20T23:30:00.000Z" });
    expect(paymentOf(me, PAYER)).toEqual({ state: "payer" });
    expect(paymentOf(maya, PAYER)).toEqual({ state: "unpaid", billId: "bill-maya" });
    expect(paymentOf(sam, PAYER)).toEqual({ state: "paid", billId: "bill-sam", paidOn: "Nov 20, 2026" });
    expect(paymentOf(jo, PAYER)).toEqual({ state: "zero" });
    // Without a recorded payer, the organizer's unpaid bill can be marked.
    expect(paymentOf(me, null).state).toBe("paid");
  });

  it("warns that unmarking loses the date", () => {
    expect(unmarkText("Sam", "Nov 20, 2026")).toBe(
      "This clears the Nov 20, 2026 paid-back date. If Sam is marked paid back again, today's date is recorded instead.",
    );
  });

  const finalized = () => renderToStaticMarkup(h(WhoOwes, {
    summary: buildSummary(billed(picked, { sam: "2026-11-20T15:00:00.000Z" }), finalReceipt(), true),
  }));

  it("gives a payment row only to cards that can be marked, outside the disclosure", () => {
    const html = finalized();
    expect(html).toContain("1 still owes · $4.10 left");
    expect(html.match(/aria-label="Mark [^"]+"/g)).toEqual(['aria-label="Mark Maya paid back"', 'aria-label="Mark Sam unpaid"']);
    // No button sits inside a <summary>.
    for (const summary of html.match(/<summary[\s\S]*?<\/summary>/g) ?? []) expect(summary).not.toContain("<button");
    expect(html).toContain("Paid back Nov 20, 2026");
  });

  it("labels both states and names the person", () => {
    const unpaid = renderToStaticMarkup(h(MarkPaid, { name: "Maya", payment: { state: "unpaid", billId: "b1" } }));
    expect(unpaid).toMatch(/<button[^>]*aria-label="Mark Maya paid back"[^>]*>Mark paid back<\/button>/);
    expect(unpaid).not.toContain("Paid back ");
    const paid = renderToStaticMarkup(h(MarkPaid, { name: "Sam", payment: { state: "paid", billId: "b2", paidOn: "Nov 20, 2026" } }));
    expect(paid).toMatch(/<button[^>]*aria-label="Mark Sam unpaid"[^>]*>Mark unpaid<\/button>/);
    expect(paid).toContain("Paid back Nov 20, 2026");
  });
});

describe("mismatch sentences", () => {
  const check = (itemsDifference: string | null, amountsDifference: string | null) =>
    mismatchMessages({ itemsDifference, amountsDifference, reconciled: false }, "USD");

  it("says short or over from the signed differences", () => {
    expect(check("2.50", "0.00")).toEqual(["The items are $2.50 short of the subtotal."]);
    expect(check("-2.50", "0.00")).toEqual(["The items are $2.50 over the subtotal."]);
    expect(check("0.00", "1.00")).toEqual(["Subtotal, tax and tip are $1.00 short of the total."]);
    expect(check("0.00", "-1.00")).toEqual(["Subtotal, tax and tip are $1.00 over the total."]);
  });

  it("names the discount in the amounts sentence when the receipt has one", () => {
    expect(mismatchMessages({ itemsDifference: "0.00", amountsDifference: "1.00", reconciled: false }, "USD", true))
      .toEqual(["Subtotal, discount, tax and tip are $1.00 short of the total."]);
  });

  it("says amounts are missing when a difference is null", () => {
    expect(check(null, "0.00")).toEqual(["Some item prices or amounts are missing."]);
    expect(check(null, null)).toEqual(["Some item prices or amounts are missing."]);
  });
});

describe("confirmation text", () => {
  it("counts the bills and names the total", () => {
    expect(confirmationText(3, "$10.00")).toBe("This creates 3 bills totaling $10.00. The receipt can't be edited after this.");
    expect(confirmationText(1, "$5.00")).toMatch(/^This creates 1 bill totaling/);
  });
});

describe("static renders", () => {
  const render = (summary: ReturnType<typeof buildSummary>) => renderToStaticMarkup(h(WhoOwes, { summary }));

  it("renders one closed card per person, the list labelled by its heading, and the receipt total", () => {
    const html = render(buildSummary(picked, receipt(), false));
    expect(html).toMatch(/<h2 id="who-owes-heading"[^>]*>Who owes what<\/h2>/);
    expect(html).toMatch(/<ul aria-labelledby="who-owes-heading"/);
    expect(html).toContain("1 person is still picking");
    expect(html.match(/<details/g)).toHaveLength(3);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toMatch(/<summary[^>]*>[\s\S]*?You[\s\S]*?Your share · 2 items[\s\S]*?\$23\.79/);
    expect(html).toContain("$36.90");
    expect(html).toContain("Matches the receipt");
    expect(html).not.toContain("data-slot=\"badge\"");
    expect(html).not.toContain(">You</span><span data-slot");
  });

  it("puts the items, then Subtotal, Tax, Tip and Total inside each card", () => {
    const html = render(buildSummary(picked, receipt(), false));
    const you = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(you.indexOf("Salmon")).toBeLessThan(you.indexOf("Edamame (1/3)"));
    expect(you).toMatch(/<dt>Subtotal<\/dt><dd[^>]*>\$19\.34<\/dd>[\s\S]*<dt>Tax<\/dt>[\s\S]*<dt>Tip<\/dt>[\s\S]*<dt>Total<\/dt><dd[^>]*>\$23\.79<\/dd>/);
    expect(you).not.toContain("Discount");
  });

  it("shows the Discount line inside cards when the receipt has one", () => {
    const html = render(buildSummary(
      [{ participantId: "maya", subtotal: "20.00", discountShare: "2.00", taxShare: "1.80", tipShare: "4.00", amountOwed: "23.80" }],
      receipt({ items: [item(1, "Salad", "20.00", ["maya"])] }), false,
    ));
    expect(html).toMatch(/<dt>Discount<\/dt><dd[^>]*>-\$2\.00<\/dd>/);
  });

  it("draws a person with no items as a plain card that doesn't open", () => {
    const html = render(buildSummary(picked, receipt(), false));
    const jo = html.slice(html.lastIndexOf("</details>"));
    expect(jo).toContain("No link · 0 items");
    expect(jo).not.toContain("<details");
  });

  it("draws the Picks avatar beside each name", () => {
    const html = render(buildSummary(picked, receipt(), false));
    expect(html).toMatch(/<span aria-hidden="true" class="[^"]*size-12[^"]*bg-person-1[^"]*">A<\/span>/);
  });

  it("links a finalized receipt back to the list", () => {
    expect(renderToStaticMarkup(h(BackToReceipts))).toMatch(/<a[^>]*href="\/"[^>]*>Back to receipts<\/a>/);
  });

  it("shows a preview conflict inline with Reload and a disabled Finalize", () => {
    const html = panel({
      disabledReason: "Reload to see the latest amounts",
      initialError: { message: "Receipt has changed; reload before previewing", conflict: true },
    });
    expect(html).toContain("Receipt has changed; reload before previewing");
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Finalize<\/button>/);
    expect(html).toContain("Reload to see the latest amounts");
  });

  const panel = (overrides: Partial<FinalizePanelProps> = {}) => renderToStaticMarkup(h(FinalizePanel, {
    receiptId: "r1", revision: 4, pickingOpen: false, disabledReason: null, billCount: 3, total: "$10.00", ...overrides,
  }));

  it("labels the button by picking mode", () => {
    expect(panel()).toMatch(/<button[^>]*>Finalize<\/button>/);
    expect(panel({ pickingOpen: true })).toContain("Pause picking and finalize");
  });

  it("disables the button and says why when the receipt doesn't add up", () => {
    const html = panel({ disabledReason: "Fix the totals first" });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Finalize<\/button>/);
    expect(html).toContain("Fix the totals first");
    expect(panel()).not.toMatch(/<button[^>]*disabled=""[^>]*>Finalize<\/button>/);
  });
});
