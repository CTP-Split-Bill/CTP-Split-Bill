// Shared credential primitives for personal and group links (ADR-0015/0017).
// Raw tokens live only in memory; database queries and writes use their hashes.
import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "./errors";

export const newGuestToken = () => randomBytes(32).toString("base64url");
export const hashGuestToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const linkNotFound = () => new ApiError("NOT_FOUND", "Link not found", 404);

export function requireGuestToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw linkNotFound();
}
