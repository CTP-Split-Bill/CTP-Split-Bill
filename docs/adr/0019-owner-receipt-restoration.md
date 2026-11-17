# ADR-0019: Owners can restore their soft-deleted receipts

## Status

Accepted

## Context

The API normally excludes deleted receipts from every read and write. Soft
deletion preserves receipt data and fixed bills, but reversing it requires an
explicit operation authorized against a deleted parent row.

## Decision

- POST /api/receipts/[id]/restore is the narrow owner-scoped exception to the
  deleted-row filter. It validates session identity and receipt ID, and never
  exposes foreign receipts or permits deleted-row access through normal routes.
- Restore clears deletedAt without requiring or changing revision, in any
  receipt state. It preserves all content, financial snapshots and tokens.
- A conditional update and summary projection run in the same transaction.
  An already-live owned receipt returns 409; absent or foreign receipts return
  404. There is no server-side restoration expiry.
- Restore reuses the existing ReceiptSummary projection and returns 200.

## Alternatives considered

- Broaden normal receipt scopes: unnecessarily exposes deleted data to ordinary
  operations and makes authorization harder to audit.
- Recreate receipts or rotate links: breaks stable IDs, snapshots and access
  tokens even though their stored data is retained.
- Require an expected revision: treats a visibility change as a content edit
  and prevents a straightforward inverse of soft deletion.

## Consequences

- Normal read/write scopes remain unchanged; the exception is isolated in
  receipt-restoration.ts and documented in the API contract.
- Existing guest links become usable again subject to the receipt's unchanged
  picking/parsing/finalization guards. Restore performs no data repair or OCR restart.
- Restoration uses a separate module to reuse the summary's bill settlement
  projection without introducing a receipt-to-bills circular initialization.

## See also

- docs/specs/receipts/delete.md
- docs/specs/api.md
- docs/adr/0014-receipt-owned-domain.md
