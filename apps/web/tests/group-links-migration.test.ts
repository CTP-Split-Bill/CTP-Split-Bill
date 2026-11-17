// Apply the group credential migration to an existing database, not just a fresh schema.
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("preserves existing receipts, defaults hashes to null and enforces non-null uniqueness", async () => {
  const db = new PGlite("memory://");
  const dir = new URL("../../../packages/db/prisma/migrations/", import.meta.url);
  try {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql") && name < "0006").sort()) {
      await db.exec(readFileSync(new URL(file, dir), "utf8"));
    }
    await db.exec(`
      INSERT INTO users (id, name, email) VALUES ('owner', 'Owner', 'migration@example.com');
      INSERT INTO receipts (id, owner_id, image_blob_name, image_content_type, merchant_name, revision)
      VALUES ('first', 'owner', 'photo.jpg', 'image/jpeg', 'Cafe', 7),
             ('second', 'owner', 'other.jpg', 'image/jpeg', 'Diner', 2);
    `);
    const before = (await db.query<Record<string, unknown>>("SELECT * FROM receipts ORDER BY id")).rows;
    await db.exec(readFileSync(new URL("0006_group_pick_link.sql", dir), "utf8"));
    expect((await db.query("SELECT * FROM receipts ORDER BY id")).rows)
      .toEqual(before.map((row) => ({ ...row, group_token_hash: null })));
    const tokenHash = "a".repeat(64);
    await db.query("UPDATE receipts SET group_token_hash = $1 WHERE id = 'first'", [tokenHash]);
    await expect(db.query("UPDATE receipts SET group_token_hash = $1 WHERE id = 'second'", [tokenHash]))
      .rejects.toThrow(/unique/i);
    await db.exec("UPDATE receipts SET group_token_hash = NULL WHERE id = 'first'");
    expect((await db.query("SELECT group_token_hash FROM receipts")).rows)
      .toEqual([{ group_token_hash: null }, { group_token_hash: null }]);
  } finally {
    await db.close();
  }
}, 30_000);
