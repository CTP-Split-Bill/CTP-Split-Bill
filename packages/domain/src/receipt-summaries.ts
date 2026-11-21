// Shared summary selection/projection for collection reads and receipt restore.
import { prisma, type Prisma } from "@project/db";
import { requireReceiptUser } from "./receipt-access";
import { isBillSettled } from "./bills";
import { centsToMoney, toCents } from "./split";
import { landingStep, receiptSteps, type StepKey } from "./steps";

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
  unpaidCount: number | null;
  outstanding: string | null;
  nextStep: StepKey | null;
  picks: { open: boolean; done: number; total: number } | null;
};

export const receiptSummarySelect = {
  id: true,
  status: true,
  merchantName: true,
  title: true,
  total: true,
  createdAt: true,
  paidByParticipantId: true,
  parseStatus: true,
  splitMode: true,
  reviewedAt: true,
  organizerParticipantId: true,
  picksOpenedAt: true,
  participants: { select: { id: true, displayName: true, picksSubmittedAt: true } },
  // Read only for a draft's nextStep (steps.ts); finalized receipts don't use them.
  items: { select: { assignedParticipantId: true, sharedAllocations: { select: { participantId: true } } } },
  bills: { select: { participantId: true, amountOwed: true, paidAt: true } },
} satisfies Prisma.ReceiptSelect;

type StoredReceiptSummary = Prisma.ReceiptGetPayload<{ select: typeof receiptSummarySelect }>;

export function presentReceiptSummary(r: StoredReceiptSummary): ReceiptSummary {
  const payer = r.participants.find((p) => p.id === r.paidByParticipantId);
  const finalized = r.status === "FINALIZED";
  const unpaid =
    !finalized || r.bills.length === 0
      ? null
      : r.bills
          .map((b) => ({ bill: b, cents: toCents(b.amountOwed.toString()) }))
          .filter(({ bill, cents }) => !isBillSettled(bill, cents, r.paidByParticipantId));
  const unpaidCount = unpaid?.length ?? null;
  const outstanding = unpaid ? centsToMoney(unpaid.reduce((sum, { cents }) => sum + cents, 0n)) : null;

  const guests = r.participants.filter((p) => p.id !== r.organizerParticipantId);
  const done = guests.filter((p) => p.picksSubmittedAt !== null).length;
  const open = r.picksOpenedAt !== null;
  const picks = !finalized && (open || done > 0) ? { open, done, total: guests.length } : null;

  return {
    id: r.id,
    status: r.status,
    merchantName: r.merchantName,
    title: r.title,
    total: r.total?.toFixed(2) ?? null,
    createdAt: r.createdAt.toISOString(),
    payerName: payer?.displayName ?? null,
    participantCount: r.participants.length,
    settled: unpaidCount === null ? null : unpaidCount === 0,
    unpaidCount,
    outstanding,
    nextStep: finalized ? null : landingStep(receiptSteps(r)),
    picks,
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
