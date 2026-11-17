// Owner-only restoration is the narrow deleted-row exception in ADR-0019.
// The update and summary read share a transaction and leave content untouched.
import { prisma } from "@project/db";
import { ApiError } from "./errors";
import { receiptScope, requireReceiptUser } from "./receipt-access";
import { presentReceiptSummary, receiptSummarySelect } from "./receipt-summaries";

export async function restoreReceipt(userId: string, receiptId: string) {
  await requireReceiptUser(userId);
  // Reuse ID validation, but deliberately scope the restore by owner alone.
  const { id, ownerId } = receiptScope(userId, receiptId);
  const owned = { id, ownerId };

  return prisma.$transaction(async (tx) => {
    const restored = await tx.receipt.updateMany({
      where: { ...owned, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    if (restored.count === 0) {
      const receipt = await tx.receipt.findFirst({ where: owned, select: { id: true } });
      if (!receipt) throw new ApiError("NOT_FOUND", "Receipt not found", 404);
      throw new ApiError("CONFLICT", "Receipt is not deleted", 409);
    }

    return presentReceiptSummary(await tx.receipt.findFirstOrThrow({
      where: { ...owned, deletedAt: null },
      select: receiptSummarySelect,
    }));
  });
}
