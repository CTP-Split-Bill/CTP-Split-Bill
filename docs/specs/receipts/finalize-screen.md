---
type: feature
---
# The organizer sees what each person owes and finalizes the receipt on purpose

## Why

Finalizing creates the bills, and a finalized receipt can't be edited. Before
that, the organizer sees what each person will owe, whether the receipt adds
up, and who has finished picking, then confirms on purpose rather than by a
stray tap.

## Where it lives

- apps/web/app/receipts/[id]/finalize/page.tsx: server page, the Finalize
  step. Runs the step guard, then renders the summary section inside a
  Suspense boundary. The section reads the receipt through the layout's
  cached `getReceipt`, and either `previewReceipt` (draft) or
  `listReceiptBills` (finalized) from packages/domain.
- apps/web/app/receipts/[id]/finalize/error.tsx: segment error boundary
  rendering `ErrorState`.
- apps/web/app/receipts/[id]/finalize/summary.ts: pure mapping from receipt
  detail plus preview allocations (or bills) to one display row per person
  (name, quiet line, items, breakdown), the readiness label, the mismatch
  sentences and the confirmation text. Unit-tested.
- apps/web/app/receipts/[id]/finalize/WhoOwes.tsx: the "Who owes what"
  cards and the Back to receipts link.
- packages/domain/src/allocate.ts (`personItems`): each person's items and
  their part of each, pure and unit-tested.
- apps/web/app/components/PersonAvatar.tsx: the avatar (components.md).
- apps/web/app/receipts/[id]/finalize/FinalizePanel.tsx: client leaf. The
  Finalize / Pause picking and finalize button, the confirmation
  `AlertDialog` and the request errors.
- apps/web/app/receipts/[id]/finalize/MarkPaid.tsx: client leaf. A
  finalized card's Mark paid back / Mark unpaid button, the unmark
  confirmation and the request error.
- packages/domain/src/totals.ts and receipt.ts: the `totals` object on
  receipt detail, as receipts/totals-check.md describes.
- packages/db/src/seed-examples.ts (`pnpm db:seed:examples`): one reviewed,
  mismatched draft receipt (Taco Stand) in the signed-in account, for the
  drill.
- apps/web/tests/finalize-screen.test.ts.
- Writes go through the existing routes: POST
  `/api/receipts/[id]/picking` with `{ open: false }`
  (receipts/guest-picks.md), POST `/api/receipts/[id]/finalize`
  (bills/split-allocation.md) and PATCH `/api/bills/[billId]`
  (bills/list.md), which revalidates this page and `/`.

## Behavior

### Loading and access

- The page is at `/receipts/[id]/finalize`, inside the receipt layout's step
  bar and mode chip (receipts/flow.md). Signed-out visitors go to `/login`
  and return here. A foreign, unknown or deleted receipt renders the
  not-found page.
- The step guard runs first: while Picks isn't done, the page redirects
  (307) to the furthest available step.
- While the summary loads it shows `LoadingState`. A failed read shows
  `ErrorState`; "Try again" refetches.

### Draft receipt that adds up

- The page heading is "Review and finalize".
- A section headed "Who owes what" lists one card per participant, in the
  preview's order (joinedAt, then id). The list is labelled by the heading.
  One layout serves every width; there is no table.
- A closed card shows the person's avatar (`PersonAvatar`, large), their
  name, a muted line under it, and what they owe on the right, the largest
  figure on the card. The avatar's color comes from the person's position
  in the Picks roster (the organizer first, then join order), not from the
  card order; it is decorative, since the name is the label.
- The organizer's card is named "You", as on the Picks screen, and its line
  starts "Your share". Every other card uses the participant's name.
- The muted line joins, with " · ":
  - "Your share" for the organizer, or else, on a draft that isn't EVEN, the
    guest's readiness from the receipt detail's participants: "Done picking"
    (`picksSubmittedAt` is set), "Still picking" (has a pick link, not done)
    or "No link" (neither);
  - then "Even split" under EVEN, or else the person's item count ("1 item",
    "3 items", "0 items").
