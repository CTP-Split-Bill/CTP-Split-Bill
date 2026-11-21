// Server-only composition: amounts already belong to bills, never recalculated.
import type { GuestView } from "./guest-view";

export function SplitSummary({ receipt }: { receipt: GuestView }) {
  return (
    <section className="space-y-6" aria-labelledby="split-heading">
      <div className="space-y-2">
        <p className="text-sm text-ink-muted break-words">{receipt.title}</p>
        <h1 id="split-heading" className="text-2xl font-semibold">The split</h1>
        <p className="break-words">{receipt.paidBy ? `Pay ${receipt.paidBy}` : "Check with the organizer about who to pay."}</p>
      </div>
      <ul className="divide-y divide-line rounded-card border border-line bg-surface">
        {receipt.people.map((person) => (
          <li key={person.id} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="font-medium break-words">{person.name}</p>
              <p className={person.settled ? "text-sm text-brand" : "text-sm text-warning"}>
                {person.settled ? "Settled" : "Still owes"}
              </p>
            </div>
            <p className="shrink-0 font-semibold tabular-nums">{person.amount}</p>
          </li>
        ))}
      </ul>
      <p className="text-sm text-ink-muted">This receipt is finalized. The organizer records payments.</p>
    </section>
  );
}
