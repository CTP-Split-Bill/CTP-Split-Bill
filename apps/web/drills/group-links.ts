// Real PostgreSQL contention and live HTTP verification for group links.
// Invoked only by the isolated db-server runner; tokens never reach stdout.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";

assert.equal(process.env.GROUP_LINKS_ISOLATED_DRILL, "1", "Run through the isolated db-server runner");
const databaseUrl = new URL(process.env.DATABASE_URL!);
assert.equal(databaseUrl.hostname, "127.0.0.1");
const { prisma, PrismaClient } = await import("@project/db");
const { ApiError, claimGroupParticipant, getPicks, hashPickToken, issueGroupLink, revokeGroupLink } = await import("@project/domain");
const require = createRequire(import.meta.url);
const independentClient = (name: string) => new PrismaClient({ adapter: new PrismaPg({
  connectionString: databaseUrl.toString(), application_name: name, max: 1,
}) });
const blocker = independentClient("group-links-blocker");
const observer = independentClient("group-links-observer");

const user = await prisma.user.create({ data: { name: "Drill owner", email: "group-drill@example.com" } });
async function fixture() {
  const receipt = await prisma.receipt.create({
    data: {
      ownerId: user.id, imageBlobName: "drill.jpg", imageContentType: "image/jpeg",
      merchantName: "Drill Cafe", parseStatus: "SUCCEEDED", reviewedAt: new Date(0),
      subtotal: "12", tax: "0", tip: "0", total: "12", splitMode: "EVEN",
      participants: { create: [
        { displayName: "Owner", joinedAt: new Date(0) },
        { displayName: "Guest", joinedAt: new Date(1) },
      ] },
      items: { create: { lineNumber: 1, name: "Soup", quantity: "1", unitPrice: "12", totalPrice: "12", isVerified: true } },
    },
    include: { participants: { orderBy: { joinedAt: "asc" } }, items: true },
  });
  await prisma.receipt.update({ where: { id: receipt.id }, data: {
    organizerParticipantId: receipt.participants[0].id, paidByParticipantId: receipt.participants[0].id,
  } });
  return { id: receipt.id, guestId: receipt.participants[1].id, itemId: receipt.items[0].id };
}

// Observe actual server-side waiters, so a missing receipt lock fails the drill.
async function waitForReceiptWaiters(count: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await observer.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'group-links-drill'
      AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%receipts%'
    `;
    if (result[0].count >= count) return;
    await delay(20);
  }
  throw new Error(`Did not observe ${count} blocked receipt updates`);
}
const outcome = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }),
);

async function contention(change: "rotate" | "revoke", claimFirst: boolean) {
  const d = await fixture();
  const token = await issueGroupLink(user.id, d.id);
  let unlock!: () => void;
  let locked!: () => void;
  const release = new Promise<void>((accept) => { unlock = accept; });
  const acquired = new Promise<void>((accept) => { locked = accept; });
  const blocking = blocker.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE receipts SET revision = revision WHERE id = ${d.id}`;
    locked();
    await release;
  }, { timeout: 15_000 });
  await acquired;
  const changeLink = () => change === "rotate" ? issueGroupLink(user.id, d.id) : revokeGroupLink(user.id, d.id);
  let claimant: ReturnType<typeof outcome<string>> | undefined;
  let owner: ReturnType<typeof outcome<string | void>> | undefined;
  try {
    if (claimFirst) claimant = outcome(claimGroupParticipant(token, { participantId: d.guestId }));
    else owner = outcome<string | void>(changeLink());
    await waitForReceiptWaiters(1);
    if (claimFirst) owner = outcome<string | void>(changeLink());
    else claimant = outcome(claimGroupParticipant(token, { participantId: d.guestId }));
    await waitForReceiptWaiters(2);
  } finally {
    unlock();
    await blocking;
  }
  const [claimed, changed] = await Promise.all([claimant!, owner!]);
  assert.equal(changed.ok, true);
  if (claimFirst) {
    assert.equal(claimed.ok, true);
    if (claimed.ok) assert.equal((await getPicks(claimed.value)).participantId, d.guestId);
  } else {
    assert.equal(claimed.ok, false);
    if (!claimed.ok) {
      assert(claimed.error instanceof ApiError);
      assert.equal(claimed.error.status, 404);
      assert.equal(claimed.error.message, "Link not found");
    }
    assert.equal((await prisma.participant.findUniqueOrThrow({ where: { id: d.guestId } })).pickTokenHash, null);
  }
  assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: d.id } })).revision, 1);
  console.log(`PASS PostgreSQL ${change}, ${claimFirst ? "claim" : "owner"} wins the lock`);
}

