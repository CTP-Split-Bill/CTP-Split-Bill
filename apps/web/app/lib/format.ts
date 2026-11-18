// Raw home-list summaries to display-ready row props, sections and copy
// (docs/specs/bills/list-screen.md). Pure, so the server page and the client
// list share it.
import type { ReceiptSummary } from "@project/domain";
import type { BillRowProps } from "@/app/components/BillRow";

export function formatMoney(value: string | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

// The home list heading; focus lands on it after a delete removes a row.
export const LIST_HEADING_ID = "bills-heading";

export function receiptName(receipt: Pick<ReceiptSummary, "merchantName" | "title">) {
  return receipt.merchantName ?? receipt.title ?? "Untitled receipt";
}

const NEXT_STEP: Record<NonNullable<ReceiptSummary["nextStep"]>, string> = {
  scan: "Next: check the scan",
  items: "Next: check items",
  participants: "Next: add people",
  picks: "Next: assign items",
  finalize: "Next: finalize",
};

// The step bar's order (packages/domain/src/steps.ts). Repeated rather than
// imported because this module reaches the client bundle and the domain
// package's runtime does not belong there.
const STEP_ORDER = ["scan", "items", "participants", "picks", "finalize"] as const;

export function receiptStatus(receipt: ReceiptSummary): string {
  if (receipt.status === "FINALIZED") {
    if (receipt.unpaidCount === null) return "Finalized";
    if (receipt.unpaidCount === 0) return "All paid";
    const owe = receipt.unpaidCount === 1 ? "1 still owes" : `${receipt.unpaidCount} still owe`;
    return `${owe} · ${formatMoney(receipt.outstanding)} left`;
  }
  const { picks, nextStep } = receipt;
  if (picks?.open) return `Picks open · ${picks.done} of ${picks.total} done`;
  const next = NEXT_STEP[nextStep ?? "scan"];
  return nextStep === "picks" && picks && picks.done > 0 ? `${next} · ${picks.done} of ${picks.total} done` : next;
}

export type SectionKey = "progress" | "owed" | "settled";

export const SECTION_TITLES: Record<SectionKey, string> = {
  progress: "In progress",
  owed: "Waiting on payment",
  settled: "Settled",
};

export function receiptSection(receipt: ReceiptSummary): SectionKey {
  if (receipt.status !== "FINALIZED") return "progress";
  return (receipt.unpaidCount ?? 0) > 0 ? "owed" : "settled";
}

// Whose move it is: the organizer's (a next step), someone else's (guests
// picking, people who owe), or nobody's.
export function receiptState(receipt: ReceiptSummary): BillRowProps["state"] {
  if (receipt.status === "FINALIZED") return (receipt.unpaidCount ?? 0) > 0 ? "waiting" : "done";
  return receipt.picks?.open ? "waiting" : "your-move";
}

export function toBillRowProps(receipt: ReceiptSummary): BillRowProps {
  const step = receipt.status === "FINALIZED" || !receipt.nextStep ? null : STEP_ORDER.indexOf(receipt.nextStep);
  return {
    name: receiptName(receipt),
    untitled: receipt.merchantName === null && receipt.title === null && receipt.total === null,
    total: formatMoney(receipt.total),
    date: formatDate(receipt.createdAt),
    status: receiptStatus(receipt),
    state: receiptState(receipt),
    stepsDone: step,
  };
}

// Money as exact cents, so sums never pass through floating point.
function cents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

export function sumMoney(values: (string | null)[]): string {
  const total = values.reduce((sum, v) => sum + (v === null ? 0n : cents(v)), 0n);
  return `${total / 100n}.${(total % 100n).toString().padStart(2, "0")}`;
}

// The line under the heading: what the organizer is owed and how many
// receipts still need them.
export function listSummary(receipts: { section: SectionKey; outstanding: string | null; unpaidCount: number | null }[]) {
  const owed = receipts.filter((r) => r.section === "owed");
  const people = owed.reduce((n, r) => n + (r.unpaidCount ?? 0), 0);
  const toFinish = receipts.filter((r) => r.section === "progress").length;
  const finish = toFinish === 1 ? "1 receipt to finish" : `${toFinish} receipts to finish`;
  if (!owed.length) return { amount: null, text: toFinish ? finish : "Everyone has paid you back." };
  const from = `from ${people === 1 ? "1 person" : `${people} people`}`;
  return { amount: formatMoney(sumMoney(owed.map((r) => r.outstanding))), text: toFinish ? `${from} · ${finish}` : from };
}

// The row link's accessible name: "<name>, <total>, <status>", with the
// status's "·" read as a comma rather than announced.
export function rowLabel(row: BillRowProps): string {
  return [row.name, row.total === "—" ? null : row.total, row.status.replaceAll(" · ", ", ")]
    .filter(Boolean)
    .join(", ");
}

// The home list's delete confirmation: who the receipt covers, and a
// warning when people still owe on it.
export function deleteDialogCopy(receipt: ReceiptSummary) {
  const n = receipt.participantCount;
  const owing = receipt.status === "FINALIZED" ? receipt.unpaidCount ?? 0 : 0;
  return {
    people: n === 1 ? "1 person" : `${n} people`,
    warning: owing === 0
      ? null
      : `${owing === 1 ? "1 person still owes" : `${owing} people still owe`} ${formatMoney(receipt.outstanding)}. Their links will stop working.`,
  };
}
