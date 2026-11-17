// Holder-independent receipt and finalized split projection shared by token routes.
// Only allowlisted fields are selected and serialized (receipts/guest-picks.md).
import type { Prisma } from "@project/db";
import { isBillSettled } from "./bills";
import { centsToMoney, toCents } from "./split";

export const guestReceiptSelect = {
  status: true,
  revision: true,
  picksOpenedAt: true,
  merchantName: true,
  purchasedAt: true,
  currency: true,
  paidByParticipantId: true,
  participants: {
    select: { id: true, displayName: true },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
  },
  items: {
    select: {
      id: true, lineNumber: true, name: true, quantity: true, totalPrice: true,
      assignedParticipantId: true,
      sharedAllocations: {
        select: { participantId: true },
        orderBy: [{ participant: { joinedAt: "asc" } }, { participantId: "asc" }],
      },
    },
    orderBy: { lineNumber: "asc" },
  },
  bills: { select: { participantId: true, amountOwed: true, paidAt: true } },
} satisfies Prisma.ReceiptSelect;

export const pickersOf = (item: {
  assignedParticipantId: string | null;
  sharedAllocations: { participantId: string }[];
}) => item.assignedParticipantId !== null
  ? [item.assignedParticipantId]
  : item.sharedAllocations.map((allocation) => allocation.participantId);

export function presentGuestReceipt(receipt: Prisma.ReceiptGetPayload<{ select: typeof guestReceiptSelect }>) {
  const base = {
    status: receipt.status,
    revision: receipt.revision,
    merchantName: receipt.merchantName,
    purchasedAt: receipt.purchasedAt,
    currency: receipt.currency,
    items: receipt.items.map((item) => ({
      id: item.id, lineNumber: item.lineNumber, name: item.name,
      quantity: item.quantity, totalPrice: item.totalPrice, pickedBy: pickersOf(item),
    })),
  };
  if (receipt.status !== "FINALIZED") {
    return {
      ...base,
      pickingOpen: receipt.picksOpenedAt !== null,
      participants: receipt.participants.map(({ id, displayName }) => ({ id, displayName })),
    };
  }
  const bills = new Map(receipt.bills.map((bill) => [bill.participantId, bill]));
  const payer = receipt.participants.find((p) => p.id === receipt.paidByParticipantId);
  return {
    ...base,
    paidBy: payer?.displayName ?? null,
    participants: receipt.participants.map(({ id, displayName }) => {
      const bill = bills.get(id);
      const owed = bill ? toCents(bill.amountOwed.toString()) : 0n;
      return {
        id, displayName, amountOwed: centsToMoney(owed),
        settled: bill ? isBillSettled(bill, owed, receipt.paidByParticipantId) : true,
      };
    }),
  };
}
