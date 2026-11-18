---
type: feature
---
# The organizer watches picks arrive, then fixes who had what before finalizing

## Why

This is where the bill gets split. While guests pick from their links, the
organizer watches one board: who took each item, what nobody has claimed,
who is finished, and what each person owes so far. The organizer picks their
own items on the same board. When something is wrong, or someone has no
link, the organizer pauses picking, changes any item's people directly, and
saves without a guest's pick undoing the fix (ADR-0017).

## Where it lives

- apps/web/app/receipts/[id]/picks/page.tsx: the Picks step. Runs the step
  guard (receipts/flow.md) and renders the board. Replaces the placeholder.
- apps/web/app/receipts/[id]/picks/PicksBoard.tsx: client board; both modes,
  the people bar, item cards, the totals bar, Save, and the picking switch.
- apps/web/app/receipts/[id]/picks/picks-form.ts: pure; the board model built
  from receipt detail, the editing draft, coverage per item, readiness per
  person, running totals formatted for display, and the save plan (which
  requests, in which order).
- apps/web/app/lib/use-receipt-refresh.ts: the one client refresh hook
  (ADR-0018): polls `GET /api/receipts/[id]`, reports whether the last read
  failed, and hands over new detail only when the revision, the picking
  mode, or someone's link or done state changed.
- packages/domain/src/allocate.ts: pure, no database or logging import;
  exported as `@project/domain/allocate`. Builds the allocator input from
  receipt detail and runs the existing split arithmetic, so the board and
  the preview route (bills/preview.md) compute the same cents.
- apps/web/app/components/ui/toggle-group.tsx: shadcn's `ToggleGroup`
  primitive over the `radix-ui` package already installed
  (docs/specs/components.md); used for the people bar and Split.
- apps/web/app/globals.css: the six `--color-person-*` avatar fills
  (docs/specs/components.md, "Design tokens").
- apps/web/app/lib/link-guard.ts and
  apps/web/app/receipts/[id]/participants/leave-guard.ts: reused for unsaved
  edits.
- apps/web/tests/picks-screen.test.ts, apps/web/tests/use-receipt-refresh.test.ts
  and packages/domain/tests/allocate.test.ts.
- APIs used, unchanged: `GET /api/receipts/[id]` (receipts/detail.md),
  `PUT /api/receipts/[id]/picks` and `POST /api/receipts/[id]/picking`
  (receipts/guest-picks.md), `PUT .../assignments` and
  `PUT .../shared-allocations` (bills/allocations.md), and
  `PATCH /api/receipts/[id]` for the split mode (receipts/edit.md).

## Behavior

### Layout

- Heading "Who had what". The subtitle depends on the mode: "Picking is
  open. Picks show up here as people make them." or "Picking is paused. Pick
  a person, then tap what they had."
- One column at every width, top to bottom: the **people bar**, the item
  count line, the **item cards**, and a sticky **totals bar** at the bottom.
  The totals bar holds the selected person's total, the everyone-list it
  expands to, the mode's buttons (**Pause picking to edit**, or **Save** and
  **Open picking**) and any error, as on the Items screen
  (receipts/edit-screen.md).
- When the board matches the receipt (below), the bar adds **Continue to
  Finalize** as the primary button, a link to the Finalize step, and the
  mode's button becomes secondary (outline). It doesn't appear while the
  draft has unsaved changes or the organizer's own toggle is still saving,
  since Finalize reads what is saved.

### People bar

- One avatar per participant in roster order, the organizer first: a 48px
  circle with the person's initial, and their name under it ("You" for the
  organizer), so two people with the same initial are told apart. Each
  person keeps one fill color, chosen by roster position from six
  `--color-person-*` tokens; the initial is `--color-person-ink` in both
  themes. A guest who is done shows a small check badge on their avatar.
- Exactly one person is **selected**, shown with a ring around the avatar.
  It starts as the organizer (the first person when the receipt has no
  organizer row). The bar is a single-select `ToggleGroup`, so arrow keys
  move between people; it scrolls sideways when it doesn't fit, without
  scrolling the page.
- In EVEN mode the bar still selects whose total the totals bar shows.

### Items

- Under the bar, one line reads "3 items selected" (the selected person's
  count) with **Select all** or, when they have every item, **Deselect
  all**, shown only when the selected person can be changed (below).
- Items are listed in receipt order, one full-width card each: name and line
  total, and below them a small avatar (initial and fill) for each person
  who had it. Avatars carry the person's name as their accessible name.