- Cards start closed. A card opens (a native disclosure: its header is the
  control, at least 44px tall, announces expanded or collapsed, and opens
  with Enter or Space) to show:
  - the person's items in receipt line order, muted, each with the person's
    part: an item they shared reads "Edamame (1/3)". A person's parts add up
    exactly to their Subtotal (`personItems`): a shared item's parts are
    rounded per person, so they can differ by a cent between people;
  - then an inset breakdown: Subtotal, Discount (only when the receipt has
    one, as a negative amount), Tax, Tip, and a ruled Total equal to what
    they owe.
  A person with no items on a split that isn't EVEN has nothing to show: their
  card doesn't open and shows no chevron. Under EVEN, cards list no items and
  open to the breakdown.
- Under the cards, a Total line shows the sum of what everyone owes, which
  equals the receipt total, with "Matches the receipt" under the word Total.
- Amounts are formatted in the receipt's currency.
- When at least one guest is "Still picking", a muted line under the
  heading says so: "1 person is still picking" / "2 people are still
  picking". It is absent when nobody is still picking, under EVEN, and on a
  finalized receipt. Guests with "No link" aren't counted; they aren't
  picking.
- Readiness is information only. It never disables Finalize; the step guard
  already requires every item to be covered.
- The amounts are the ones finalization will bill: the page calls the same
  `previewReceipt` the preview route uses, with the revision it just read.

### Draft receipt that doesn't add up

- When `totals.reconciled` is false, the cards are replaced by a destructive
  `Alert` titled "This receipt doesn't add up", with one sentence per
  non-zero difference, signed so it says short or over:
  - "The items are $2.50 short of the subtotal." /
    "The items are $2.50 over the subtotal."
  - "Subtotal, tax and tip are $1.00 short of the total." / "… over the
    total."
    With a discount it reads "Subtotal, discount, tax and tip are …".
  - A null difference reads "Some item prices or amounts are missing."
- The alert ends with a **Fix the items** link to `/receipts/[id]/items`.
  Finalize is disabled, with "Fix the totals first" under it.
- When the preview is rejected for any other reason (400), the same alert
  shows the API's message instead of the difference sentences.

### Receipt changed while loading

- When the preview returns 409 (the receipt's revision moved on between the
  read and the preview, or it was finalized or started parsing in another
  tab), the page shows no cards and no error page. The Finalize panel shows
  the API's message with **Reload**, exactly as after a 409 from
  finalizing, and Finalize is disabled with "Reload to see the latest
  amounts" under it. Reload refreshes the page.

### Finalizing

- With picking paused, the button reads **Finalize**. With picking open it
  reads **Pause picking and finalize**: it sends `{ open: false }` to the
  picking route, refreshes the page (the chip changes to "Editing" and the
  amounts are read again, since guest picks may have changed them), then
  opens the confirmation. If the pause fails, the API's message shows above
  the button and no dialog opens.
- The confirmation is an `AlertDialog`: title "Finalize this receipt?", body
  "This creates N bills totaling $X. The receipt can't be edited after
  this." with **Cancel** and **Finalize**. N and $X come from the amounts on
  screen when it opens.
- Confirming sends the revision the page rendered. While it is in flight
  both dialog buttons are disabled and Escape does nothing.
- On success the page toasts "Receipt finalized" and navigates to `/`, where
  the new bills appear.
- On failure the dialog closes and the API's message shows above the
  button. A 409 (the receipt changed, or picking was reopened elsewhere)
  also offers **Reload**, which refreshes the page. A network failure says the server could not be
  reached. Nothing is retried automatically.

### Finalized receipt

- The receipt can't be edited: heading "Finalized", a line "Finalized on
  <date>", and the same cards built from the stored bills. No Finalize
  button, no mode chip (receipts/flow.md). Payment tracking is the only
  thing that can change.
- Each card's line starts with its payment state instead of readiness,
  joined with " · " to the item count as before:
  - "Paid the receipt" for the receipt's payer (the organizer's card reads
    "Your share · Paid the receipt");
  - "Nothing owed" for a bill of zero;
  - "Paid back" when the bill has `paidAt`;
  - "Not paid back yet" otherwise.
- Under the heading, a muted line uses the receipts list's wording
  (bills/list-screen.md): "2 still owe · $48.20 left" ("1 still owes"), or
  "Everyone has paid you back." when every bill is settled.
