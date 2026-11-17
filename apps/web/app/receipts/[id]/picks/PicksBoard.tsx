"use client";
// Picks step: the live picks board while picking is open, the same board with
// editable people while paused, Save and the picking switch.
// Spec: docs/specs/bills/split-screen.md.
import { CheckIcon, ChevronUpIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { cn } from "../../../lib/cn";
import { installLinkGuard } from "../../../lib/link-guard";
import { loginPath } from "../../../lib/page-access";
import { useReceiptRefresh } from "../../../lib/use-receipt-refresh";
import { installLeaveGuard } from "../participants/leave-guard";
import {
  type BoardReceipt,
  type Avatar,
  type BoardView,
  type Draft,
  type ItemView,
  type PersonView,
  type SplitChoice,
  applyDraft,
  boardView,
  changeable,
  draftFrom,
  isDirty,
  nextSaveStep,
  organizerItems,
  saveStepPath,
  selectedCount,
  selectedText,
  setPersonOnAll,
  toBoardReceipt,
  totalLabel,
  toggleOwnItem,
  togglePerson,
  withOwnItems,
} from "./picks-form";

export const LEAVE_MESSAGE = "You have unsaved changes to who had what. Leave anyway?";
const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";
const CONFLICT = "This receipt changed somewhere else. Reload to see the latest.";
const TOAST_POSITION = "top-center" as const;
export const REFRESH_FAILED = "Couldn't refresh. Retrying…";

type SaveError = { message: string; conflict: boolean };
type Busy = "save" | "open" | "pause" | null;

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "Something went wrong. Try again in a moment.";
}

export function subtitleFor(receipt: BoardReceipt): string {
  if (receipt.finalized) return "This receipt is finalized.";
  return receipt.pickingOpen
    ? "Picking is open. Picks show up here as people make them."
    : "Picking is paused. Pick a person, then tap what they had.";
}

