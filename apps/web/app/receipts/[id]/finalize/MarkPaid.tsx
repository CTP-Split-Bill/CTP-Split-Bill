"use client";
// A finalized card's payment row: Mark paid back at once, Mark unpaid after a
// confirmation, since clearing paidAt loses the date.
// Spec: docs/specs/receipts/finalize-screen.md, "Finalized receipt".
import { CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { unmarkText, type Payment } from "./summary";

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

export type MarkPaidProps = {
  // The person's display name ("You" never reaches here: the payer has no row).
  name: string;
  payment: Extract<Payment, { state: "paid" | "unpaid" }>;
};

async function patchPaid(billId: string, paid: boolean): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`/api/bills/${encodeURIComponent(billId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paid }),
    });
  } catch {
    return NETWORK_ERROR;
  }
  if (res.ok) return null;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? "Something went wrong. Try again.";
  } catch {
    return "Something went wrong. Try again.";
  }
}

export function MarkPaid({ name, payment }: MarkPaidProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const paid = payment.state === "paid";
  const errorId = `mark-paid-error-${payment.billId}`;
  const working = busy || refreshing;

  async function send(next: boolean) {
    setError(null);
    setBusy(true);
    const message = await patchPaid(payment.billId, next);
    setBusy(false);
    setConfirming(false);
    if (message) return setError(message);
    startRefresh(() => router.refresh());
  }

  return (
    <div className="space-y-1 border-t border-line px-4 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-sm text-ink-muted">
          {paid && (
            <>
              <CheckIcon aria-hidden="true" className="size-4 text-brand" />
              Paid back {payment.paidOn}
            </>
          )}
        </span>
        <Button
          ref={button}
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={working}
          aria-label={working ? undefined : paid ? `Mark ${name} unpaid` : `Mark ${name} paid back`}
          aria-describedby={error ? errorId : undefined}
          onClick={() => (paid ? setConfirming(true) : void send(true))}
        >
          {working ? "Saving…" : paid ? "Mark unpaid" : "Mark paid back"}
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-right text-sm text-danger">
          {error}
        </p>
      )}

      {paid && (
        <AlertDialog open={confirming} onOpenChange={(next) => !busy && setConfirming(next)}>
          <AlertDialogContent
            onEscapeKeyDown={(e) => busy && e.preventDefault()}
            onCloseAutoFocus={(e) => {
              // Opened from state, so send focus back to the card's button.
              e.preventDefault();
              button.current?.focus();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Mark {name} unpaid?</AlertDialogTitle>
              <AlertDialogDescription>{unmarkText(name, payment.paidOn)}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11" disabled={busy}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="min-h-11"
                disabled={busy}
                onClick={(e) => {
                  // Keep the dialog open until the request settles.
                  e.preventDefault();
                  void send(false);
                }}
              >
                Mark unpaid
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
