import { describe, expect, it } from "vitest";
import { extractReceiptText } from "../src/receipt-parsing";

describe("conservative receipt text extraction", () => {
  it("extracts explicit fields without inventing unknown quantities or prices", () => {
    expect(extractReceiptText("Merchant: Corner Cafe\nDate: 2026-11-09\nAddress: 10 Main Street\n2 x Soup @ 5.00 10.00\nTea 3.00\nSubtotal 13.00\nTax 1.00\nTip 2.00\nTotal 16.00")).toEqual({
      merchantName: "Corner Cafe", purchasedAt: "2026-11-09T00:00:00.000Z", address: "10 Main Street",
      subtotal: "13.00", tax: "1.00", tip: "2.00", total: "16.00",
      items: [
        { name: "Soup", quantity: "2", unitPrice: "5.00", totalPrice: "10.00" },
        { name: "Tea", quantity: null, unitPrice: null, totalPrice: "3.00" },
      ],
    });
  });

  it("keeps ambiguous labels and invalid dates unknown and skips summary/negative lines", () => {
    const result = extractReceiptText("Corner Cafe\nDate: 2026-02-30\nSoup 5.00\nTax 0.20\nTax 0.30\nTax 0.40\nCash 20.00\nChange 14.50\nDiscount -1.00\nCoupon - 1.00");
    expect(result).toMatchObject({ merchantName: null, purchasedAt: null, tax: null, subtotal: null, tip: null, total: null });
    expect(result.items).toEqual([{ name: "Soup", quantity: null, unitPrice: null, totalPrice: "5.00" }]);
  });

  it.each([null, {}, "", "No readable amounts", "x".repeat(100_001), "Soup 10000000000.00", "x".repeat(201) + " 1.00", "0 x Soup @ 5.00 0.00", "10000000 x Soup @ 5.00 5.00"])("rejects unusable or out-of-schema extraction %j", (text) => {
    expect(() => extractReceiptText(text)).toThrow(expect.objectContaining({ code: "INVALID_INPUT", status: 400 }));
  });

  it("allows 500 items and rejects 501", () => {
    expect(extractReceiptText(Array(500).fill("Soup 5.00").join("\n")).items).toHaveLength(500);
    expect(() => extractReceiptText(Array(501).fill("Soup 5.00").join("\n"))).toThrow();
  });

  // Dot-matrix fonts print the decimal point as a tick that OCR reads as a
  // comma, sometimes with a stray space (docs/specs/receipts/parse.md).
  it("reads comma decimals and ignores a numeric store label", () => {
    const text = [
      "McDonald's", "Store: 7361 | Register: 20", "Big Mac Meal $8 ,99", "French Fries $3,49",
      "Coke Medium $2,29", "Subtotal $14,77", "Tax $1,26", "Total $16.03",
    ].join("\n");
    expect(extractReceiptText(text)).toEqual({
      merchantName: null, address: null, purchasedAt: null,
      subtotal: "14.77", tax: "1.26", tip: null, total: "16.03",
      items: [
        { name: "Big Mac Meal", quantity: null, unitPrice: null, totalPrice: "8.99" },
        { name: "French Fries", quantity: null, unitPrice: null, totalPrice: "3.49" },
        { name: "Coke Medium", quantity: null, unitPrice: null, totalPrice: "2.29" },
      ],
    });
  });

  it("extracts a grocery receipt whose OCR text uses comma decimals throughout", () => {
    // Local OCR output for a clear printed grocery receipt, verbatim.
    const text = `ALBERTSONS
2847 N Main Street
Santa Ana, CA 92705
(714) 555-0198
11/15/2024, 2:34:18 PM

Store #2847
Cashier Sarah M,
2 Organic Bananas 3,18
1 2% Milk Gallon 4,99
1 Whole Wheat Bread 3,49
3 Greek Yogurt 60z 5,97
1 Rotisserie Chicken 7,99
2 Roma Tomatoes |b 2,98
1 Fresh Spinach 3,29
1 Signature Pasta 1,99
1 Pasta Sauce 2doz 2,79
1 Shredded Mozzarella 4,49

Subtotal $41,16

Tax $2,88

TOTAL $44.04
Card Type VISA
Account eo KAKI 532
Auth Code 047823
Amount Charged $44,04

You Saved $3,25 Today!
Thank you for shopping at Albertsons`;
    const result = extractReceiptText(text);
    expect(result).toMatchObject({ subtotal: "41.16", tax: "2.88", tip: null, total: "44.04", merchantName: null });
    expect(result.items.map((i) => i.totalPrice)).toEqual(["3.18", "4.99", "3.49", "5.97", "7.99", "2.98", "3.29", "1.99", "2.79", "4.49"]);
    expect(result.items[0]).toEqual({ name: "2 Organic Bananas", quantity: null, unitPrice: null, totalPrice: "3.18" });
  });

  it("never reads a thousands comma as a decimal point", () => {
    expect(() => extractReceiptText("Catering 1,080\nSubtotal 1,080")).toThrow(expect.objectContaining({ status: 400 }));
    expect(extractReceiptText("Soup 5.00\nCatering 1,080\nBanquet 1,080.50").items).toEqual([
      { name: "Soup", quantity: null, unitPrice: null, totalPrice: "5.00" },
    ]);
  });

  it("keeps a named store label as the merchant", () => {
    expect(extractReceiptText("Store: Corner Cafe\nSoup 5,00").merchantName).toBe("Corner Cafe");
  });
});
