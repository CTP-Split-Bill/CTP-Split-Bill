// Shared summary selection/projection for collection reads and receipt restore.
import { prisma, type Prisma } from "@project/db";
import { requireReceiptUser } from "./receipt-access";
import { isBillSettled } from "./bills";
import { toCents } from "./split";

export type ReceiptSummary = {
  id: string;
  status: string;
  merchantName: string | null;
  title: string | null;
  total: string | null;
  createdAt: string;
  payerName: string | null;
  participantCount: number;
  settled: boolean | null;
};

export const receiptSummarySelect = {
  id: true,
  status: true,
  merchantName: true,
  title: true,
  total: true,
  createdAt: true,
  paidByParticipantId: true,
  participants: { select: { id: true, displayName: true } },
  bills: { select: { participantId: true, amountOwed: true, paidAt: true } },
} satisfies Prisma.ReceiptSelect;

type StoredReceiptSummary = Prisma.ReceiptGetPayload<{ select: typeof receiptSummarySelect }>;

export function presentReceiptSummary(r: StoredReceiptSummary): ReceiptSummary {
  const payer = r.participants.find((p) => p.id === r.paidByParticipantId);
  const settled =
    r.status !== "FINALIZED" || r.bills.length === 0
      ? null
      : r.bills.every((b) =>
          isBillSettled(
            b,
            toCents(b.amountOwed.toString()),
            r.paidByParticipantId,
          ),
        );

  return {
    id: r.id,
    status: r.status,
    merchantName: r.merchantName,
    title: r.title,
    total: r.total?.toFixed(2) ?? null,
    createdAt: r.createdAt.toISOString(),
    payerName: payer?.displayName ?? null,
    participantCount: r.participants.length,
    settled,
  };
}

export async function listReceiptSummaries(userId: string) {
  await requireReceiptUser(userId);
  const receipts = await prisma.receipt.findMany({
    where: { ownerId: userId, deletedAt: null },
    select: receiptSummarySelect,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  return receipts.map(presentReceiptSummary);
}
