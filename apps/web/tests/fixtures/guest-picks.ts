import type { GuestProjection } from "../../app/p/[token]/guest-view";

export function guestProjection(overrides: Partial<GuestProjection> = {}): GuestProjection {
  return {
    status: "DRAFT", merchantName: "Noodle Cafe", currency: "USD", participantId: "sam",
    picksSubmittedAt: null, pickingOpen: true,
    participants: [{ id: "owner", displayName: "Organizer" }, { id: "sam", displayName: "Sam" }, { id: "maya", displayName: "Maya" }],
    items: [
      { id: "rice", lineNumber: 1, name: "Rice", quantity: "2.000", totalPrice: "12.50", pickedBy: ["sam"] },
      { id: "tea", lineNumber: 2, name: "Tea", quantity: "1", totalPrice: "4.00", pickedBy: ["maya"] },
    ],
    ...overrides,
  };
}

export function withGuestPicks(itemIds: string[], overrides: Partial<GuestProjection> = {}): GuestProjection {
  const data = guestProjection(overrides);
  return { ...data, items: data.items.map((item) => ({
    ...item, pickedBy: [...item.pickedBy.filter((id) => id !== "sam"), ...(itemIds.includes(item.id) ? ["sam"] : [])],
  })) };
}

export function finalizedProjection(): GuestProjection {
  return guestProjection({
    status: "FINALIZED", pickingOpen: undefined, paidBy: "Organizer", picksSubmittedAt: "2026-01-01T00:00:00Z",
    participants: [
      { id: "owner", displayName: "Organizer", amountOwed: "8.50", settled: true },
      { id: "sam", displayName: "Sam", amountOwed: "4.00", settled: false },
      { id: "maya", displayName: "Maya", amountOwed: "4.00", settled: true },
    ],
  });
}
