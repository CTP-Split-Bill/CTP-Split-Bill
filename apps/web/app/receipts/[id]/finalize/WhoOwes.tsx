// "Who owes what" on the finalize screen: one card per person showing what they
// owe, opening to their items and breakdown (docs/specs/receipts/finalize-screen.md).
// Native <details>, so it opens by keyboard and announces its state without
// client code. Takes display-ready strings only.
import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { PersonAvatar } from "../../../components/PersonAvatar";
import { MarkPaid } from "./MarkPaid";
import type { Summary, SummaryRow } from "./summary";

const HEADING_ID = "who-owes-heading";

function CardHead({ row, chevron }: { row: SummaryRow; chevron: boolean }) {
  return (
    <>
      <PersonAvatar initial={row.initial} color={row.color} size="lg" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">{row.name}</span>
        <span className="flex items-center gap-1 text-sm text-ink-muted">
          <span className="truncate">{row.line}</span>
          {chevron && (
            <ChevronDownIcon
              aria-hidden="true"
              className="size-4 shrink-0 motion-safe:transition-transform motion-safe:duration-200 group-open:rotate-180"
            />
          )}
        </span>
      </span>
      <span className="shrink-0 text-lg font-semibold text-ink tabular-nums">{row.owes}</span>
    </>
  );
}

function Breakdown({ row, hasDiscount }: { row: SummaryRow; hasDiscount: boolean }) {
  const lines: [string, string][] = [
    ["Subtotal", row.subtotal],
    ...(hasDiscount ? [["Discount", row.discount] as [string, string]] : []),
    ["Tax", row.tax],
    ["Tip", row.tip],
  ];
  return (
    <dl className="space-y-1 rounded-lg bg-canvas p-3 text-sm">
      {lines.map(([label, amount]) => (
        <div key={label} className="flex justify-between gap-3">
          <dt>{label}</dt>
          <dd className="tabular-nums">{amount}</dd>
        </div>
      ))}
      <div className="mt-2 flex justify-between gap-3 border-t border-line pt-2 font-semibold">
        <dt>Total</dt>
        <dd className="tabular-nums">{row.owes}</dd>
      </div>
    </dl>
  );
}

// A finalized card that can be marked gets a payment row under its header,
// outside <summary>: a button can't live inside a disclosure's control.
function PaymentRow({ row }: { row: SummaryRow }) {
  const { payment } = row;
  if (payment?.state !== "paid" && payment?.state !== "unpaid") return null;
  return <MarkPaid name={row.displayName} payment={payment} />;
}

function PersonCard({ row, hasDiscount }: { row: SummaryRow; hasDiscount: boolean }) {
  const head = "flex min-h-14 items-center gap-3 p-4";
  if (!row.expandable) {
    return (
      <div className="rounded-card border border-line bg-surface">
        <div className={head}>
          <CardHead row={row} chevron={false} />
        </div>
        <PaymentRow row={row} />
      </div>
    );
  }
  return (
    // The focus ring and hover outline the whole card, not just its header.
    <div className="rounded-card border border-line bg-surface motion-safe:transition-colors has-[summary:hover]:border-ink-muted has-[summary:focus-visible]:ring-2 has-[summary:focus-visible]:ring-brand has-[summary:focus-visible]:ring-offset-2 has-[summary:focus-visible]:ring-offset-canvas">
      <details className="group">
        <summary className={`${head} cursor-pointer list-none outline-none [&::-webkit-details-marker]:hidden`}>
          <CardHead row={row} chevron />
        </summary>
        <div className="space-y-3 px-4 pb-4">
          {row.items.length > 0 && (
            <ul className="space-y-1 text-sm text-ink-muted">
              {row.items.map((item, index) => (
                <li key={index} className="flex justify-between gap-3">
                  <span className="min-w-0 break-words">{item.label}</span>
                  <span className="shrink-0 tabular-nums">{item.amount}</span>
                </li>
              ))}
            </ul>
          )}
          <Breakdown row={row} hasDiscount={hasDiscount} />
        </div>
      </details>
      <PaymentRow row={row} />
    </div>
  );
}

export function WhoOwes({ summary }: { summary: Summary }) {
  const { rows, totals, hasDiscount, stillPicking, owing } = summary;
  return (
    <section aria-labelledby={HEADING_ID} className="space-y-3">
      <div className="space-y-1">
        <h2 id={HEADING_ID} className="text-lg font-semibold">Who owes what</h2>
        {stillPicking && <p className="text-sm text-ink-muted">{stillPicking}</p>}
        {owing && <p className="text-sm text-ink-muted">{owing}</p>}
      </div>
      <ul aria-labelledby={HEADING_ID} className="space-y-2">
        {rows.map((row) => (
          <li key={row.participantId}>
            <PersonCard row={row} hasDiscount={hasDiscount} />
          </li>
        ))}
      </ul>
      <div className="flex items-baseline justify-between gap-3 px-4 pt-1">
        <p>
          <span className="block font-semibold">Total</span>
          <span className="block text-sm text-ink-muted">Matches the receipt</span>
        </p>
        <span className="text-xl font-bold text-ink tabular-nums">{totals.owes}</span>
      </div>
    </section>
  );
}

// A finalized receipt's next step: back to the list, where it waits on payment.
export function BackToReceipts() {
  return (
    <Link
      href="/"
      className="inline-flex min-h-11 items-center font-medium text-brand underline underline-offset-4"
    >
      Back to receipts
    </Link>
  );
}
