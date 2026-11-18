// Home: the signed-in organizer's receipts grouped by what each needs next, or the public landing
// for a signed-out visitor. Spec: docs/specs/bills/list-screen.md.
import { Suspense } from "react";
import { currentUserId } from "@project/auth";
import { listReceiptSummaries } from "@project/domain";
import { BillList } from "./BillList";
import { EmptyState } from "@/app/components/EmptyState";
import { LoadingState } from "@/app/components/LoadingState";
import { Button } from "@/app/components/ui/button";
import { deleteDialogCopy, LIST_HEADING_ID, receiptName, receiptSection, toBillRowProps } from "@/app/lib/format";
import { LOGIN_PATH } from "@/app/lib/page-access";

export const dynamic = "force-dynamic";

const NEW_RECEIPT_HREF = "/receipts/new";

// Errors propagate to the root error boundary (app/error.tsx).
async function ReceiptList({ userId }: { userId: string }) {
  const receipts = await listReceiptSummaries(userId);
  const empty = (
    <EmptyState
      title="No bills yet"
      message="Scan a receipt to split it."
      actionLabel="New receipt"
      actionHref={NEW_RECEIPT_HREF}
    />
  );
  return (
    <BillList
      empty={empty}
      items={receipts.map((receipt) => ({
        id: receipt.id,
        name: receiptName(receipt),
        section: receiptSection(receipt),
        row: toBillRowProps(receipt),
        dialog: deleteDialogCopy(receipt),
        outstanding: receipt.outstanding,
        unpaidCount: receipt.unpaidCount,
      }))}
    />
  );
}

export default async function Home() {
  // `/` is public (auth/sign-in.md); a signed-out visitor gets the landing.
  const userId = await currentUserId();
  if (!userId) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Split Bill</h1>
        <p className="text-ink-muted">Scan a receipt, send everyone a link, and see who owes what.</p>
        <Button asChild className="min-h-11">
          <a href={LOGIN_PATH}>Sign in</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4">
        {/* Focus lands here after a delete removes the focused card. */}
        <h1 id={LIST_HEADING_ID} tabIndex={-1} className="text-2xl font-bold focus:outline-none">
          Your bills
        </h1>
        <Button asChild className="min-h-11">
          <a href={NEW_RECEIPT_HREF}>New receipt</a>
        </Button>
      </header>
      <Suspense fallback={<LoadingState label="Loading bills" rows={2} />}>
        <ReceiptList userId={userId} />
      </Suspense>
    </div>
  );
}
