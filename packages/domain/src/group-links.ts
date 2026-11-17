// A group token grants roster access and one-time personal-link claims only.
// Claims and owner link changes serialize on the receipt row (ADR-0017).
import { z } from "zod";
import { prisma, type Prisma } from "@project/db";
import { ApiError } from "./errors";
import { receiptScope, requireReceiptUser } from "./receipt-access";
import { hashGuestToken, linkNotFound, newGuestToken, requireGuestToken } from "./guest-tokens";
import { guestReceiptSelect, presentGuestReceipt } from "./guest-receipt";

function groupScope(token: string) {
  requireGuestToken(token);
  return { groupTokenHash: hashGuestToken(token), deletedAt: null, parseStatus: { not: "PARSING" as const } };
}

async function setGroupLink(userId: string, receiptId: string, groupTokenHash: string | null) {
  await requireReceiptUser(userId);
  // A single owner-scoped UPDATE holds the receipt row lock through commit,
  // including after finalize. Claims wait and recheck this hash under that lock.
  const updated = await prisma.receipt.updateMany({
    where: receiptScope(userId, receiptId), data: { groupTokenHash },
  });
  if (updated.count !== 1) throw new ApiError("NOT_FOUND", "Receipt not found", 404);
}

export async function issueGroupLink(userId: string, receiptId: string): Promise<string> {
  const token = newGuestToken();
  await setGroupLink(userId, receiptId, hashGuestToken(token));
  return token;
}

export async function revokeGroupLink(userId: string, receiptId: string): Promise<void> {
  await setGroupLink(userId, receiptId, null);
}

const groupReceiptSelect = {
  ...guestReceiptSelect,
  organizerParticipantId: true,
  participants: {
    ...guestReceiptSelect.participants,
    select: { id: true, displayName: true, pickTokenHash: true },
  },
} satisfies Prisma.ReceiptSelect;

export async function getGroup(token: string) {
  const receipt = await prisma.receipt.findFirst({ where: groupScope(token), select: groupReceiptSelect });
  if (!receipt) throw linkNotFound();
  if (receipt.status === "FINALIZED") return presentGuestReceipt(receipt);
  return {
    status: receipt.status,
    merchantName: receipt.merchantName,
    purchasedAt: receipt.purchasedAt,
    pickingOpen: receipt.picksOpenedAt !== null,
    participants: receipt.participants
      .filter((p) => p.id !== receipt.organizerParticipantId)
      .map(({ id, displayName, pickTokenHash }) => ({ id, displayName, claimed: pickTokenHash !== null })),
  };
}

export const ClaimGroupParticipant = z.object({ participantId: z.string().trim().min(1).max(200) });
export type ClaimGroupParticipantInput = z.infer<typeof ClaimGroupParticipant>;

export async function claimGroupParticipant(token: string, input: ClaimGroupParticipantInput): Promise<string> {
  const scope = groupScope(token);
  const found = await prisma.receipt.findFirst({ where: scope, select: { id: true } });
  if (!found) throw linkNotFound();
  return prisma.$transaction(async (tx) => {
    // PostgreSQL rechecks this predicate after a concurrent UPDATE wins the
    // lock: a revoked/rotated token cannot pass with its pre-lock lookup.
    const locked = await tx.receipt.updateMany({
      where: { ...scope, id: found.id }, data: { revision: { increment: 0 } },
    });
    if (locked.count !== 1) throw linkNotFound();
    const receipt = await tx.receipt.findFirst({
      where: { ...scope, id: found.id }, select: { status: true, organizerParticipantId: true },
    });
    if (!receipt) throw linkNotFound();
    if (receipt.status === "FINALIZED") throw new ApiError("CONFLICT", "Receipt is finalized", 409);
    const participant = await tx.participant.findFirst({
      where: { id: input.participantId, receiptId: found.id }, select: { pickTokenHash: true },
    });
    if (!participant) throw new ApiError("NOT_FOUND", "Participant not found", 404);
    if (receipt.organizerParticipantId === input.participantId) {
      throw new ApiError("INVALID_INPUT", "You can't send yourself a pick link", 400);
    }
    const alreadyClaimed = () => new ApiError("CONFLICT", "Already claimed", 409);
    if (participant.pickTokenHash !== null) throw alreadyClaimed();
    const personalToken = newGuestToken();
    const updated = await tx.participant.updateMany({
      where: { id: input.participantId, receiptId: found.id, pickTokenHash: null },
      data: { pickTokenHash: hashGuestToken(personalToken) },
    });
    if (updated.count !== 1) throw alreadyClaimed();
    return personalToken;
  });
}
