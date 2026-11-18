"use client";
// The home list (docs/specs/bills/list-screen.md): receipts grouped by what
// each needs next, each row with a ⋯ menu, the delete confirmation and the
// Undo toast. A row leaves as soon as the user confirms; the toast is the
// only way back. A client leaf beside the page, not a layer-2 component,
// because it fetches and owns state (components.md).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import {
  formatMoney,
  LIST_HEADING_ID,
  listSummary,
  rowLabel,
  SECTION_TITLES,
  sumMoney,
  type SectionKey,
} from "@/app/lib/format";
import { BillRow, type BillRowProps } from "@/app/components/BillRow";
import { Button, buttonVariants } from "@/app/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/app/components/ui/alert-dialog";

export type BillListItem = {
  id: string;
  name: string;
  section: SectionKey;
  row: BillRowProps;
  // The confirmation: who the receipt covers, and a warning when people still owe.
  dialog: { people: string; warning: string | null };
  // Raw settlement figures for the summary line and section totals.
  outstanding: string | null;
  unpaidCount: number | null;
};

const SECTION_ORDER: SectionKey[] = ["progress", "owed", "settled"];

const TOAST_POSITION = "top-center" as const;
// Long enough to reach Undo by thumb or keyboard; the toast holds on hover.
export const UNDO_MS = 10000;

export function receiptHref(id: string) {
  // /receipts/[id] lands on the receipt's next step (receipts/flow.md).
  return `/receipts/${encodeURIComponent(id)}`;
}

function receiptApi(id: string, suffix = "") {
  return `/api/receipts/${encodeURIComponent(id)}${suffix}`;
}

export function BillList({ items, empty }: { items: BillListItem[]; empty: ReactNode }) {
  const settledId = useId();
  const router = useRouter();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<BillListItem | null>(null);
  // The dialog is shared by every row, so it has no Trigger of its own; focus
  // is returned by hand: to the card's ⋯ on cancel, to the heading on delete.
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const deleted = useRef(false);
  // Delete controls show only in Edit mode, so rows stay clean at rest.
  const [editing, setEditing] = useState(false);
  const editToggle = useRef<HTMLButtonElement>(null);

  const setShown = (id: string, shown: boolean) =>
    setHidden((current) => {
      const next = new Set(current);
      if (shown) next.delete(id);
      else next.add(id);
      return next;
    });

  async function restore(item: BillListItem) {
    let status = 0;
    try {
      status = (await fetch(receiptApi(item.id, "/restore"), { method: "POST" })).status;
    } catch {}
    // 409: someone already restored it; either way it's live again.
    if (status === 200 || status === 409) {
      setShown(item.id, true);
      router.refresh();
    } else {
      toast.error(`Couldn't restore ${item.name}.`, { position: TOAST_POSITION });
    }
  }

  async function remove(item: BillListItem) {
    setShown(item.id, false);
    let status = 0;
    try {
      status = (await fetch(receiptApi(item.id), { method: "DELETE" })).status;
    } catch {}
    if (status === 204) {
      toast(`Deleted ${item.name}`, {
        position: TOAST_POSITION,
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => void restore(item) },
      });
      router.refresh();
    } else if (status === 404) {
      // Already gone (deleted in another tab): nothing to undo or report.
      router.refresh();
    } else {
      setShown(item.id, true);
      toast.error(`Couldn't delete ${item.name}. Try again.`, { position: TOAST_POSITION });
    }
  }

  const visible = items.filter((item) => !hidden.has(item.id));
  const sections = SECTION_ORDER.map((key) => ({
    key,
    items: visible.filter((item) => item.section === key),
  })).filter((section) => section.items.length > 0);
  // Settled grows without bound, so it starts collapsed unless it's all there is.
  const [settledOpen, setSettledOpen] = useState(
    () => !items.some((item) => item.section !== "settled"),
  );
  if (!sections.length) return <>{empty}</>;
  const summary = listSummary(visible);

  return (
    <>
      <div className="-mt-3 mb-8 flex items-center justify-between gap-4">
        <p className="text-ink-muted">
          {summary.amount && (
            <>
              You&rsquo;re owed{" "}
              <span className="text-lg font-semibold text-ink tabular-nums">{summary.amount}</span>{" "}
            </>
          )}
          {summary.text}
        </p>
        <Button
          ref={editToggle}
          variant={editing ? "default" : "outline"}
          className="min-h-11 shrink-0"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? "Done" : "Edit"}
        </Button>
      </div>
      <Sections
        sections={sections}
        editing={editing}
        settledOpen={settledOpen}
        onToggleSettled={() => setSettledOpen((v) => !v)}
        settledId={settledId}
        registerTrigger={(id, el) => {
          if (el) triggers.current.set(id, el);
          else triggers.current.delete(id);
        }}
        onDelete={(item) => {
          deleted.current = false;
          setConfirming(item);
        }}
      />
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        {confirming && (
          <DeleteDialog
            item={confirming}
            onConfirm={() => {
              deleted.current = true;
              setConfirming(null);
              void remove(confirming);
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              // After a delete the row is gone: back to the Done toggle, or
              // the heading if the list is now empty.
              const target = deleted.current
                ? (editToggle.current ?? document.getElementById(LIST_HEADING_ID))
                : triggers.current.get(confirming.id);
              target?.focus();
            }}
          />
        )}
      </AlertDialog>
    </>
  );
}

