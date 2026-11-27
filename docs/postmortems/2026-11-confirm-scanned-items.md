# Confirm items failed on every scanned receipt that looked complete

**Found:** production smoke test, 2026-11-27. **Spec:** `docs/specs/receipts/edit-screen.md`.

## Report

During the production smoke test, a receipt was scanned, its rows on Items
looked correct, and Confirm items showed "Every item needs a name, positive
quantity, unit price, and total price". Save was greyed out. The console
showed `PATCH /api/receipts/<id> 400` once per press.

Smallest reproduction: scan any receipt whose lines print only a name and a
price, change nothing on Items, press Confirm items.

## Expected vs actual

edit-screen.md: "Everything matches, press Confirm items → PUT items, PATCH
with reviewConfirmed; lands on People." It also said "A request that would
change nothing is not sent", which assumed the form and the stored receipt
hold the same thing.

Actual: only the PATCH was sent, and the server rejected it with 400.

## Root cause

There are two copies of the receipt, and they disagreed without anything
showing it:

1. **The stored items.** The scanner keeps only what is printed. For a line
   like `Taco 3.49` it saves the name and line total, and leaves quantity
   and unit price empty (parse.md: "missing unit price or quantity is not
   invented").
2. **The form.** When Items loads, an empty quantity is shown as `1`, and the
   unit price is not a field at all; it is derived from the line total when
   saving. So every row looks complete.

Save and Confirm decide whether to send the items by comparing the form with
the form built from the stored receipt. Both are built the same way, so a
scanned receipt with no edits compares equal: the app concluded "items
unchanged" and sent only `PATCH { reviewConfirmed: true }`.

The server's confirmation check (`validateReceiptInformation` in
`packages/domain/src/receipt.ts`) reads the **stored** items, finds empty
quantity and unit price, and returns 400. The only way through was to edit an
item so the app treated the items as changed and sent all of them with
quantity and unit price filled in.

Each piece was correct on its own: the parser not guessing, the form
filling in sensible display values, the server insisting on complete items.
The bug was in the seam: the "did anything change?" check compared two
derived views instead of what the server actually holds.

## The fix

When Items loads, the editor records whether any stored item has no quantity
or unit price (`itemsIncomplete`). Confirm sends the items (`PUT .../items`)
in that case even when nothing was edited, so the stored items are complete
before the PATCH confirms them. Save is unchanged: an incomplete draft is
allowed, and Save stays disabled until something changes.

## Why our defenses missed it

- The unit tests for which requests Save and Confirm send compared forms
  directly. None started from stored items with empty quantity or unit
  price, which is what every successful scan produces.
- The spec's manual drill started "on a receipt after a failed scan" and
  typed the items. Typed items are always saved complete, so the drill could
  never hit this path.
- The local OCR rarely produced a usable scan of real photos, so a scan
  followed by an unedited Confirm was rare in development.

## What changed beyond the fix

- `edit-screen.md` Behavior: Confirm sends unchanged items when stored items
  lack quantity or unit price.
- `edit-screen.md` Verify: the tests cover that case, and the drill adds
  "after a successful scan, change nothing and press Confirm items".
- `apps/web/tests/items-screen.test.ts`: loading flags incomplete stored items,
  and Confirm (not Save) sends the items for them. The Confirm test fails
  with the fix removed.

## Lesson

When a screen shows defaults for missing data, a "nothing changed" check
built on the screen's view can't see that the stored data is still missing.
Compare against what the server will validate, or make the server fill the
same defaults.
