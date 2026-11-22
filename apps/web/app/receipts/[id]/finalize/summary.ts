// Display model for the finalize screen (docs/specs/receipts/finalize-screen.md):
// per-person cards, readiness, mismatch sentences and confirmation text. Pure, with
// no database import, so it is unit-tested directly.
import { personItems } from "@project/domain/allocate";
import { formatDate } from "../../../lib/format";
import { PERSON_COLORS, initialOf } from "../picks/picks-form";

// discount is the person's share of the receipt discount, formatted as a
// negative amount ("-$2.50").
export type Amounts = { subtotal: string; discount: string; tax: string; tip: string; owes: string };

// One line of a person's open card: "Edamame (1/3)" and their part, "$3.34".
export type SummaryItem = { label: string; amount: string };

// A finalized card's payment state. Only "unpaid" and "paid" cards can be
// marked; the payer's own bill and a zero bill are settled already.
export type Payment =
  | { state: "payer" | "zero" }
  | { state: "unpaid"; billId: string }
  | { state: "paid"; billId: string; paidOn: string };

export type SummaryRow = Amounts & {
  participantId: string;
  // "You" for the organizer, as on the Picks screen.
  name: string;
  // The participant's own name, for labels that can't say "You".
  displayName: string;
  // Guest readiness on a draft ("Done picking"), or null.
  readiness: string | null;
  // The quiet line under the name: "Done picking · 3 items", "Your share · 1 item".
  line: string;
  // The Picks screen's avatar: initial and color 1–PERSON_COLORS.
  initial: string;
  color: number;
  items: SummaryItem[];
  // Whether the card opens: someone with items, or anyone on an EVEN split.
  expandable: boolean;
  // Finalized receipts only; null on a draft.
  payment: Payment | null;
};

// hasDiscount: the receipt has a discount, so each breakdown shows it.
// stillPicking: "2 people are still picking", or null.
// owing: "2 still owe · $48.20 left" on a finalized receipt, or null on a draft.
export type Summary = {
  rows: SummaryRow[];
  totals: Amounts;
  hasDiscount: boolean;
  stillPicking: string | null;
  owing: string | null;
};

// One person's amounts as previewed or billed, two-decimal strings.
export type Allocation = {
  participantId: string;
  subtotal: string;
  // Absent on receipts without a discount.
  discountShare?: string;
  taxShare: string;
  tipShare: string;
  amountOwed: string;
};

// A stored bill: an allocation plus what the bill projection adds
// (packages/domain/src/bills.ts).
export type SummaryBill = Allocation & {
  id: string;
  paidAt: Date | string | null;
  settled: boolean;
  outstandingAmount: string;
};

export type SummaryParticipant = {
  id: string;
  displayName: string;
  hasPickLink: boolean;
  picksSubmittedAt: Date | string | null;
};

type Money = { toString(): string } | string | null;

export type SummaryReceiptItem = {
  name: string | null;
  lineNumber: number;
  totalPrice: Money;
  assignedParticipantId: string | null;
  sharedAllocations: { participantId: string }[];
};

// The receipt detail fields the summary reads.
export type SummaryReceipt = {
  currency: string;
  splitMode: string;
  organizerParticipantId: string | null;
  // Who paid the restaurant; their own bill is settled (bills/list.md).
  paidByParticipantId?: string | null;
  participants: SummaryParticipant[];
  items: SummaryReceiptItem[];
};

export type TotalsCheck = {
  itemsDifference: string | null;
  amountsDifference: string | null;
  reconciled: boolean;
};

// Two-decimal strings to integer cents, so column sums are exact.
function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -amount : amount;
}

function fromCents(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export function formatAmount(value: string, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value));
}

// A guest's readiness on a draft. The organizer and EVEN splits have none.
export function readinessLabel(
  participant: SummaryParticipant,
  splitMode: string,
  organizerParticipantId: string | null,
): string | null {
  if (participant.id === organizerParticipantId || splitMode === "EVEN") return null;
  if (participant.picksSubmittedAt !== null) return "Done picking";
  if (participant.hasPickLink) return "Still picking";
  return "No link";
}

// Avatar colors by the Picks roster's order: the organizer first, then the
// participants as given (join order), so a person keeps their color.
function rosterColors(participants: SummaryParticipant[], organizerParticipantId: string | null) {
  const roster = [...participants].sort(
    (a, b) => Number(b.id === organizerParticipantId) - Number(a.id === organizerParticipantId),
  );
  return new Map(roster.map((p, index) => [p.id, (index % PERSON_COLORS) + 1]));
}

export function stillPickingText(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? "1 person is still picking" : `${count} people are still picking`;
}

// The list's wording (bills/list-screen.md) for who still owes on a receipt.
export function owingText(bills: SummaryBill[], currency: string): string {
  const unpaid = bills.filter((b) => !b.settled);
  if (unpaid.length === 0) return "Everyone has paid you back.";
  const left = unpaid.reduce((sum, b) => sum + cents(b.outstandingAmount), 0n);
  const owe = unpaid.length === 1 ? "1 still owes" : `${unpaid.length} still owe`;
  return `${owe} · ${formatAmount(fromCents(left), currency)} left`;
}

export function paymentOf(bill: SummaryBill, paidByParticipantId: string | null): Payment {
  if (bill.participantId === paidByParticipantId) return { state: "payer" };
  if (cents(bill.amountOwed) === 0n) return { state: "zero" };
  if (bill.paidAt !== null) {
    return { state: "paid", billId: bill.id, paidOn: formatDate(new Date(bill.paidAt).toISOString()) };
  }
  return { state: "unpaid", billId: bill.id };
}