async function httpDrill() {
  const port = await new Promise<number>((accept, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      assert(address && typeof address !== "string");
      listener.close(() => accept(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const secret = randomBytes(32).toString("hex");
  const dev = process.argv.includes("--dev");
  const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"),
    ...(dev ? ["dev", "--turbopack"] : ["start"]), "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AUTH_SECRET: secret, AUTH_TRUST_HOST: "true", AUTH_URL: origin, NEXTAUTH_URL: origin },
  });
  let logs = "";
  server.stdout?.on("data", (chunk) => { logs += String(chunk); });
  server.stderr?.on("data", (chunk) => { logs += String(chunk); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.exitCode !== null) throw new Error("Next server exited before the HTTP drill");
      try {
        const res = await fetch(`${origin}/api/health`);
        if (res.status === 200) { ready = true; break; }
      } catch { /* server is still starting */ }
      await delay(100);
    }
    assert(ready, "Next server did not become healthy");
    const sessionToken = randomBytes(32).toString("hex");
    await prisma.session.create({ data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 600_000) } });
    const secrets = [sessionToken];
    const call = (path: string, method = "GET", body?: unknown, owner = false) => fetch(`${origin}${path}`, {
      method, redirect: "manual", headers: {
        ...(owner ? { Cookie: `authjs.session-token=${sessionToken}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const expectHeaders = (res: Response) => {
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("x-robots-tag"), "noindex");
    };
    assert.equal((await call("/api/receipts")).status, 401);
    const d = await fixture();
    const linkPath = `/api/receipts/${d.id}/group-link`;
    const issued = await call(linkPath, "POST", undefined, true);
    assert.equal(issued.status, 200, "Owner session did not authorize group issuance");
    assert.equal(issued.headers.get("cache-control"), "no-store");
    const groupUrl = (await issued.json()).url as string;
    let token = new URL(groupUrl).pathname.slice(3);
    secrets.push(token);
    const roster = await call(`/api/groups/${token}`);
    assert.equal(roster.status, 200);
    expectHeaders(roster);
    assert.deepEqual((await roster.json()).participants, [{ id: d.guestId, displayName: "Guest", claimed: false }]);
    const claimed = await call(`/api/groups/${token}/claim`, "POST", { participantId: d.guestId });
    assert.equal(claimed.status, 200);
    expectHeaders(claimed);
    const personalToken = new URL((await claimed.json()).url).pathname.slice(3);
    secrets.push(personalToken);
    const personalPath = `/api/picks/${personalToken}`;
    assert.equal((await call(personalPath)).status, 200);
    const repeated = await call(`/api/groups/${token}/claim`, "POST", { participantId: d.guestId });
    assert.equal(repeated.status, 409);
    expectHeaders(repeated);
    assert.deepEqual(await repeated.json(), { error: { code: "CONFLICT", message: "Already claimed" } });
    assert.equal((await call(personalPath, "PUT", { itemIds: [d.itemId] })).status, 409);
    assert.equal((await call(`/api/receipts/${d.id}/picking`, "POST", { open: true }, true)).status, 200);
    assert.equal((await call(personalPath, "PUT", { itemIds: [d.itemId] })).status, 200);
    assert.equal((await call(`${personalPath}/done`, "POST")).status, 200);
    const rotated = await call(linkPath, "POST", undefined, true);
    assert.equal(rotated.status, 200);
    const oldGroup = await call(`/api/groups/${token}`);
    assert.equal(oldGroup.status, 404);
    expectHeaders(oldGroup);
    token = new URL((await rotated.json()).url).pathname.slice(3);
    secrets.push(token);
    assert.equal((await call(personalPath)).status, 200);
    assert.equal((await call(`/api/receipts/${d.id}/picking`, "POST", { open: false }, true)).status, 200);
    const detail = await (await call(`/api/receipts/${d.id}`, "GET", undefined, true)).json();
    assert.equal(detail.hasGroupLink, true);
    assert.equal("groupTokenHash" in detail, false);
    assert.equal((await call(`/api/receipts/${d.id}/finalize`, "POST", { expectedRevision: detail.revision }, true)).status, 200);
    const summary = await call(`/api/groups/${token}`);
    assert.equal(summary.status, 200);
    expectHeaders(summary);
    const summaryBody = await summary.json();
    const { participantId: _holder, picksSubmittedAt: _done, ...personalSummary } = await (await call(personalPath)).json();
    assert.deepEqual(summaryBody, personalSummary);
    assert.equal(summaryBody.status, "FINALIZED");
    const finalizedClaim = await call(`/api/groups/${token}/claim`, "POST", { participantId: d.guestId });
    assert.equal(finalizedClaim.status, 409);
    expectHeaders(finalizedClaim);
    const page = await call(`/g/${token}`);
    assert.equal(page.status, 404, "Unbuilt group page should be public and not redirect to login");
    assert.equal(page.headers.get("location"), null);
    assert.equal((await call(linkPath, "DELETE", undefined, true)).status, 204);
    assert.equal((await call(`/api/groups/${token}`)).status, 404);
    assert.equal((await call(personalPath)).status, 200);
    const publicJson = JSON.stringify(summaryBody);
    for (const field of ["phone", "email", "ownerId", "groupTokenHash", "pickTokenHash", "imageBlobName", "extraction"]) {
      assert.equal(publicJson.includes(`"${field}"`), false);
    }
    await delay(100);
    for (const value of secrets) assert.equal(logs.includes(value), false, "Token appeared in server logs");
    console.log(`PASS live HTTP (${dev ? "Turbopack" : "production"}) owner session, anonymous claim/picks, rotation, finalize, privacy, headers and public path`);
  } finally {
    server.kill();
    if (server.exitCode === null) await new Promise<void>((accept) => server.once("exit", () => accept()));
  }
}

try {
  for (const change of ["rotate", "revoke"] as const) {
    await contention(change, false);
    await contention(change, true);
  }
  const d = await fixture();
  const token = await issueGroupLink(user.id, d.id);
  const results = await Promise.all([
    outcome(claimGroupParticipant(token, { participantId: d.guestId })),
    outcome(claimGroupParticipant(token, { participantId: d.guestId })),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const failure = results.find((result) => !result.ok);
  assert(failure && !failure.ok && failure.error instanceof ApiError);
  assert.equal(failure.error.status, 409);
  const winner = results.find((result) => result.ok);
  assert(winner && winner.ok);
  assert.equal((await prisma.participant.findUniqueOrThrow({ where: { id: d.guestId } })).pickTokenHash, hashPickToken(winner.value));
  console.log("PASS PostgreSQL concurrent claims have exactly one winner");
  await httpDrill();
} finally {
  await blocker.$disconnect();
  await observer.$disconnect();
  await prisma.$disconnect();
}