- A card whose bill is neither the payer's nor zero has a payment row below
  its header, outside the disclosure, so it shows whether the card is open
  or closed:
  - not paid back: a **Mark paid back** button;
  - paid back: "✓ Paid back <date>" (the bill's `paidAt`) and a **Mark
    unpaid** button.
  Buttons are at least 44px tall, and their accessible names include the
  person ("Mark Sam paid back", "Mark Sam unpaid").
- Mark paid back sends `PATCH /api/bills/[billId]` with `{ paid: true }`
  (bills/list.md) at once; there is nothing to lose.
- Mark unpaid first opens an `AlertDialog`: title "Mark Sam unpaid?", body
  "This clears the Nov 20, 2026 paid-back date. If Sam is marked paid back
  again, today's date is recorded instead." with **Cancel** and **Mark
  unpaid**. Confirming sends `{ paid: false }`. While it is in flight both
  dialog buttons are disabled and Escape does nothing; closing returns
  focus to the card's button.
- While a request is in flight that card's button is disabled and reads
  "Saving…". On success the page refreshes: the card, the still-owe line
  and the receipts list all read the stored bills again. On failure the
  dialog (if any) closes, the API's message shows under that card's
  button, and nothing changes. A network failure says the server could not
  be reached. Nothing is retried automatically.
- Under the cards a **Back to receipts** link goes to `/`, where the receipt
  sits under Waiting on payment or Settled (bills/list-screen.md).

### Layout

- Organizer page, desktop-first, meeting web.md's mobile standard: no
  horizontal scroll at 375px, 44px targets. The same cards serve every
  width; a long name truncates and the amount never wraps.
- Keyboard: Tab reaches each card that opens (Enter or Space toggles it,
  with a visible focus ring), Fix the items, the button, Reload and Back to
  receipts. The dialog
  traps focus, opens on Cancel, and Escape (when idle) closes it and
  returns focus to the button.

## Examples

| State / input | Behavior |
|---|---|
| EVEN, 10.00, three people, picking paused | Cards owe 3.34 / 3.33 / 3.33; lines "Your share · Even split", "Even split"; button "Finalize" |
| ITEMIZED, Maya done, Sam has a link and isn't done | Maya "Done picking · 1 item", Sam "Still picking · 2 items"; "1 person is still picking"; Finalize enabled |
| ITEMIZED, Jo has no link and no items, everyone else done | Jo "No link · 0 items", a card that doesn't open; no still-picking line |
| Open Alex's card: Salmon 16 alone, Edamame 10 shared three ways | "Salmon $16.00", "Edamame (1/3) $3.34", then Subtotal $19.34, Tax, Tip, Total |
| A guest edits the receipt between the read and the preview | No cards; "Receipt has changed; reload before previewing" with Reload; Finalize disabled |
| Picking open, press the button | Picking paused, chip reads "Editing", then the dialog opens |
| Pause returns an error | Message above the button; no dialog |
| Confirm with matching revision | Toast "Receipt finalized"; lands on `/` with the bills |
| Confirm after the receipt changed in another tab | Dialog closes; "Receipt has changed…" with Reload |
| Items 61.50, subtotal 64.00 | Alert "The items are $2.50 short of the subtotal."; Finalize disabled |
| One item with no price | Alert "Some item prices or amounts are missing." |
| Finalized receipt | "Finalized on …", cards with bill amounts and no readiness, no Finalize button, Back to receipts link |
| Finalized; you paid, Sam owes $20.00, Jo owes $28.20, neither paid back | "2 still owe · $48.20 left"; You "Your share · Paid the receipt" with no button; Sam "Not paid back yet · 2 items" with Mark paid back |
| Press Mark paid back on Sam | No dialog; button reads "Saving…", then Sam "Paid back · 2 items" with "✓ Paid back Nov 22, 2026" and Mark unpaid; line "1 still owes · $28.20 left" |
| Press Mark unpaid on Sam, then Cancel | Dialog "Mark Sam unpaid?" naming the Nov 22, 2026 date; Cancel leaves Sam paid back, focus on Mark unpaid |
| Press Mark unpaid on Sam, then confirm | Sam back to "Not paid back yet", line back to "2 still owe · $48.20 left" |
| Every bill settled | "Everyone has paid you back."; the receipt shows under Settled on `/` |
| A $0.00 bill | "Nothing owed · 0 items", no button |
| Mark paid back fails | API message under Sam's button; Sam still "Not paid back yet" |
| New receipt, open `/receipts/[id]/finalize` | 307 to scan or items |
| Foreign receipt id | Not-found page |

## Verify

- pnpm test (finalize-screen.test.ts) covers the row mapping and totals,
  each readiness label, the organizer's "You" and "Your share", every
  quiet line (draft, finalized, EVEN, zero items), each person's items in
  line order with shares marked, the still-picking line (shown singular and
  plural, hidden at zero, under EVEN and when finalized), avatar initials
  and colors by roster position (not card order), the 409 render (message
  and Reload, Finalize disabled), the Back to receipts link, every mismatch
  sentence (short, over, null), the confirmation text, and static renders
  of the cards (closed by default, labelled list, items then breakdown,
  Discount only with a discount, no disclosure for zero items), the
  mismatch alert and both button labels. allocate.test.ts covers
  `personItems`: parts add up to each person's Items amount, EVEN and
  empty lists, and the stale-data fallback.
  The `totals` fields are covered as receipts/totals-check.md's Verify says.
- pnpm typecheck and pnpm build pass.
- Drill (pnpm dev, signed in): finish a seeded receipt through Picks, open
  picking, press Pause picking and finalize, confirm; the bills list shows
  its bills. Then run `pnpm db:seed:examples` and open Taco Stand (a reviewed
  receipt whose items are 2.50 short of its subtotal, since the editor can't
  produce one); its Finalize step shows the alert and a disabled button.
- finalize-screen.test.ts also covers each finalized payment line (payer,
  zero, paid back, not paid back), the still-owe line (singular, plural,
  everyone paid), which cards get a payment row, both buttons' accessible
  names, the paid-back date, and the unmark confirmation text.
- Drill, continued: on that finalized receipt, mark every guest paid back;
  the line reads "Everyone has paid you back." and `/` lists the receipt
  under Settled. Mark one unpaid, cancel once, then confirm; it moves back
  to Waiting on payment.
- Phone pass at 375px from web.md, and a keyboard-only pass through opening
  and closing a card, then opening, cancelling and confirming the dialog,
  then Tab to a Mark paid back button and press it with Enter, and to Mark
  unpaid, opening and cancelling its dialog with Escape.

## Constraints & decisions

- The page calls `previewReceipt` in-process rather than fetching its own
  `/api/receipts/[id]/preview` route; it is the same function, so the
  amounts shown are still the amounts billed (bills/preview.md).
- No "finalize anyway": a receipt that doesn't add up can't be finalized
  (receipts/totals-check.md). Because content edits clear `reviewedAt` and
  review requires the totals to reconcile, the mismatch alert is a
  safeguard; the normal path never reaches it.
- Readiness doesn't block finalizing: the organizer may finalize for a guest
  who never pressed done, since coverage is already required.
- Cards, not a table, at every width: the content column is narrow even on
  desktop, and what each person owes is the figure to read; the breakdown is
  one tap away.
- Item parts are display only. They are derived on read from the items and
  each person's Items amount, never stored, so a person's card always adds
  up; bills stay the source of truth (bills/split-allocation.md).
- Pausing, not the confirmation, refreshes the amounts, so the dialog never
  names a total that guest picks have since changed.
- Payment is marked on the finalized cards instead of on a separate
  payments step: the cards already show each person and their bill, and an
  extra step would show the same list twice. The payment row sits outside
  `<summary>` because a button inside a disclosure's control isn't
  allowed.
- Marking paid back is instant but unmarking asks first: `paidAt` is the
  only record of when someone paid, and clearing it can't be undone, since
  marking again records the new time.
- Settlement comes from the bill projection's `settled` (bills/list.md), so
  this screen, the receipts list and the guest page agree on who still
  owes.

## Out of scope

- Editing from this screen, and reopening a finalized receipt.
- Live updates of readiness or amounts while picking is open; the page reads
  them on load and when pausing.
- Bill detail on its own page, partial payments, and a record of who
  marked a bill paid or when it was unmarked.
- Marking paid from the receipts list (bills/list-screen.md).