- A card the selected person had has a 2px ink border and a check in its
  corner, so the state doesn't rest on color. When the selected person can
  be changed, the card is a toggle (`aria-pressed`, a 44px minimum height):
  tapping it, or Enter or Space, adds or removes the selected person.
  Otherwise the card is not interactive and only shows the state.
  While a save, pause or open is in flight, the cards and Select all stay
  in place, disabled.
- An item with one person belongs to them. An item with two or more people
  is shared equally, and its card says "Split 2 ways" (or 3, …).
- In ITEMIZED and SHARED_ITEMS modes, an item with nobody reads
  **Unclaimed** in a warning color, with text, not color alone. A count
  above the cards reads "2 items unclaimed · $14.00", or "Every item is
  claimed" with a check.
- In EVEN mode, cards have no avatars, no flags and no toggles, and there is
  no item count line; a note above the cards says "Splitting evenly:
  everyone pays the same share."

### Totals bar

- Collapsed, it shows one line for the selected person: "Your share
  $27.06", "Sam owes $11.60", or, before every item is claimed, "Sam's items
  so far $9.00". When the board matches the receipt, a second line reads
  "✓ Matches the receipt · Total $38.66".
- The line is a button (`aria-expanded`) ending in **Everyone** and a
  chevron (**Hide** when open); it expands the bar to the everyone-list: one
  row per participant in roster order, the organizer first as "You", each
  with their running amount and, for everyone but the organizer, their
  readiness from receipt detail (receipts/guest-picks.md):
  - **Done**: picksSubmittedAt is set.
  - **Still picking**: they have a link and haven't pressed done.
  - **No link**: they have no link, so the organizer assigns their items
    while editing. The row links to People to send one.
  A summary line reads "2 of 3 done". The organizer has no readiness.
- Expanded, the list scrolls inside the bar, which never takes more than
  half the viewport. It starts collapsed; the choice is kept while the page
  is open.

### Running totals

- Amounts are computed in integer cents on the client from the board's
  current state (the last read while picking is open, the draft while
  editing), through `@project/domain/allocate`, and reach the components as
  formatted strings ("$27.06").
- When every item is covered for the split mode (receipts/flow.md), each row
  shows what the person owes: their items, plus tax and tip in proportion,
  rounded exactly as finalization does (bills/split-allocation.md). These
  amounts equal the preview route's for the same state. EVEN is always
  covered.
- While any item is unclaimed, each row shows only "Items so far" (their
  items, shared items split to the cent the same way), and the panel says
  "Tax and tip are added once every item is claimed." (in the expanded
  list) Tax and tip shares
  depend on the full subtotal split, so a partial figure would change under
  everyone as items are claimed.
- The amounts across all rows plus the unclaimed amount always add up to the
  items total, and, once covered, the rows add up to the receipt total.
- The organizer's amount is labeled **Your share** rather than **Owes**,
  since they paid the restaurant; everyone else's reads **Owes**. Before
  every item is claimed, every amount reads **Items so far**.
- When every row has an amount and they add up to the receipt's total, the
  totals bar shows "✓ Matches the receipt · Total $38.66". This is the
  moment the screen exists for, and it is shown only when the sum equals the
  stored total exactly.

### Picking open

- The board is live. Only the organizer can be changed: with "You"
  selected, each card is the organizer's toggle and Select all / Deselect
  all apply to them. Selecting a guest shows that guest's items and total
  read-only, with "Pause picking to change Sam's items." under the count
  line. Toggling sends
  `PUT /api/receipts/[id]/picks` with the organizer's complete set of items,
  right away, with no Save. The avatar shows immediately; on failure it goes
  back and the error shows in the action bar. Toggles made while a save is
  in flight are sent after it, as one more PUT with the latest set.
- Without an organizer row (receipts created before it), nobody can be
  changed while picking is open.
- The board shows no last-updated time. After a failed read, "Couldn't
  refresh. Retrying…" shows under the heading until a read succeeds; it is
  not a live region, so screen readers aren't interrupted on every retry.
- **Pause picking to edit** sends `POST .../picking { open: false }`, then
  reads the receipt, and the board switches to editing built from that read.
  The pause waits behind any guest save already in progress (ADR-0017), so
  the read after it holds every pick that landed, and a save from the
  editing draft is never stale because of a guest.

### Refresh

- While picking is open and the tab is visible, `use-receipt-refresh` reads
  `GET /api/receipts/[id]` every 5 seconds, and once right away when the tab
  regains focus or becomes visible. A hidden tab doesn't poll.
