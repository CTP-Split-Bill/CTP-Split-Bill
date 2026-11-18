// Isolated PostgreSQL runner for the group-link lock and HTTP drills.
// Uses installed binaries and temporary data; never opens the development cluster.
import EmbeddedPostgres from "embedded-postgres";
import { applyMigrations } from "@project/db/migrate";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = await mkdtemp(join(tmpdir(), "ctp-group-links-"));
const port = await new Promise<number>((accept, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("No drill port"));
    server.close(() => accept(address.port));
  });
});
const postgres = new EmbeddedPostgres({
  databaseDir: dataDir, port, user: "postgres", password: "local-drill-only",
  persistent: true, onLog: () => {}, onError: () => {},
  postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
});
let started = false;
try {
  await postgres.initialise();
  await postgres.start();
  started = true;
  const db = postgres.getPgClient("postgres", "127.0.0.1");
  await db.connect();
  try {
    await applyMigrations({
      exec: async (sql) => { await db.query(sql); },
      query: (sql, params) => db.query(sql, params),
    });
  } finally {
    await db.end();
  }
  const databaseUrl = `postgresql://postgres:local-drill-only@127.0.0.1:${port}/postgres?application_name=group-links-drill`;
  const exitCode = await new Promise<number>((accept, reject) => {
    const child = spawn(process.execPath, [require.resolve("tsx/cli"), "drills/group-links.ts", ...process.argv.slice(2)], {
      cwd: join(root, "apps/web"), windowsHide: true, stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl, PGLITE_DATA_DIR: "", PG_POOL_MAX: "5", LOG_LEVEL: "silent", GROUP_LINKS_ISOLATED_DRILL: "1" },
    });
    child.once("error", reject);
    child.once("exit", (code) => accept(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`Group-link drill failed (${exitCode})`);
} finally {
  if (started) await postgres.stop();
  // The only recursive cleanup target is the directory made above in tmpdir.
  if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith("ctp-group-links-")) {
    throw new Error("Refusing cleanup outside the drill's temporary directory");
  }
  await rm(dataDir, { recursive: true, force: true });
}
