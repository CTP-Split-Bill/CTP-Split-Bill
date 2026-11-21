---
type: feature
---
# The organizer soft-deletes and restores an owned receipt without changing its contents

## Why

Organizers can remove unwanted test uploads, duplicates and old receipts from
their history while preserving receipt data and finalized financial snapshots,
and reverse a deletion using the same receipt ID and guest links.

## Where it lives

- packages/domain/src/receipt.ts: softDeleteReceipt.
- packages/domain/src/receipt-restoration.ts: transactional restoreReceipt.
- packages/domain/src/receipt-summaries.ts: shared summary selection/projection.
- packages/domain/src/receipt-access.ts: current-user validation and live owner scope.
- apps/web/app/api/receipts/[id]/route.ts: DELETE handler.
- apps/web/app/api/receipts/[id]/restore/route.ts: POST handler.
- apps/web/tests/receipts-delete-route.test.ts: PGlite route and visibility checks.

## Behavior

- `DELETE /api/receipts/[id]` derives identity from the session and accepts no
  required body or expected revision. Client-supplied ownership is never used.
- The domain function validates the current user. Missing or unknown users
  receive 401. Foreign, unknown, missing-ID and already-deleted receipts receive
  404, without revealing whether another organizer owns a receipt.
- One conditional update matches receipt ID, current owner and `deletedAt: null`,
  and sets `deletedAt` to the server's current timestamp. The update is atomic;
  two concurrent deletes yield one success and one 404.
- Any live receipt can be deleted: DRAFT or FINALIZED, while parsing or picking
  is open, and even with unpaid bills. Deletion does not require draft edit guards.
- Success returns 204 with an empty body and revalidates `/`.
- Receipt revision, metadata, amounts, review/finalization/parsing state, picking
  state, participants, item assignments, shared allocations, token hashes and
  bill snapshots remain unchanged. Prisma maintains `updatedAt` as bookkeeping.
- No rows or stored photo bytes are removed. Existing read guards omit the
  receipt from history and home summaries, and reject receipt detail, image,
  bills, step pages and guest pick links as not found. Guest pick writes also
  reject the deleted receipt. The image route authorizes before reading storage.
- An in-flight OCR completion that reaches the database after deletion fails
  its live-receipt guard; it cannot replace the deleted receipt's content.
- `POST /api/receipts/[id]/restore` derives identity from the session, accepts no
  required body or expected revision, and restores an owned deleted receipt in
  any state. Missing/unknown users receive 401; foreign, unknown or missing/blank
  receipt IDs receive 404. An already-live owned receipt receives 409.
- Restore is the isolated deleted-row exception in ADR-0019. It conditionally
  clears deletedAt and reads the summary within one transaction, preserving
  receipt revision, all content and child data, with Prisma maintaining updatedAt.
  A summary-read failure rolls back the restoration.
- Success returns 200 with exactly the existing ReceiptSummary fields: id,
  status, nullable merchantName/title/total/payerName, ISO createdAt,
  participantCount, nullable settled/unpaidCount/outstanding/nextStep/picks
  (bills/list-screen.md). Money has two decimal places and
  settlement uses the same projection as GET /api/receipts/summary. No token
  hashes, blob references or unrelated data are returned. Success revalidates `/`.
- Without an intervening delete, concurrent restores yield one 200 and one 409.
  Failed restores do not change data or revalidate. A restored receipt can be
  deleted again using the existing DELETE operation.
- History, summaries, owner reads and existing guest links become available
  again under their unchanged access/state guards. Restore does not restart OCR
  or change picking mode; parsing receipts retain their normal recovery rules.
  Restoration has no server-side expiry.
- Errors use `{ error: { code, message } }`. Unexpected failures return the
  generic 500 response; failed deletion does not revalidate the home page.

## Examples

| State / input | Behavior |
|---|---|
| Owned draft with picking open | 204; deletion timestamp set; revision and picks unchanged |
| Owned receipt currently parsing | 204; parsing state unchanged; later completion cannot write while deleted |
| Owned finalized receipt with unpaid bills | 204; all bills and amounts preserved |
| Another organizer's receipt or unknown ID | 404; no mutation or revalidation |
| Repeated deletion | 404; original deletion timestamp preserved |
| Two simultaneous deletes | One 204 and one 404 |
| Missing session identity | 401; no mutation |
| Read deleted receipt or use its guest link | 404; lists omit the receipt |
| Restore owned deleted draft/parsing/finalized receipt | 200 existing summary; data/revision preserved |
| Restore live owned receipt, including repeat restoration | 409; no mutation or revalidation |
| Restore foreign or unknown receipt, live or deleted | 404; ownership not disclosed |
| Two simultaneous restores without an intervening delete | One 200 and one 409 |
| Delete, restore, read original guest link | Same token works under the unchanged receipt state |

## Verify

- Run `pnpm --dir apps/web exec vitest run tests/receipts-delete-route.test.ts`.
  The automated API drill invokes real handlers against migrated in-memory
  PGlite: reads succeed, DELETE returns an empty 204, then list/detail/image,
  bills, guest-link reads/writes and every step guard hide the receipt.
- The same suite checks current-user scoping, missing IDs, authentication,
  repeated/concurrent deletion, all receipt states, unchanged child rows and
  token hashes, home revalidation, late OCR completion and generic failures.
- The restore checks cover every parsing state, finalized paid/unpaid bills,
  nullable summaries, ownership/authentication and missing IDs, concurrency,
  transaction rollback and generic errors. The delete/restore API drill verifies
  history, summaries, original image bytes (storage mocked), owner reads and
  original guest links become available, followed by repeat restore and re-delete.
- Run `pnpm test`, `pnpm typecheck` and `pnpm build`.
- If parallel PGlite startup exceeds the migration hook timeout, run
  `pnpm test -- -- --maxWorkers=4` to limit Vitest workers without changing tests.

## Constraints & decisions

- Deletion is a visibility change, not a content edit; it neither requires nor
  advances the receipt revision. The conditional parent-row update supplies the
  lock and keeps the ownership/deletion checks in the write itself.
- Soft deletion preserves immutable calculated bills (ADR-0014) and the stored
  photo. No schema change, migration, new dependency or physical cleanup is needed.
- Existing ownership and deleted-receipt read guards remain the access boundary;
  deletion does not rotate or revoke guest tokens separately.
- See ADR-0019 for the narrow restore exception; normal receiptScope is unchanged.
  Restoration lives in a separate module to reuse the summary projection without
  creating a receipt/bill initialization cycle. Restore returns the same summary
  shape as the home list (bills/list-screen.md).

## Out of scope

- The home list's delete menu, confirmation and Undo toast are specified in
  [../bills/list-screen.md](../bills/list-screen.md).
- A deleted-receipt browser, permanent removal, photo cleanup and bulk deletion
  are not implemented.
- Receipt corrections are specified in [edit.md](edit.md); bill settlement is
  specified in [../bills/list.md](../bills/list.md).
