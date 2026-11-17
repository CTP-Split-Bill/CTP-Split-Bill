# Issue #65 — Receipt deletion and restoration backend

**Project:** CTP-Split-Bill
**Issue:** https://github.com/kev-s0l/CTP-Split-Bill/issues/65
**Status:** DELETE and restore backends implemented and verified locally; ADR-0019 proposed for review.
**Scope:** Domain logic, API contracts, documentation and backend verification only.

## 1. Start from the existing DELETE implementation

Reuse `softDeleteReceipt(userId: string, receiptId: string)` in
`packages/domain/src/receipt.ts`. It already:

- Validates the current user with `requireReceiptUser(userId)`.
- Uses `receiptScope(userId, receiptId)` to match the receipt ID, current owner
  and `deletedAt: null`.
- Atomically sets `deletedAt` to the server timestamp through `updateMany`.
- Throws a 404 `ApiError` when no receipt matches.
- Preserves revision, receipt state, bills, participants, picks and tokens.
- Returns no receipt data on success; Prisma also maintains `updatedAt`.

The existing `DELETE /api/receipts/[id]` handler in
`apps/web/app/api/receipts/[id]/route.ts` already obtains identity from
`currentUserId()`, awaits the route ID, calls `softDeleteReceipt`, revalidates
`/`, and returns an empty 204. Errors go through `toApiError`.

Do not rename or replace this function, add a second delete implementation, or
add draft/revision guards to it.

Existing work to retain:

- [x] `softDeleteReceipt` and the DELETE handler.
- [x] `apps/web/tests/receipts-delete-route.test.ts`: 18 DELETE checks.
- [x] DELETE documentation in `docs/specs/receipts/delete.md`, `api.md` and the spec index.
- [x] Complete the existing `apps/web/app/api/receipts/[id]/restore/route.ts` scaffold;
  route type checks and the production build pass.

## 2. Specifications and the restore contract

- [x] Extend `docs/specs/receipts/delete.md` to describe restoration, ownership,
  preserved data, exact response/error behavior and concurrent requests.
- [x] Document the narrow owner-only restore exception in `docs/specs/api.md` and
  propose ADR-0019, retaining existing scopes for ordinary operations.
- [x] Document restore's lack of an expected revision and unchanged revision.
- [ ] Human review of the updated specification and proposed ADR before merge.

The implementation needs no new dependencies, schema changes or migrations.

## 3. Reuse the existing receipt summary contract

**Files:** `packages/domain/src/receipt-summaries.ts` and its existing route tests.

- [x] Extract a shared receipt selection/projection that both the existing summary
  collection and restore can use without loading the entire list.
- [x] Preserve existing summary fields, nullable values, two-place money strings,
  ISO dates and settlement semantics.
- [x] Reuse `isBillSettled` for settlement semantics: manually paid bills, the
  receipt payer and zero-owed bills count as settled.
- [x] Test that restore returns the existing `ReceiptSummary` shape without
  exposing token hashes, storage details or unrelated receipt data.

Restore returns the existing summary shape: `id`, `status`, `merchantName`,
`title`, `total`, `createdAt`, `payerName`, `participantCount` and `settled`.
It does not add fields, return raw database rows or recompute stored amounts.

## 4. Implement the restore domain function and API

**Files:** `packages/domain/src/receipt-restoration.ts`, `receipt-summaries.ts`, `index.ts`,
and the existing restore route scaffold.

### Domain function

- [x] Add `restoreReceipt(userId, receiptId)` in `receipt-restoration.ts`, keeping
  the existing `softDeleteReceipt` in place and avoiding a circular dependency
  between receipt summaries, bill settlement and receipt edits.
- [x] Validate the authenticated user and reject missing/blank IDs before querying.
- [x] In one transaction, conditionally update the receipt matching its ID,
  `ownerId: userId` and non-null `deletedAt`, clearing only `deletedAt`.
- [x] When no row matches, use an owner-scoped read to distinguish a live owned
  receipt (409) from an unknown or foreign receipt (404).
