// The Picks step: the picks board and assignments.
// Spec: docs/specs/bills/split-screen.md; gating: receipts/flow.md.
import { currentUserId } from "@project/auth";
import { listReceiptBills } from "@project/domain";
import { loadStep } from "../step-guard";
import { PicksBoard } from "./PicksBoard";
import { toBoardReceipt } from "./picks-form";

export const dynamic = "force-dynamic";

export default async function PicksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const receipt = await loadStep(id, "picks");
  // loadStep has already confirmed the user owns this receipt.
  const bills = receipt.status === "FINALIZED" ? await listReceiptBills((await currentUserId())!, id) : null;
  return <PicksBoard initial={toBoardReceipt(receipt, bills)} />;
}