- It replaces the board's state only when the revision, the picking mode,
  or any participant's hasPickLink or done state differs from what it holds
  (opening and pausing, issuing or revoking a link, and a guest claiming
  their name from the group link don't change the revision); otherwise
  nothing on the board changes. A changed revision
  also refreshes the layout, so the step bar's Next updates when the last
  item is claimed.
- At most one read is in flight; a tick while one is pending is skipped.
- While editing, and on a finalized receipt, it doesn't poll: nothing else
  can change picks then.
- A read that returns 401 sends the browser to `/login`, returning here; 404
  shows the not-found page; other failures keep the current state and retry
  on the next tick.
- If the receipt is found to be paused on a read (paused from another tab),
  the board switches to editing from that read.

### Editing

- The same layout, and anyone can be selected and changed: pick a person,
  then tap the cards they had. Select all adds them to every item;
  Deselect all removes them from every item.
- Every tap changes the draft only; the card avatars, the unclaimed count and
  the running totals update as the organizer goes.
- **Split**, above the cards, is a `ToggleGroup` with **Even** and **By item**. By item covers
  both ITEMIZED and SHARED_ITEMS: the screen saves SHARED_ITEMS when any item
  has two or more people, and ITEMIZED otherwise; a receipt already in
  SHARED_ITEMS stays there, since that mode also allows one person per item. Choosing **Even** keeps the
  item lists in the draft but hides them, and Save then saves EVEN, which
  clears every assignment (receipts/edit.md). When the receipt has
  assignments, the toggle says under it "Saving with Even clears who had
  what."
- **Save** is enabled when the draft differs from the last read. It sends,
  in order, each with the revision the previous one returned, comparing the
  draft with the receipt that request returned before choosing the next:
  1. `PATCH .../[id]` with `splitMode`, when the mode changes. Moving to
     SHARED_ITEMS goes first so shared allocations are accepted; moving to
     EVEN is the only request, since it clears the rest.
  2. `PUT .../shared-allocations` with every item that has two or more
     people (SHARED_ITEMS only), when those changed.
  3. `PUT .../assignments` with every item that has exactly one person, when
     those changed.
  A request that would change nothing is not sent. After Save, a "Saved"
  toast, the draft resets to the saved receipt, and the step bar refreshes.
- If a later request fails after an earlier one succeeded, the board keeps
  the draft and the new revision, shows the error, and Save again sends only
  what is still different.
- **409**: "This receipt changed somewhere else. Reload to see the latest."
  with **Reload**; the draft is kept until Reload. **400**: the API's
  message. **401**: to `/login`, returning here. Network failure: the draft
  is kept and the bar says so. Errors show in the action bar and take focus.
- **Open picking** sends `POST .../picking { open: true }`. With unsaved
  changes it reads **Save and open picking** and saves first; if the save
  fails, picking stays paused. After opening, the board is live and polling
  starts. A 409 (for example, the receipt was un-reviewed from another tab)
  shows the API's message.
- Leaving with unsaved changes asks first: the browser prompt on close or
  reload, and the Items screen's held-link toast (Save and continue /
  Discard) on in-app links (receipts/edit-screen.md).

### Finalized

- The board is read-only: card avatars, readiness and the amounts from the
  receipt's bills, with no toggles, no buttons and no polling.

## Examples

Seed receipt: Salmon roll 16.00, Miso soup 4.00, Edamame 10.00; subtotal
30.00, tax 2.66, tip 6.00, total 38.66; participants Demo User and Sam. The
seed has no organizer row, so the rows that use "You" assume a receipt
created through the app, where the organizer is Demo User.

| State / input | Behavior |
|---|---|
| Picking open; Sam picks Miso soup from his link | Within 5 s, Miso soup shows Sam's avatar and the unclaimed count drops |
| Sam presses done | Within 5 s, Sam's avatar has a check badge and his row reads Done; "1 of 1 done" |
| You selected; tap Salmon roll and Edamame; Sam has Miso soup and Edamame | "2 items selected"; Edamame "Split 2 ways"; bar reads "Your share $27.06" and "✓ Matches the receipt · Total $38.66"; expanded, Sam owes $11.60, matching the preview route; Continue to Finalize is the primary button |
| Picking open, select Sam | Miso soup and Edamame cards marked, not tappable; "Pause picking to change Sam's items."; bar reads "Sam owes $11.60" |
| Salmon roll unclaimed, the rest as above | Bar reads "Your items so far $5.00"; Sam $9.00 when expanded; "1 item unclaimed · $16.00"; no tax or tip shown |
| Tab hidden for a minute | No reads while hidden; one read on return |
| Two reads return the same revision | Nothing on the board changes |
| Sam claims his name from the group link | Within 5 s, Sam's row reads Still picking instead of No link |
| Pause picking to edit, select You, tap Salmon roll, Save | PUT assignments with the read's revision; 200, no 409 |
| Editing, select Sam, tap Salmon roll (receipt ITEMIZED, You had it) | Save sends PATCH SHARED_ITEMS, then PUT shared-allocations, then PUT assignments |
| Editing, choose Even, Save | One PATCH to EVEN; assignments cleared; everyone's share shown |
| Editing, unsaved change, press Open picking | Button reads Save and open picking; saves, then opens |
| Save from a tab with an older revision | Conflict message with Reload; draft kept |
| A guest with no link | Row reads No link with a link to People |
| Editing, select Sam, Select all | Sam added to every item; "3 items selected"; button reads Deselect all |
| Receipt has no organizer row | First person selected; no card is tappable while picking is open; everything else works |
| Finalized receipt | Read-only board with bill amounts; no polling |
| Phone at 375px, 8 people | People bar scrolls sideways; totals bar stays at the bottom; no horizontal page scroll |

