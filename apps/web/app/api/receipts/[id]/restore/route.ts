// POST /api/receipts/:id/restore - Restore an owned deleted receipt and its summary.
// Spec: docs/specs/receipts/delete.md.
import { currentUserId } from "@project/auth";
import { restoreReceipt, toApiError } from "@project/domain";
import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await currentUserId();
    const { id } = await params;
    const receipt = await restoreReceipt(me, id);
    revalidatePath("/");
    return Response.json(receipt);
  } catch (error) {
    return toApiError(error);
  }
}