// The sections and their rows. Split out so a static render can show Edit
// mode; BillList owns the state.
export function Sections({
  sections,
  editing,
  settledOpen,
  onToggleSettled,
  settledId,
  registerTrigger,
  onDelete,
}: {
  sections: { key: SectionKey; items: BillListItem[] }[];
  editing: boolean;
  settledOpen: boolean;
  onToggleSettled: () => void;
  settledId: string;
  registerTrigger: (id: string, el: HTMLButtonElement | null) => void;
  onDelete: (item: BillListItem) => void;
}) {
  return (
      <div className="space-y-8">
        {sections.map(({ key, items: rows }) => {
          const collapsible = key === "settled" && sections.length > 1;
          const open = !collapsible || settledOpen;
            // The space keeps the accessible name "Settled 2", not "Settled2".
            const count = <> <span className="ml-1 font-normal text-ink-muted tabular-nums">{rows.length}</span></>;
          return (
            <section key={key} className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold text-ink">
                  {collapsible ? (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={settledId}
                      onClick={onToggleSettled}
                      className="-mx-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 hover:bg-surface focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <ChevronRightIcon
                        aria-hidden
                        className={`size-4 text-ink-muted transition-transform duration-200 ${open ? "rotate-90" : ""}`}
                      />
                      {SECTION_TITLES[key]}
                      {count}
                    </button>
                  ) : (
                    <>
                      {SECTION_TITLES[key]}
                      {count}
                    </>
                  )}
                </h2>
                {key === "owed" && (
                  <p className="shrink-0 text-sm font-medium text-warning tabular-nums">
                    {formatMoney(sumMoney(rows.map((r) => r.outstanding)))} left
                  </p>
                )}
              </div>
              {open && (
                <ul
                  id={collapsible ? settledId : undefined}
                  className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface"
                >
                  {rows.map((item) => (
                    <li key={item.id} className="flex items-center">
                      <Link
                        href={receiptHref(item.id)}
                        aria-label={rowLabel(item.row)}
                        className="min-w-0 flex-1 px-4 py-3 transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
                      >
                        <BillRow {...item.row} />
                      </Link>
                      {/* A sibling of the link, not inside it, so it is its own Tab stop. */}
                      {editing && (
                        <Button
                          ref={(el) => registerTrigger(item.id, el)}
                          variant="ghost"
                          className="mr-2 min-h-11 shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
                          aria-label={`Delete ${item.name}`}
                          onClick={() => onDelete(item)}
                        >
                          Delete
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
  );
}

export function DeleteDialog({
  item,
  onConfirm,
  onCloseAutoFocus,
}: {
  item: BillListItem;
  onConfirm: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { row, dialog } = item;
  return (
    <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete this receipt?</AlertDialogTitle>
        <AlertDialogDescription className="sr-only">
          {row.name}, {row.total}. {dialog.warning ?? ""} You can undo this right after.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {/* The receipt itself, so the organizer confirms the right one. */}
      <div aria-hidden className="rounded-md border border-line bg-canvas px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className={row.untitled ? "truncate font-medium text-ink-muted" : "truncate font-semibold text-ink"}>
            {row.name}
          </span>
          <span className="shrink-0 font-semibold tabular-nums">{row.total}</span>
        </div>
        <p className="text-sm text-ink-muted">
          {row.date} · {dialog.people}
        </p>
      </div>
      {dialog.warning && (
        <p aria-hidden className="flex gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm font-medium text-warning">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          {dialog.warning}
        </p>
      )}
      <p aria-hidden className="text-sm text-ink-muted">You can undo this right after.</p>
      <AlertDialogFooter>
        <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
        <AlertDialogAction
          className={buttonVariants({ variant: "destructive", className: "min-h-11" })}
          onClick={onConfirm}
        >
          <Trash2Icon aria-hidden />
          Delete
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
