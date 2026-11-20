// The discount migration preserves old bill snapshots and replaces legacy money equations.
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("backfills old bills and enforces discount-aware receipt and bill equations", async () => {
  const db = new PGlite("memory://");
  const dir = new URL("../../../packages/db/prisma/migrations/", import.meta.url);
  try {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql") && name < "0007").sort()) {
      await db.exec(readFileSync(new URL(file, dir), "utf8"));
    }
    await db.exec(`
      INSERT INTO users (id, name, email) VALUES ('owner', 'Owner', 'discount@example.com');
      INSERT INTO receipts (id, owner_id, image_blob_name, image_content_type, subtotal, tax, tip, total)
        VALUES ('receipt', 'owner', 'photo.jpg', 'image/jpeg', 30, 2.70, 6, 38.70);
      INSERT INTO participants (id, receipt_id, display_name) VALUES ('person', 'receipt', 'Person');
      INSERT INTO bills (id, receipt_id, participant_id, subtotal, tax_share, tip_share, amount_owed)
        VALUES ('bill', 'receipt', 'person', 30, 2.70, 6, 38.70);
    `);
    await db.exec(readFileSync(new URL("0007_receipt_discount.sql", dir), "utf8"));

    expect((await db.query("SELECT discount FROM receipts WHERE id = 'receipt'")).rows)
      .toEqual([{ discount: null }]);
    expect((await db.query("SELECT discount_share, amount_owed FROM bills WHERE id = 'bill'")).rows)
      .toEqual([{ discount_share: "0.00", amount_owed: "38.70" }]);

    await db.exec("UPDATE receipts SET discount = 3, total = 35.70, status = 'FINALIZED' WHERE id = 'receipt'");
    await expect(db.exec("UPDATE receipts SET total = 38.70 WHERE id = 'receipt'"))
      .rejects.toThrow(/receipts_finalized_money_check/i);
    await db.exec("UPDATE bills SET discount_share = 3, amount_owed = 35.70 WHERE id = 'bill'");
    await expect(db.exec("UPDATE bills SET amount_owed = 38.70 WHERE id = 'bill'"))
      .rejects.toThrow(/bills_money_check/i);
  } finally {
    await db.close();
  }
}, 30_000);