const PAYMENT_LABEL: Record<Payment["state"], string> = {
  payer: "Paid the receipt",
  zero: "Nothing owed",
  paid: "Paid back",
  unpaid: "Not paid back yet",
};

// The unmark confirmation: clearing paidAt loses the date for good.
export function unmarkText(name: string, paidOn: string): string {
  return `This clears the ${paidOn} paid-back date. If ${name} is marked paid back again, today's date is recorded instead.`;
}

function itemCount(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}

// Who had each item, as the Picks screen reads it: the assignee, or everyone
// sharing it.
function receiptItems(items: SummaryReceiptItem[]) {
  return [...items]
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((item) => ({
      name: item.name?.trim() || `Item ${item.lineNumber}`,
      totalPrice: item.totalPrice === null ? 0n : cents(item.totalPrice.toString()),
      people: item.assignedParticipantId !== null
        ? [item.assignedParticipantId]
        : item.sharedAllocations.map((s) => s.participantId),
    }));
}

// One card per allocation, in the allocations' order, with formatted amounts,
// each person's items and a Total. A finalized receipt shows payment state
// instead of readiness, and needs its stored bills.
export function buildSummary(allocations: Allocation[], receipt: SummaryReceipt, finalized: false): Summary;
export function buildSummary(bills: SummaryBill[], receipt: SummaryReceipt, finalized: true): Summary;
export function buildSummary(allocations: Allocation[] | SummaryBill[], receipt: SummaryReceipt, finalized: boolean): Summary {
  const { currency, splitMode, organizerParticipantId, participants } = receipt;
  const byId = new Map(participants.map((p) => [p.id, p]));
  const colors = rosterColors(participants, organizerParticipantId);
  const even = splitMode === "EVEN";
  const itemsByPerson = personItems(
    splitMode,
    receiptItems(receipt.items),
    new Map(allocations.map((a) => [a.participantId, cents(a.subtotal)])),
  );
  const sums = { subtotal: 0n, discount: 0n, tax: 0n, tip: 0n, owes: 0n };
  const money = (value: string) => formatAmount(value, currency);
  const negative = (value: bigint) => formatAmount(fromCents(-value), currency);
  const rows = allocations.map((a): SummaryRow => {
    const discount = cents(a.discountShare ?? "0");
    sums.subtotal += cents(a.subtotal);
    sums.discount += discount;
    sums.tax += cents(a.taxShare);
    sums.tip += cents(a.tipShare);
    sums.owes += cents(a.amountOwed);
    const participant = byId.get(a.participantId);
    const displayName = participant?.displayName ?? "Unknown";
    const organizer = a.participantId === organizerParticipantId;
    const readiness = !finalized && participant ? readinessLabel(participant, splitMode, organizerParticipantId) : null;
    const mine = itemsByPerson.get(a.participantId) ?? [];
    const payment = finalized ? paymentOf(a as SummaryBill, receipt.paidByParticipantId ?? null) : null;
    return {
      participantId: a.participantId,
      name: organizer ? "You" : displayName,
      displayName,
      readiness,
      payment,
      line: [
        organizer ? "Your share" : null,
        payment ? PAYMENT_LABEL[payment.state] : readiness,
        even ? "Even split" : itemCount(mine.length),
      ]
        .filter(Boolean)
        .join(" · "),
      initial: initialOf(displayName),
      color: colors.get(a.participantId) ?? 1,
      items: mine.map((item) => ({
        label: item.ways > 1 ? `${item.name} (1/${item.ways})` : item.name,
        amount: money(fromCents(item.shareCents)),
      })),
      expandable: even || mine.length > 0,
      subtotal: money(a.subtotal),
      discount: negative(discount),
      tax: money(a.taxShare),
      tip: money(a.tipShare),
      owes: money(a.amountOwed),
    };
  });
  return {
    rows,
    totals: {
      subtotal: money(fromCents(sums.subtotal)),
      discount: negative(sums.discount),
      tax: money(fromCents(sums.tax)),
      tip: money(fromCents(sums.tip)),
      owes: money(fromCents(sums.owes)),
    },
    hasDiscount: sums.discount !== 0n,
    stillPicking: stillPickingText(rows.filter((r) => r.readiness === "Still picking").length),
    owing: finalized ? owingText(allocations as SummaryBill[], currency) : null,
  };
}

// One sentence per thing that doesn't add up. Differences are signed:
// itemsDifference is subtotal − items, amountsDifference is total − (subtotal − discount + tax + tip).
export function mismatchMessages(totals: TotalsCheck, currency: string, discount = false): string[] {
  const messages: string[] = [];
  if (totals.itemsDifference === null || totals.amountsDifference === null) {
    messages.push("Some item prices or amounts are missing.");
  }
  const describe = (difference: string | null, what: string, target: string) => {
    if (difference === null) return;
    const value = cents(difference);
    if (value === 0n) return;
    const amount = formatAmount(fromCents(value < 0n ? -value : value), currency);
    messages.push(`${what} ${amount} ${value > 0n ? "short of" : "over"} the ${target}.`);
  };
  describe(totals.itemsDifference, "The items are", "subtotal");
  describe(totals.amountsDifference, discount ? "Subtotal, discount, tax and tip are" : "Subtotal, tax and tip are", "total");
  return messages;
}

export function confirmationText(billCount: number, total: string): string {
  const bills = billCount === 1 ? "1 bill" : `${billCount} bills`;
  return `This creates ${bills} totaling ${total}. The receipt can't be edited after this.`;
}