## Verify

- pnpm test: picks-screen.test.ts covers the board model (card avatars, Split N
  ways, unclaimed flags per split mode, readiness), the running totals
  (covered amounts equal the preview route's for each split mode, the items
  so far rule), the save plan for each mode change and assignment change
  (requests, order, and nothing sent when nothing changed), the organizer's
  toggle set, and static renders of picking open, editing, EVEN and
  finalized, the selected person's card state and Select all / Deselect
  all in the draft. Against PGlite, it saves generated drafts through the real
  routes until the plan is empty, and checks the board's amounts equal
  previewReceipt's, including EVEN. use-receipt-refresh.test.ts covers the
  5 s interval, no reads while hidden, a read on focus, one read in flight
  at most, handing over state only on a revision, mode, link or done change, stopping,
  and the 401, 404 and failure paths. allocate.test.ts covers owed amounts,
  items so far, EVEN, a subtotal mismatch, and that rows plus unclaimed
  always equal the items.
- pnpm typecheck and pnpm build pass.
- Two-browser drill (pnpm dev, signed in): on the seed receipt, confirm the
  items, send Sam a link from People, and open picking. In a private window,
  open Sam's link with the pick API (receipts/guest-picks.md; the guest page
  isn't built yet) and pick Miso soup; it shows on the board within 5 s.
  Press done; Sam reads Done within 5 s.
- Drill: pause; select You and tap Salmon roll and Edamame; select Sam and
  tap Miso soup and Edamame; Save (no 409), then Open picking. The board shows Demo User
  $27.06 and Sam $11.60, the same as `POST /api/receipts/[id]/preview`.
- Phone pass at 375px from web.md, in light and dark, and a keyboard-only
  pass: arrow keys move through the people bar, Tab reaches each card and
  Space toggles it, and Select all, the totals chevron, Split, Save and
  Open picking are reachable.

## Constraints & decisions

- The board computes amounts itself rather than calling preview: preview
  rejects incomplete receipts (400) and needs a stored revision, and the
  board shows unsaved drafts and partial picks. Sharing the allocator
  through `@project/domain/allocate` keeps the two from disagreeing; it has
  no logging or database import so it can ship to the browser.
- Tax and tip appear only once every item is covered, so no figure on the
  board changes for a reason other than the person's own items.
- In editing, the organizer's own items go through the draft and the
  assignment PUTs, not the picks route: a picks PUT advances the revision
  and would make the draft's Save stale.
- While picking is open, the organizer's toggle saves at once, like a
  guest's tap, because there is no draft to save and guests see the same
  immediacy.
- Person first, not item first: the organizer usually knows what one
  person had, so selecting a person and tapping their cards takes one tap
  per item, with no list to open and close. A shared item is a card two
  people have tapped. The totals bar is part of the sticky action bar, not a
  `Drawer`, so the screen adds no dependency (no `vaul`).
- One column at every width: the board is a phone-first task, and the
  totals bar keeps the amounts in view on desktop as well.
- The UI offers Even and By item, not three modes: whether an item is
  shared follows from how many people it has, and receipts/edit.md already
  defines what each switch clears.
- Polling, not push (ADR-0018). All refreshing goes through
  `use-receipt-refresh`, so push can replace it without touching the board.
- The switch is manual and lives on this screen (ADR-0017); the screen
  never pauses or opens picking on its own.
- Readiness doesn't gate anything; finalize's coverage rule is the only
  gate (receipts/guest-picks.md).

## Out of scope

- Weighted or percentage splits, and splitting one quantity line between
  owners (bills/allocations.md).
- Partial payments and recording who paid (the Finalize step, not yet
  specified).
- Sending, rotating or revoking links, and the group link
  (receipts/participants-screen.md); a share card or QR code on this
  screen.
- Adding people from this screen; that is the People step.
- The payer; chosen on Finalize.
- The guest page (receipts/guest-picks.md).