- [x] Read and project the restored summary inside the same transaction so a
  concurrent delete cannot intervene between restoration and the summary read.
- [x] Keep normal `receiptScope` behavior unchanged; it excludes deleted receipts
  and must not be broadened to make restore work.
- [x] Export the new `receipt-restoration.ts` module through `index.ts`.

Preserve revision, status, parsing/review/finalization and picking state, all
participants/assignments, picks/submissions, bill amounts/payment timestamps,
token hashes and the stored image. Only `deletedAt` and Prisma's `updatedAt` change.

### POST /api/receipts/[id]/restore

- [x] Accept a request without a JSON body or `expectedRevision`.
- [x] Derive user identity from `currentUserId()` and await the route ID.
- [x] Call `restoreReceipt`, revalidate `/` after success and return the summary as JSON.
- [x] Map failures through `toApiError`; do not revalidate after a domain failure.
- [x] Add the route and its behavior to `docs/specs/api.md`.

| Scenario | Status |
|---|---|
| Owned deleted receipt, including draft/parsing/finalized states | 200 with summary |
| Owned receipt already active | 409 |
| Foreign, unknown, missing-ID or blank-ID receipt | 404 |
| Missing or unknown current user | 401 |
| Unexpected failure | Generic 500 error envelope |

Two simultaneous restores of the same deleted receipt, without an intervening
delete, produce one 200 and one 409.

## 5. Backend tests and verification

Retain the existing DELETE tests and add focused restore and summary coverage
using migrated in-memory PGlite. Tests require no running services.

- [x] Restore deleted draft, parsing and finalized receipts, including unpaid bills.
- [x] Check 401/404/409 cases, missing IDs, concurrent restores and generic 500 errors.
- [x] Check successful-only route revalidation and exact summary serialization.
- [x] Snapshot before delete and after restore to verify preserved revision,
  receipt state, participants, assignments, picks/submissions, bills and tokens.
- [x] Exercise delete -> restore through real PGlite route handlers: the receipt
  leaves/rejoins history and summaries; original detail/image, bills, server access guards
  and guest links work again with the same IDs/tokens.
- [x] Check summary settlement for drafts, no bills, payer, zero balances, paid
  and unpaid bills, along with nullable metadata and money/date serialization.
- [x] Check failed restores leave the deletion timestamp and related data unchanged.
- [x] Check repeated restore returns 409 and does not change revision or revalidate.
- [x] Check a second DELETE after restoration succeeds using the existing handler.
- [x] Check a receipt remains deleted across repeated reads until restore is called.
- [x] Run `pnpm test`, `pnpm typecheck` and `pnpm build`.
- [x] Read the diff and confirm every updated specification's Verify drill is true.

Automated API drill through real handlers against PGlite:

1. Read an owned receipt, its summary and its existing guest link successfully.
2. Call the existing DELETE handler; verify empty 204, exclusion from list APIs
   and 404 from receipt and guest-link reads.
3. Call POST restore; verify 200 and the exact existing summary shape.
4. Read the same receipt, image metadata, bills and guest link again; verify the
   same IDs/tokens and preserved data, with blob bytes mocked at the storage seam.
5. Repeat restore; verify 409, then delete again and verify it stays deleted
   across reads without another restore request.

## 6. Completion and limits

The backend scope is complete when restore works alongside the existing DELETE
operation, returns the shared summary, preserves original data and link tokens,
has reviewed/current specifications, and passes the checks and API drill above.

This backend plan does not add a deleted-receipt listing API, permanent deletion,
image cleanup, bulk operations or token regeneration. Restoration has no
server-side expiry window.

Specs and code land in the same PR. Implementation commits may separate domain,
API and tests, but specification review precedes them. Existing accepted
ADRs and landed postmortems are not edited.

## Verification results

- Root test run with four workers: 669 passed; two opt-in checks skipped.
- Command: `pnpm test -- -- --maxWorkers=4`; the default worker count hit the existing migration startup timeout.
- `pnpm typecheck`, `pnpm build` and `git diff --check` pass.
- The PGlite delete/restore API drill passes; 24 restore checks supplement the 18 DELETE checks.
