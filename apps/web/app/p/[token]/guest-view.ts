// Only the public token projection crosses this boundary. Decimal strings are
// formatted without narrowing them to Number (receipts/guest-picks.md).
type DecimalValue = string | { toString(): string };
export type GuestProjection = {
  status: "DRAFT" | "FINALIZED";
  merchantName: string | null;
  currency: string;
  participantId: string;
  picksSubmittedAt: string | Date | null;
  pickingOpen?: boolean;
  paidBy?: string | null;
  items: {
    id: string; lineNumber: number; name: string | null;
    quantity: DecimalValue | null; totalPrice: DecimalValue | null; pickedBy: string[];
  }[];
  participants: {
    id: string; displayName: string; amountOwed?: string; settled?: boolean;
  }[];
};

export type GuestView = {
  finalized: boolean;
  title: string;
  participantId: string;
  holderName: string;
  submitted: boolean;
  pickingOpen: boolean;
  paidBy: string | null;
  items: { id: string; name: string; quantity: string | null; price: string; pickedBy: string[] }[];
  people: { id: string; name: string; amount: string | null; settled: boolean }[];
};

export function guestMoney(value: string | null, currency: string): string {
  if (value === null) return "—";
  const [whole, fraction = "00"] = value.split(".");
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).formatToParts(BigInt(whole)).map((part) =>
      part.type === "fraction" ? fraction.padEnd(2, "0") : part.value,
    ).join("");
  } catch {
    return `${currency} ${value}`;
  }
}

export function toGuestView(data: GuestProjection): GuestView {
  return {
    finalized: data.status === "FINALIZED",
    title: data.merchantName ?? "Your receipt",
    participantId: data.participantId,
    holderName: data.participants.find((p) => p.id === data.participantId)?.displayName ?? "Guest",
    submitted: data.picksSubmittedAt !== null,
    pickingOpen: data.status === "DRAFT" && data.pickingOpen === true,
    paidBy: data.paidBy ?? null,
    items: [...data.items].sort((a, b) => a.lineNumber - b.lineNumber).map((item) => ({
      id: item.id, name: item.name?.trim() || `Item ${item.lineNumber}`,
      quantity: item.quantity === null ? null : item.quantity.toString().replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""),
      price: guestMoney(item.totalPrice?.toString() ?? null, data.currency),
      pickedBy: item.pickedBy,
    })),
    people: data.participants.map((p) => ({
      id: p.id, name: p.displayName,
      amount: p.amountOwed === undefined ? null : guestMoney(p.amountOwed, data.currency),
      settled: p.settled ?? false,
    })),
  };
}

export function holderItems(view: GuestView): string[] {
  return view.items.filter((item) => item.pickedBy.includes(view.participantId)).map((item) => item.id);
}

export const INVALID_LINK = "This link isn't valid";