export function PicksBoard({ initial }: { initial: BoardReceipt }) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [selectedId, setSelectedId] = useState<string | null>(initial.organizerId ?? initial.people[0]?.id ?? null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<SaveError | null>(null);
  const [ownPending, setOwnPending] = useState<string[] | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const base = `/receipts/${encodeURIComponent(saved.id)}`;
  const here = `${base}/picks`;

  const live = saved.pickingOpen && !saved.finalized;
  const editing = !saved.pickingOpen && !saved.finalized;
  const dirty = editing && isDirty(saved, draft);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  // ---- Refresh while picking is open ----
  function adopt(next: BoardReceipt) {
    setSaved(next);
    setDraft(draftFrom(next));
  }
  const { failed } = useReceiptRefresh(saved.id, live, {
    revision: saved.revision,
    picksOpenedAt: saved.pickingOpen ? "open" : null,
    status: saved.finalized ? "FINALIZED" : "DRAFT",
  }, {
    onChange: (detail) => {
      adopt(toBoardReceipt(detail as unknown as Parameters<typeof toBoardReceipt>[0]));
      router.refresh();
    },
    onUnauthorized: () => window.location.assign(loginPath(here)),
    onMissing: () => router.refresh(),
  });

  // ---- Leaving with unsaved edits ----
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => {
    if (!dirty) return;
    return installLeaveGuard(window, (message) => window.confirm(message), LEAVE_MESSAGE);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    return installLinkGuard(document, (href) => {
      toast("You have unsaved changes", {
        id: "unsaved-changes",
        position: TOAST_POSITION,
        description: "Save them before leaving, or discard them.",
        duration: 10000,
        action: {
          label: "Save and continue",
          onClick: async () => {
            if (await saveRef.current()) router.push(href);
          },
        },
        cancel: { label: "Discard", onClick: () => router.push(href) },
      });
    });
  }, [dirty, router]);

  // ---- Requests ----
  async function send(path: string, method: string, body: unknown): Promise<BoardReceipt | null> {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        cache: "no-store",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      setError({ message: NETWORK_ERROR, conflict: false });
      return null;
    }
    if (res.status === 401) {
      window.location.assign(loginPath(here));
      return null;
    }
    if (!res.ok) {
      // A stale write is a conflict to reload from; other 409s (picking
      // preconditions) explain themselves.
      const message = await errorMessage(res);
      const stale = res.status === 409 && method !== "POST";
      setError({ message: stale ? CONFLICT : message, conflict: stale });
      return null;
    }
    return toBoardReceipt(await res.json());
  }

  async function reload(): Promise<BoardReceipt | null> {
    const next = await send(`/api/receipts/${encodeURIComponent(saved.id)}`, "GET", undefined);
    if (next) {
      adopt(next);
      setError(null);
      router.refresh();
    }
    return next;
  }

  // Returns whether everything was saved.
  async function save(): Promise<boolean> {
    setError(null);
    let current = saved;
    setBusy("save");
    try {
      for (let step = nextSaveStep(current, draft); step; step = nextSaveStep(current, draft)) {
        const { path, method } = saveStepPath(current.id, step);
        const next = await send(path, method, step.body);
        if (!next) {
          // Keep what did save; Save again sends only what is still different.
          setSaved(current);
          return false;
        }
        current = next;
      }
      adopt(current);
      toast.success("Saved", { position: TOAST_POSITION });
      router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  }
  saveRef.current = save;

  async function setPicking(open: boolean) {
    setError(null);
    if (open && dirty && !(await save())) return;
    setBusy(open ? "open" : "pause");
    try {
      const next = await send(`/api/receipts/${encodeURIComponent(saved.id)}/picking`, "POST", { open });
      if (!next) return;
      // After a pause, read again: the pause waited behind any guest save,
      // so this read holds every pick that landed.
      if (!open) await reload();
      else {
        adopt(next);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  // ---- The organizer's own toggles while picking is open ----
  const ownWanted = useRef<string[] | null>(null);
  const ownSending = useRef(false);
  async function flushOwn() {
    if (ownSending.current) return;
    ownSending.current = true;
    try {
      while (ownWanted.current) {
        const want = ownWanted.current;
        const next = await send(`/api/receipts/${encodeURIComponent(saved.id)}/picks`, "PUT", { itemIds: want });
        if (!next) {
          ownWanted.current = null;
          setOwnPending(null);
          return;
        }
        setSaved(next);
        if (ownWanted.current === want) {
          ownWanted.current = null;
          setOwnPending(null);
          router.refresh();
        }
      }
    } finally {
      ownSending.current = false;
    }
  }
  function setOwn(want: string[]) {
    setError(null);
    ownWanted.current = want;
    setOwnPending(want);
    void flushOwn();
  }
  function toggleOwn(itemId: string) {
    setOwn(toggleOwnItem(ownWanted.current ?? organizerItems(saved), itemId));
  }

  // ---- What to show ----
  const shown = editing ? applyDraft(saved, draft) : ownPending ? withOwnItems(saved, ownPending) : saved;
  const view = boardView(shown);
  const refreshFailed = live && failed;
  // Everyone's amount is known and adds up to the receipt, as saved: Finalize
  // is the next step. Not while the organizer's own toggle is still saving.
  const ready = !saved.finalized && view.matchedTotal !== null && !dirty && ownPending === null;
  const hasAssignments = saved.splitMode !== "EVEN" && saved.items.some((i) => i.people.length > 0);

  const selected = view.people.find((p) => p.id === selectedId) ?? view.people[0] ?? null;
  // Editing changes anyone through the draft; while picking is open only the
  // organizer's own picks can change (ADR-0017).
  // A save in flight disables the controls rather than removing them, so
  // nothing shifts under the organizer's finger.
  const canChange = selected !== null && changeable(shown, selected.id);
  const locked = busy !== null;
  const count = selected ? selectedCount(shown, selected.id) : 0;
  const hasAll = count === shown.items.length && count > 0;

  function toggleItem(itemId: string) {
    if (!selected || !canChange || locked) return;
    if (editing) setDraft((d) => togglePerson(saved, d, itemId, selected.id));
    else toggleOwn(itemId);
  }
  function setAll(on: boolean) {
    if (!selected || !canChange || locked) return;
    if (editing) setDraft((d) => setPersonOnAll(saved, d, selected.id, on));
    else setOwn(on ? shown.items.map((i) => i.id) : []);
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Who had what</h1>
        <p className="text-ink-muted">{subtitleFor(saved)}</p>
        {refreshFailed && <p className="text-sm text-ink-muted">{REFRESH_FAILED}</p>}
      </header>

      {selected && (
        <PeopleBar
          people={view.people}
          selectedId={selected.id}
          onSelect={setSelectedId}
        />
      )}

      <section aria-label="Items" className="space-y-3">
        {editing && (
          <div className="space-y-1">
            <p id="split-label" className="text-sm text-ink-muted">Split</p>
            <ToggleGroup
              type="single"
              aria-labelledby="split-label"
              value={draft.split}
              disabled={busy !== null}
              onValueChange={(value) => value && setDraft((d) => ({ ...d, split: value as SplitChoice }))}
            >
              <ToggleGroupItem value="EVEN">Even</ToggleGroupItem>
              <ToggleGroupItem value="BY_ITEM">By item</ToggleGroupItem>
            </ToggleGroup>
            {draft.split === "EVEN" && hasAssignments && (
              <p className="text-sm text-ink-muted">Saving with Even clears who had what.</p>
            )}
          </div>
        )}

        {view.even ? (
          <p className="rounded-card border border-line bg-surface p-3">Splitting evenly: everyone pays the same share.</p>
        ) : (
          <>
            <p className={cn("flex items-center gap-1 text-sm font-medium", view.allClaimed ? "text-brand" : "text-destructive")}>
              {view.allClaimed && <CheckIcon aria-hidden="true" className="size-4" strokeWidth={3} />}
              {view.claimSummary}
            </p>
            {selected && (
              <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <p className="text-ink-muted" aria-live="polite">{selectedText(count)}</p>
                {canChange ? (
                  <Button type="button" variant="outline" className="min-h-11 rounded-full" disabled={locked} onClick={() => setAll(!hasAll)}>
                    {hasAll ? "Deselect all" : "Select all"}
                  </Button>
                ) : (
                  live && <p className="text-sm text-ink-muted">Pause picking to change {selected.name}&apos;s items.</p>
                )}
              </div>
            )}
          </>
        )}

        <ul className="space-y-2">
          {view.items.map((item) => (
            <li key={item.id}>
              <ItemCard
                item={item}
                marked={selected !== null && !view.even && item.chips.some((c) => c.id === selected.id)}
                onToggle={canChange ? () => toggleItem(item.id) : null}
                disabled={locked}
              />
            </li>
          ))}
        </ul>
      </section>

      <div data-testid="totals-bar" className="sticky bottom-0 z-10 -mx-4 space-y-3 border-t border-line bg-canvas px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {selected && (
          <TotalsBar
            view={view}
            selected={selected}
            expanded={expanded}
            onExpand={() => setExpanded((e) => !e)}
            receiptBase={base}
            canEditPeople={!saved.finalized}
          />
        )}
        {error && (
          <div
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            className="space-y-2 rounded-md border border-destructive bg-surface p-3 text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <p>{error.message}</p>
            {error.conflict && (
              <Button type="button" variant="outline" className="min-h-11" onClick={() => void reload()}>
                Reload
              </Button>
            )}
          </div>
        )}
        {!saved.finalized && (
          <div data-testid="action-bar" className="flex flex-wrap justify-end gap-2">
            {live ? (
              <Button
                type="button"
                variant={ready ? "outline" : "default"}
                className="min-h-11 max-sm:flex-1 max-sm:px-3"
                disabled={busy !== null}
                onClick={() => void setPicking(false)}
              >
                {busy === "pause" ? "Pausing…" : "Pause picking to edit"}
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" className="min-h-11 max-sm:flex-1 max-sm:px-3" disabled={!dirty || busy !== null} onClick={() => void save()}>
                  {busy === "save" ? "Saving…" : "Save"}
                </Button>
                <Button
                  type="button"
                  variant={ready ? "outline" : "default"}
                  className="min-h-11 max-sm:flex-1 max-sm:px-3"
                  disabled={busy !== null}
                  onClick={() => void setPicking(true)}
                >
                  {busy === "open" ? "Opening…" : dirty ? "Save and open picking" : "Open picking"}
                </Button>
              </>
            )}
            {ready && (
              <Button asChild className="min-h-11 max-sm:flex-1 max-sm:px-3">
                <Link href={`${base}/finalize`}>Continue to Finalize</Link>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Static class names, so Tailwind generates each fill.
const FILLS = ["bg-person-1", "bg-person-2", "bg-person-3", "bg-person-4", "bg-person-5", "bg-person-6"];
const fill = (color: number) => FILLS[(color - 1) % FILLS.length];

function PeopleBar({
  people,
  selectedId,
  onSelect,
}: {
  people: PersonView[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section aria-label="People" className="-mx-4 overflow-x-auto border-b border-line px-4 pt-1 pb-4">
      <ToggleGroup
        type="single"
        aria-label="Whose items"
        value={selectedId}
        onValueChange={(value) => value && onSelect(value)}
        className="flex w-max gap-3 rounded-none border-0 bg-transparent p-0"
      >
        {people.map((person) => (
          <ToggleGroupItem
            key={person.id}
            value={person.id}
            aria-label={person.done ? `${person.name}, done` : person.name}
            className="group h-auto w-16 flex-col gap-1 rounded-md px-0 py-1 text-ink data-[state=on]:bg-transparent data-[state=on]:text-ink"
          >
            <span className="relative">
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-12 items-center justify-center rounded-full text-lg font-semibold text-person-ink ring-offset-2 ring-offset-canvas group-data-[state=on]:ring-2 group-data-[state=on]:ring-ink",
                  fill(person.color),
                )}
              >
                {person.initial}
              </span>
              {person.done && (
                <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full border-2 border-canvas bg-brand text-brand-ink">
                  <CheckIcon className="size-3" strokeWidth={3} />
                </span>
              )}
            </span>
            <span aria-hidden="true" className="w-full truncate text-center text-xs font-normal text-ink-muted group-data-[state=on]:font-semibold group-data-[state=on]:text-ink">
              {person.name}
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </section>
  );
}

function MiniAvatar({ avatar }: { avatar: Avatar }) {
  return (
    <span
      role="img"
      aria-label={avatar.label}
      title={avatar.label}
      className={cn("flex size-7 items-center justify-center rounded-full text-xs font-semibold text-person-ink", fill(avatar.color))}
    >
      <span aria-hidden="true">{avatar.initial}</span>
    </span>
  );
}

function ItemCard({
  item,
  marked,
  onToggle,
  disabled,
}: {
  item: ItemView;
  marked: boolean;
  onToggle: (() => void) | null;
  disabled: boolean;
}) {
  const body = (
    <>
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 font-medium break-words">{item.name}</span>
        <span className="shrink-0 tabular-nums text-ink-muted">{item.price}</span>
      </span>
      <span className="flex min-h-7 items-center justify-between gap-3">
        <span className="flex flex-wrap items-center gap-1.5">
          {item.unclaimed && <Badge variant="destructive">Unclaimed</Badge>}
          {item.chips.map((chip) => (
            <MiniAvatar key={chip.id} avatar={chip} />
          ))}
          {item.shareNote && <span className="text-xs text-ink-muted">{item.shareNote}</span>}
        </span>
        {marked && (
          <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink text-canvas">
            <CheckIcon className="size-3.5" strokeWidth={3} />
          </span>
        )}
      </span>
    </>
  );
  const frame = cn(
    "flex w-full flex-col gap-2 rounded-card border-2 bg-surface px-4 py-3 text-left",
    marked ? "border-ink" : "border-line",
  );
  if (!onToggle) return <div className={frame}>{body}</div>;
  return (
    <button
      type="button"
      aria-pressed={marked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        frame,
        "min-h-11 cursor-pointer outline-none transition-colors hover:border-ink-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60",
        marked && "hover:border-ink",
      )}
    >
      {body}
    </button>
  );
}

function TotalsBar({
  view,
  selected,
  expanded,
  onExpand,
  receiptBase,
  canEditPeople,
}: {
  view: BoardView;
  selected: PersonView;
  expanded: boolean;
  onExpand: () => void;
  receiptBase: string;
  canEditPeople: boolean;
}) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="everyone-totals"
        onClick={onExpand}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-ink-muted">{totalLabel(selected)}</span>
          <span className="text-lg font-semibold tabular-nums">{selected.amount}</span>
        </span>
        <span className="flex items-center gap-1 text-sm text-ink-muted">
          {expanded ? "Hide" : "Everyone"}
          <ChevronUpIcon aria-hidden="true" className={cn("size-5 transition-transform", expanded && "rotate-180")} />
        </span>
      </button>
      {view.matchedTotal && (
        <p className="flex flex-wrap items-center gap-x-1 text-sm font-medium text-brand">
          <CheckIcon aria-hidden="true" className="size-4" strokeWidth={3} />
          <span className="whitespace-nowrap">Matches the receipt</span>
          <span className="whitespace-nowrap tabular-nums">· Total {view.matchedTotal}</span>
        </p>
      )}
      <div id="everyone-totals" hidden={!expanded} className="max-h-[min(40vh,calc(50vh-11rem))] min-h-24 space-y-2 overflow-y-auto rounded-card border border-line bg-surface px-4 py-2">
        {view.doneSummary && <p className="pt-1 text-sm text-ink-muted">{view.doneSummary}</p>}
        <ul className="divide-y divide-line">
          {view.people.map((person) => (
            <li key={person.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="font-medium break-words">{person.name}</p>
                {person.readiness && (
                  <p className={cn("text-sm", person.readiness === "Done" ? "text-brand" : "text-ink-muted")}>
                    {person.readiness}
                    {person.readiness === "No link" && canEditPeople && (
                      <>
                        {" · "}
                        <Link href={`${receiptBase}/participants`} className="underline underline-offset-2">
                          Send one from People
                        </Link>
                      </>
                    )}
                  </p>
                )}
              </div>
              <p className="shrink-0 text-right">
                <span className="block text-xs text-ink-muted">{person.amountLabel}</span>
                <span className="font-semibold tabular-nums">{person.amount}</span>
              </p>
            </li>
          ))}
        </ul>
        {view.totalsNote && <p className="pb-1 text-sm text-ink-muted">{view.totalsNote}</p>}
      </div>
    </div>
  );
}
