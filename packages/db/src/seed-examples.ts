// Example finalized receipts for a signed-in organizer, so every home-list
// section (Waiting on payment, Settled) has something to show in local dev.
// Idempotent: rerunning restores the examples (undeletes them, resets who
// has paid) without duplicating anything.
//
//   pnpm db:seed:examples                      # most recently created real user
//   pnpm db:seed:examples -- you@example.com   # a specific user, by email
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "./client";

type Person = { key: string; name: string; paid?: boolean };
type Example = {
  key: string;
  merchantName: string;
  createdAt: string;
  money: { subtotal: string; tax: string; tip: string; total: string };
  // The first person is the organizer and payer.
  people: Person[];
  // Each person's bill, when the receipt has bills.
  share?: { subtotal: string; tax: string; tip: string; owed: string };
};

const EXAMPLES: Example[] = [
  {
    key: "taco-night", merchantName: "Taco Night", createdAt: "2026-11-10T02:30:00Z",
    money: { subtotal: "80.00", tax: "6.40", tip: "10.00", total: "96.40" },
    people: [{ key: "me", name: "You" }, { key: "maya", name: "Maya", paid: true }, { key: "sam", name: "Sam" }, { key: "jo", name: "Jo" }],
    share: { subtotal: "20.00", tax: "1.60", tip: "2.50", owed: "24.10" },
  },
  {
    key: "brunch-club", merchantName: "Brunch Club", createdAt: "2026-11-06T17:00:00Z",
    money: { subtotal: "51.00", tax: "4.50", tip: "6.00", total: "61.50" },
    people: [{ key: "me", name: "You" }, { key: "ari", name: "Ari", paid: true }, { key: "lee", name: "Lee", paid: true }],
    share: { subtotal: "17.00", tax: "1.50", tip: "2.00", owed: "20.50" },
  },
  {
    key: "coffee-run", merchantName: "Coffee Run", createdAt: "2026-11-02T15:00:00Z",
    money: { subtotal: "11.00", tax: "1.00", tip: "0.00", total: "12.00" },
    people: [{ key: "me", name: "You" }],
  },
];

async function resolveOwner(db: typeof prisma, email: string | undefined) {
  if (email) return db.user.findUniqueOrThrow({ where: { email } });
  const user = await db.user.findFirst({
    where: { id: { notIn: ["demo-user", "other-user"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!user) throw new Error("No signed-in user yet. Sign in once with GitHub, then rerun.");
  return user;
}

export async function seedExamples(email?: string, db = prisma) {
  const owner = await resolveOwner(db, email);
  for (const example of EXAMPLES) {
    const receiptId = `example-${owner.id}-${example.key}`;
    const personId = (key: string) => `${receiptId}-${key}`;
    await db.receipt.upsert({
      where: { id: receiptId },
      update: { deletedAt: null },
      create: {
        id: receiptId, ownerId: owner.id, merchantName: example.merchantName,
        imageBlobName: `examples/${example.key}.jpg`, imageContentType: "image/jpeg",
        parseStatus: "SUCCEEDED", status: "FINALIZED", reviewedAt: new Date(example.createdAt),
        finalizedAt: new Date(example.createdAt), createdAt: new Date(example.createdAt),
        ...example.money,
      },
    });
    await db.participant.createMany({
      data: example.people.map((p) => ({ id: personId(p.key), receiptId, displayName: p.name })),
      skipDuplicates: true,
    });
    await db.receipt.update({
      where: { id: receiptId },
      data: { paidByParticipantId: personId("me"), organizerParticipantId: personId("me") },
    });
    const { share } = example;
    if (!share) continue;
    for (const person of example.people) {
      const paidAt = person.paid ? new Date(example.createdAt) : null;
      await db.bill.upsert({
        where: { receiptId_participantId: { receiptId, participantId: personId(person.key) } },
        update: { paidAt },
        create: {
          receiptId, participantId: personId(person.key), paidAt,
          subtotal: share.subtotal, taxShare: share.tax, tipShare: share.tip, amountOwed: share.owed,
        },
      });
    }
  }
  return { owner, count: EXAMPLES.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const email = process.argv.slice(2).find((arg) => arg.includes("@"));
  seedExamples(email)
    .then(({ owner, count }) => {
      console.log(`Seeded ${count} example receipts for ${owner.name} (${owner.email}):`);
      console.log("  Taco Night  — waiting on payment (2 still owe $48.20)");
      console.log("  Brunch Club — settled, all paid");
      console.log("  Coffee Run  — finalized, no bills");
    })
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
