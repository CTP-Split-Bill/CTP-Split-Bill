// Exact-cent split arithmetic (bills/split-allocation.md), pure: no database,
// logging or error-envelope import, so the picks board can run the same
// arithmetic in the browser (bills/split-screen.md). Imported by client code
// as `@project/domain/allocate`; split.ts wraps it for the API.

export interface SplitInput {
  splitMode: "EVEN" | "ITEMIZED";
  subtotal: bigint;
  discount?: bigint;
  tax: bigint;
  tip: bigint;
  members: { id: string; joinedAt: Date }[];
  items: { totalPrice: bigint; shares: { memberId: string; weight: number }[] }[];
}

export interface MemberAllocation {
  memberId: string;
  subtotal: bigint;
  discountShare: bigint;
  taxShare: bigint;
  tipShare: bigint;
  amountOwed: bigint;
}

type Fraction = { numerator: bigint; denominator: bigint };

// Thrown for input the allocator can't split. split.ts turns it into the
// API's 400; the board (bills/split-screen.md) treats it as "can't total yet".
export class SplitInputError extends Error {}

export function toCents(value: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new SplitInputError("Amounts must be non-negative money values");
  }
  const [integer, fraction = ""] = value.split(".");
  return BigInt(integer) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function centsToMoney(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function fraction(numerator: bigint, denominator: bigint): Fraction {
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function add(a: Fraction, b: Fraction): Fraction {
  return fraction(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

function roundColumn(total: bigint, exact: Fraction[]): bigint[] {
  const rounded = exact.map((value) => value.numerator / value.denominator);
  const remaining = total - rounded.reduce((sum, value) => sum + value, 0n);
  if (remaining < 0n || remaining >= BigInt(exact.length)) {
    throw new Error("Split column does not balance");
  }
  // Members are already in the joinedAt/id tie-break order.
  const order = exact.map((value, index) => ({
    index, remainder: value.numerator % value.denominator, denominator: value.denominator,
  })).sort((a, b) => {
    const difference = a.remainder * b.denominator - b.remainder * a.denominator;
    return difference > 0n ? -1 : difference < 0n ? 1 : a.index - b.index;
  });
  for (let i = 0; i < Number(remaining); i++) rounded[order[i].index] += 1n;
  return rounded;
}

function roundColumnCapped(total: bigint, exact: Fraction[], caps: bigint[]): bigint[] {
  const rounded = exact.map((value) => value.numerator / value.denominator);
  if (rounded.some((value, index) => value > caps[index])) {
    throw new Error("Rounded split exceeds a member's allocation capacity");
  }
  let remaining = total - rounded.reduce((sum, value) => sum + value, 0n);
  const order = exact.map((value, index) => ({
    index, remainder: value.numerator % value.denominator, denominator: value.denominator,
  })).sort((a, b) => {
    const difference = a.remainder * b.denominator - b.remainder * a.denominator;
    return difference > 0n ? -1 : difference < 0n ? 1 : a.index - b.index;
  });
  for (const entry of order) {
    if (remaining === 0n) break;
    if (rounded[entry.index] < caps[entry.index]) {
      rounded[entry.index] += 1n;
      remaining -= 1n;
    }
  }
  if (remaining !== 0n) throw new Error("Capped split column does not balance");
  return rounded;
}

export function allocateSplit(input: SplitInput): MemberAllocation[] {
  const invalid = (message: string): never => { throw new SplitInputError(message); };
  const discount = input.discount ?? 0n;
  if (input.subtotal <= 0n || discount < 0n || discount > input.subtotal || input.tax < 0n || input.tip < 0n) invalid("Receipt amounts are invalid");
  if (input.members.length === 0) invalid("Receipt has no participants");
  const members = [...input.members].sort((a, b) =>
    a.joinedAt.getTime() - b.joinedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const memberIndex = new Map(members.map((member, index) => [member.id, index]));
  if (memberIndex.size !== members.length) invalid("Participants must be unique");
  if (input.items.some((item) => item.totalPrice < 0n)
    || input.items.reduce((sum, item) => sum + item.totalPrice, 0n) !== input.subtotal) {
    invalid("Items must sum to the receipt subtotal");
  }

  const exactSubtotals: Fraction[] = members.map(() => ({ numerator: 0n, denominator: 1n }));
  if (input.splitMode === "EVEN") {
    exactSubtotals.fill(fraction(input.subtotal, BigInt(members.length)));
  } else {
    for (const item of input.items) {
      if (item.shares.length === 0) invalid("Every item must have at least one share");
      const assigned = new Set<string>();
      for (const share of item.shares) {
        if (!memberIndex.has(share.memberId) || assigned.has(share.memberId)
          || !Number.isInteger(share.weight) || share.weight <= 0 || share.weight > 2147483647) {
          invalid("Item shares must reference participants with positive integer weights");
        }
        assigned.add(share.memberId);
      }
      const totalWeight = item.shares.reduce((sum, share) => sum + BigInt(share.weight), 0n);
      for (const share of item.shares) {
        const index = memberIndex.get(share.memberId)!;
        exactSubtotals[index] = add(exactSubtotals[index], fraction(item.totalPrice * BigInt(share.weight), totalWeight));
      }
    }
  }

  const subtotal = roundColumn(input.subtotal, exactSubtotals);
  const proportionalColumn = (amount: bigint) => roundColumn(amount, exactSubtotals.map((value) =>
    fraction(amount * value.numerator, input.subtotal * value.denominator),
  ));
  const taxShare = proportionalColumn(input.tax);
  const tipShare = proportionalColumn(input.tip);
  const discountExact = exactSubtotals.map((value) =>
    fraction(discount * value.numerator, input.subtotal * value.denominator),
  );
  const discountShare = roundColumnCapped(discount, discountExact, subtotal);
  return members.map((member, index) => ({
    memberId: member.id,
    subtotal: subtotal[index],
    discountShare: discountShare[index],
    taxShare: taxShare[index],
    tipShare: tipShare[index],
    amountOwed: subtotal[index] + taxShare[index] + tipShare[index] - discountShare[index],
  }));
}

// ---- The picks board's running totals (bills/split-screen.md) ----

export type BoardSplitReceipt = {
  splitMode: string;
  subtotal: string | null;
  tax: string | null;
  tip: string | null;
  participants: { id: string; joinedAt: Date | string }[];
  // Who had each item: one id is a personal assignment, two or more an equal
  // share, none is unclaimed.
  items: { totalPrice: string | null; people: string[] }[];
};

export type BoardTotals = {
  // Every item is covered for the split mode, and the receipt amounts split
  // cleanly, so each row's amountOwed is set.
  owed: boolean;
  unclaimedCount: number;
  unclaimedCents: bigint;
  // In the order given. itemsCents is the person's items (shared items split
  // to the cent); amountOwed adds tax and tip, and is null until `owed`.
  rows: { participantId: string; itemsCents: bigint; amountOwed: bigint | null }[];
};

function centsOrZero(value: string | null): bigint {
  if (value === null) return 0n;
  try {
    return toCents(value);
  } catch {
    return 0n;
  }
}

export function boardTotals(receipt: BoardSplitReceipt): BoardTotals {
  const members = receipt.participants.map((p) => ({ id: p.id, joinedAt: new Date(p.joinedAt) }));
  const known = new Set(members.map((m) => m.id));
  const even = receipt.splitMode === "EVEN";
  const items = receipt.items.map((item) => ({
    totalPrice: centsOrZero(item.totalPrice),
    people: even ? [] : [...new Set(item.people)].filter((id) => known.has(id)),
  }));
  const unclaimed = even ? [] : items.filter((item) => item.people.length === 0);
  const unclaimedCents = unclaimed.reduce((sum, item) => sum + item.totalPrice, 0n);

  let owed: MemberAllocation[] | null = null;
  if (members.length > 0 && unclaimed.length === 0) {
    try {
      owed = allocateSplit({
        splitMode: even ? "EVEN" : "ITEMIZED",
        subtotal: toCents(receipt.subtotal ?? ""),
        tax: toCents(receipt.tax ?? ""),
        tip: receipt.tip === null ? 0n : toCents(receipt.tip),
        members,
        items: items.map((item) => ({
          totalPrice: item.totalPrice,
          shares: item.people.map((memberId) => ({ memberId, weight: 1 })),
        })),
      });
    } catch (e) {
      if (!(e instanceof SplitInputError)) throw e;
    }
  }
  if (owed) {
    const byId = new Map(owed.map((a) => [a.memberId, a]));
    return {
      owed: true,
      unclaimedCount: 0,
      unclaimedCents: 0n,
      rows: members.map((m) => ({
        participantId: m.id,
        itemsCents: byId.get(m.id)!.subtotal,
        amountOwed: byId.get(m.id)!.amountOwed,
      })),
    };
  }

  // Items so far: each claimed item split equally among its people, rounded
  // as finalization rounds the subtotal column, so the rows plus the
  // unclaimed amount add up to the items total.
  const sorted = [...members].sort((a, b) =>
    a.joinedAt.getTime() - b.joinedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const index = new Map(sorted.map((m, i) => [m.id, i]));
  const exact: Fraction[] = sorted.map(() => ({ numerator: 0n, denominator: 1n }));
  let claimedCents = 0n;
  if (even) {
    const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0n);
    if (sorted.length > 0) exact.fill(fraction(subtotal, BigInt(sorted.length)));
    claimedCents = sorted.length > 0 ? subtotal : 0n;
  } else {
    for (const item of items) {
      if (item.people.length === 0) continue;
      claimedCents += item.totalPrice;
      for (const id of item.people) {
        const i = index.get(id)!;
        exact[i] = add(exact[i], fraction(item.totalPrice, BigInt(item.people.length)));
      }
    }
  }
  const rounded = sorted.length > 0 ? roundColumn(claimedCents, exact) : [];
  return {
    owed: false,
    unclaimedCount: unclaimed.length,
    unclaimedCents,
    rows: members.map((m) => ({ participantId: m.id, itemsCents: rounded[index.get(m.id)!], amountOwed: null })),
  };
}
