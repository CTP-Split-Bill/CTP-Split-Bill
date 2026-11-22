// boardTotals (docs/specs/bills/split-screen.md, "Running totals"): owed
// amounts once covered, items so far otherwise, and the sums always balance.
import { describe, expect, it } from "vitest";
import { boardTotals, type BoardSplitReceipt } from "../src/allocate";

const participants = ["a", "b", "c"].map((id, i) => ({ id, joinedAt: new Date(i * 1000) }));
const base: BoardSplitReceipt = {
  splitMode: "ITEMIZED", subtotal: "30.00", tax: "2.66", tip: "6.00", participants,
  items: [
    { totalPrice: "16.00", people: ["a"] },
    { totalPrice: "4.00", people: ["b"] },
    { totalPrice: "10.00", people: ["a", "b"] },
  ],
};

describe("boardTotals", () => {
  it("returns amounts owed once every item is covered", () => {
    const t = boardTotals(base);
    expect(t.owed).toBe(true);
    expect(t.rows.map((r) => r.amountOwed)).toEqual([2706n, 1160n, 0n]);
  });

  it("takes the discount off what people owe, so the rows add up to the receipt total", () => {
    const t = boardTotals({ ...base, discount: "3.00" });
    expect(t.owed).toBe(true);
    expect(t.rows.reduce((sum, r) => sum + r.amountOwed!, 0n)).toBe(3000n - 300n + 266n + 600n);
  });

  it("returns only items so far while an item is unclaimed", () => {
    const t = boardTotals({ ...base, items: [{ ...base.items[0], people: [] }, ...base.items.slice(1)] });
    expect(t).toMatchObject({ owed: false, unclaimedCount: 1, unclaimedCents: 1600n });
    expect(t.rows.map((r) => [r.itemsCents, r.amountOwed])).toEqual([[500n, null], [900n, null], [0n, null]]);
  });

  it("ignores people in EVEN and splits the subtotal", () => {
    const t = boardTotals({ ...base, splitMode: "EVEN" });
    expect(t.rows.map((r) => r.amountOwed)).toEqual([1289n, 1289n, 1288n]);
  });

  it("can't owe anything when the items don't match the subtotal", () => {
    const t = boardTotals({ ...base, subtotal: "31.00" });
    expect(t.owed).toBe(false);
    expect(t.unclaimedCount).toBe(0);
  });

  it("drops people who aren't on the roster", () => {
    const t = boardTotals({ ...base, items: [{ totalPrice: "30.00", people: ["ghost"] }] });
    expect(t.unclaimedCount).toBe(1);
  });

  it("always balances: rows plus unclaimed equal the items, and owed rows equal the total", () => {
    let s = 7;
    const next = () => (s = (s * 1103515245 + 12345) % 2147483648);
    for (let n = 0; n < 300; n++) {
      const items = Array.from({ length: 1 + (next() % 6) }, () => ({
        totalPrice: `${next() % 5000}.${String(next() % 100).padStart(2, "0")}`,
        people: participants.map((p) => p.id).filter(() => next() % 3 === 0),
      }));
      const cents = items.reduce((sum, i) => sum + BigInt(i.totalPrice.replace(".", "")), 0n);
      const subtotal = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
      const t = boardTotals({ ...base, subtotal, items });
      const rows = t.rows.reduce((sum, r) => sum + r.itemsCents, 0n);
      expect(rows + t.unclaimedCents).toBe(cents);
      if (t.owed) expect(t.rows.reduce((sum, r) => sum + r.amountOwed!, 0n)).toBe(cents + 266n + 600n);
    }
  });
});
