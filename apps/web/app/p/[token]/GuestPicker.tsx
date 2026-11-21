"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { installLeaveGuard } from "../../receipts/[id]/participants/leave-guard";
import { PERSON_COLORS, initialOf } from "../../receipts/[id]/picks/picks-form";
import { GuestPickSession } from "./guest-pick-session";
import { listenForGuestReturn } from "./guest-focus";
import { INVALID_LINK, type GuestView } from "./guest-view";

export function GuestPicker({ token, initial }: { token: string; initial: GuestView }) {
  const router = useRouter();
  const [session] = useState(() => new GuestPickSession(initial, {
    request: (method, itemIds) => fetch(`/api/picks/${encodeURIComponent(token)}${method === "POST" ? "/done" : ""}`, {
      method, cache: "no-store", referrerPolicy: "no-referrer",
      ...(method === "PUT" ? {
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemIds }),
      } : {}),
    }),
    onError: (message) => toast.error(message, { position: "top-center" }),
    onFinalized: () => router.refresh(),
  }));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { receipt, selected, busy, submitting, blocked, error } = state;

  useEffect(() => {
    session.setActive(true);
    const stop = listenForGuestReturn(window, document, () => { void session.refresh(); });
    return () => { session.setActive(false); stop(); };
  }, [session]);
  useEffect(() => {
    if (!busy) return;
    return installLeaveGuard(window, (message) => window.confirm(message), "Your picks are still saving. Leave anyway?");
  }, [busy]);

  if (state.invalid) return <h1 className="text-2xl font-semibold">{INVALID_LINK}</h1>;
  if (receipt.finalized) return <LoadingState label="Loading the split" rows={3} />;
  const readOnly = !receipt.pickingOpen || blocked || submitting;
  const names = new Map(receipt.people.map((person) => [person.id, person.name]));
  // Same fills as the organizer's picks board: by roster position.
  const colors = new Map(receipt.people.map((person, index) => [person.id, (index % PERSON_COLORS) + 1]));

  return (
    <section aria-labelledby="guest-picks-heading" className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm text-ink-muted break-words">{receipt.title}</p>
        <h1 id="guest-picks-heading" className="text-2xl font-semibold break-words">What did you have, {receipt.holderName}?</h1>
        <p className="text-ink-muted">Tap the items you had. Shared items are split equally.</p>
      </div>

      {!receipt.pickingOpen && (
        <div className="space-y-3 rounded-card border border-line bg-surface p-4">
          <p role="status">The organizer is making changes. Check back in a minute.</p>
          <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => void session.refresh()}>
            Check again
          </Button>
        </div>
      )}
      {error && <ErrorState title="Something went wrong" message={error} onRetry={() => void session.refresh()} />}
      {!receipt.items.length ? (
        <EmptyState title="No items yet" message="Check again after the organizer has added the items."
          actionLabel="Check again" onAction={() => void session.refresh()} />
      ) : (
        <ul className="space-y-3" aria-label="Receipt items">
          {receipt.items.map((item) => {
            const others = item.pickedBy.filter((id) => id !== receipt.participantId && names.has(id));
            const checked = selected.includes(item.id);
            return (
              <li key={item.id}>
                <label htmlFor={`pick-${item.id}`} className={`flex min-h-14 w-full items-center gap-3 rounded-card border p-4 ${checked ? "border-brand bg-brand/5" : "border-line bg-surface"} ${readOnly ? "" : "cursor-pointer"}`}>
                  <Checkbox id={`pick-${item.id}`} checked={checked} disabled={readOnly}
                    aria-labelledby={`pick-name-${item.id}`} aria-describedby={`pick-detail-${item.id}`}
                    onCheckedChange={() => void session.toggle(item.id)} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span id={`pick-name-${item.id}`} className="block font-medium break-words">{item.name}</span>
                    <span id={`pick-detail-${item.id}`} className="block text-sm text-ink-muted break-words">
                      {item.quantity !== null && `Qty ${item.quantity} · `}{item.price}
                      {others.length > 0 && <span className="sr-only">. Also picked by {others.map((id) => names.get(id)).join(", ")}</span>}
                    </span>
                  </span>
                  {others.length > 0 && <PickedBy ids={others} names={names} colors={colors} />}
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="sticky bottom-0 space-y-3 border-t border-line bg-canvas py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p role="status" aria-live="polite" className="text-sm text-ink-muted">
          {busy ? submitting ? "Saving and submitting your picks…" : "Checking and saving your picks…"
            : receipt.submitted ? "Your picks are submitted. You can change them while picking is open."
            : `${selected.length} ${selected.length === 1 ? "item" : "items"} selected`}
        </p>
        {receipt.pickingOpen && <Button type="button" className="min-h-11 w-full" disabled={submitting || blocked || receipt.submitted || receipt.items.length === 0}
          onClick={() => void session.done()}>{submitting ? "Submitting…" : receipt.submitted ? "Picks submitted" : "I'm done"}</Button>}
        {receipt.pickingOpen && <Button type="button" variant="ghost" className="min-h-11 w-full" disabled={busy}
          onClick={() => void session.refresh()}>Check again</Button>}
      </div>
    </section>
  );
}

const FILLS = ["bg-person-1", "bg-person-2", "bg-person-3", "bg-person-4", "bg-person-5", "bg-person-6"];
const SHOWN = 3;

// Who else picked an item, as the organizer's picks board shows it. The names
// are read from the row's description, so the circles are decorative here.
function PickedBy({ ids, names, colors }: { ids: string[]; names: Map<string, string>; colors: Map<string, number> }) {
  const extra = ids.length - SHOWN;
  return (
    <span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
      {ids.slice(0, extra > 0 ? SHOWN - 1 : SHOWN).map((id) => (
        <span key={id} title={names.get(id)}
          className={`flex size-7 items-center justify-center rounded-full text-xs font-semibold text-person-ink ring-2 ring-surface ${FILLS[(colors.get(id)! - 1) % FILLS.length]}`}>
          {initialOf(names.get(id)!)}
        </span>
      ))}
      {extra > 0 && (
        <span className="flex size-7 items-center justify-center rounded-full bg-line text-xs font-semibold text-ink ring-2 ring-surface">
          +{extra + 1}
        </span>
      )}
    </span>
  );
}
