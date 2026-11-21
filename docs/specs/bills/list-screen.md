---
type: feature
---
# The organizer sees their receipts grouped by what each one needs next

## Why

The organizer opens the home screen with two questions: which receipt do I
still have to finish, and who still owes me? Each row answers one of them
without opening the receipt, and the list is grouped so the receipts that
need action come first. The organizer can also clear out receipts they no
longer want (a test upload, a duplicate, an old bill) without losing one to a
mis-tap.

## Where it lives

- packages/domain/src/receipt-summaries.ts: owner-scoped receipt summary
  query and projection, shared with restore (receipts/delete.md).
- packages/domain/src/steps.ts: `receiptSteps` and `landingStep`, the step
  rules the summary's `nextStep` reuses.
- apps/web/app/api/receipts/summary/route.ts: summary collection GET.
- apps/web/app/page.tsx: home screen fetch and the signed-out landing.
- apps/web/app/lib/format.ts: summary to display-ready row props, grouping
  into sections, status and delete-dialog copy.
- apps/web/app/BillList.tsx: client list leaf that owns the sections, the
  Settled toggle, each row's delete button, the delete confirmation and the Undo
  toast.
- apps/web/app/components/BillRow.tsx: one receipt row (presentational).
- packages/db/src/seed-examples.ts (`pnpm db:seed:examples`): example
  receipts for a signed-in account, for local review.
- apps/web/tests/receipt-summaries-route.test.ts,
  apps/web/tests/components.test.ts, apps/web/tests/bill-list.test.ts and
  apps/web/tests/home-page.test.ts.

## Behavior

### Summary

- `GET /api/receipts/summary` returns receipts owned by the signed-in user,
  including drafts and finalized receipts, ordered newest first by
  `createdAt`. Deleted receipts are excluded. The response does not change the
  existing `GET /api/receipts` contract.
- Each entry contains only these fields:

  | Field | Value |
  |---|---|
  | `id`, `status` | as stored |
  | `merchantName`, `title` | nullable strings |
  | `total` | nullable decimal string |
  | `createdAt` | ISO string |
  | `payerName` | display name of the payer participant, or null |
  | `participantCount` | every participant, including those without a bill |
  | `settled` | null for drafts and for finalized receipts with no bills; otherwise true exactly when `unpaidCount` is 0 |
  | `unpaidCount` | null exactly when `settled` is null; otherwise the number of bills not settled |
  | `outstanding` | null exactly when `settled` is null; otherwise the decimal-string sum of `amountOwed` over the unsettled bills (`"0.00"` when none) |
  | `nextStep` | for a draft, the step `/receipts/[id]` lands on (`landingStep`): `scan`, `items`, `participants`, `picks` or `finalize`; null when finalized |
  | `picks` | for a draft where picking is open or anyone has said they're done: `{ open, done, total }`; otherwise null |

- Settlement uses the shared rule used by `presentBill`: manually paid
  (`paidAt`), the receipt payer, or zero `amountOwed`. The rule is implemented
  once in a shared domain helper and used by bill presentation, this summary
  and restore.
- In `picks`, `open` is whether picking is open (`picksOpenedAt` set),
  `total` counts participants other than the organizer, and `done` counts
  those with `picksSubmittedAt` set.
- `nextStep` comes from the same `receiptSteps` rules the step bar and step
  guard use (receipts/flow.md), so a row never names a step the receipt
  wouldn't open on.

### Screen

- The page shows a "Your bills" heading and a primary New receipt action,
  then a summary line, then up to three sections, each an `h2` over a list.
  A section with no receipts is not shown. Within a section, receipts stay
  newest first.
- The summary line answers the screen's two questions in one sentence:
  "You're owed $48.20 from 3 people · 2 receipts to finish", with the amount
  emphasised. The amount is the sum of `outstanding` over Waiting on payment
  and the people are the sum of their `unpaidCount`. Either half is left out
  when it is zero ("2 receipts to finish", "You're owed $9.00 from 1
  person"); with neither it reads "Everyone has paid you back." It counts
  only the rows shown, so it updates when a row is deleted or restored.
- Each section heading shows its row count beside the title. Waiting on
  payment also shows its total outstanding on the right ("$48.20 left").

  | Section | Receipts in it |
  |---|---|
  | In progress | Drafts |
  | Waiting on payment | Finalized with `unpaidCount` > 0 |
  | Settled | Finalized with `unpaidCount` 0, or with no bills |

- Settled starts collapsed: its heading is a toggle button "Settled n"
  with `aria-expanded`. When it is the only section, it has a plain heading
  and is always open. The choice is not remembered across visits.
- Each row is one link to `/receipts/[id]`, which redirects to the receipt's
  next step (receipts/flow.md); a finalized receipt opens on Finalize. A row
  shows, in the language of the screen:
  - first line: the name (merchant, then title, then "Untitled receipt";
    truncated to one line) and the total, right-aligned with tabular figures
    ("—" when there is none yet; it never wraps);
  - second line: the status, then the date ("Nov 16, 2026") after a "·";
  - for a draft, a five-segment step bar, filled up to `nextStep` (Scan
    through Finalize), so progress reads at a glance. It is decorative
    (`aria-hidden`); the status says the same thing in words.
- The status is coloured, with a matching dot, by whose move it is. The words
  carry the meaning; colour only speeds up scanning.

  | Whose move | Receipts | Colour |
  |---|---|---|
  | The organizer's | Drafts at a step, picking not open | brand (teal) |
  | Someone else's | Drafts with picking open; Waiting on payment | warning (amber) |
  | Nobody's | Settled | muted |
- The status depends on the receipt:

  | Receipt | Status |
  |---|---|
  | Draft, picking open | Picks open · 2 of 3 done |
  | Draft, `nextStep` scan | Next: check the scan |
  | Draft, `nextStep` items | Next: check items |
  | Draft, `nextStep` participants | Next: add people |
  | Draft, `nextStep` picks, nobody done | Next: assign items |
  | Draft, `nextStep` picks, some done | Next: assign items · 2 of 3 done |
  | Draft, `nextStep` finalize | Next: finalize |
  | Waiting on payment | 2 still owe · $48.20 left ("1 still owes") |
  | Settled, all bills settled | All paid |
  | Settled, no bills | Finalized |

- A draft with no merchant, title or total shows its "Untitled receipt" name
  in muted ink, so an abandoned upload reads differently from a real one.
- The row link's accessible name is short: "<name>, <total>, <status>", with
  the total left out when there is none and the status's "·" read as a comma.
- Rows carry no delete control at rest. An **Edit** button beside the
  summary line turns on Edit mode, and becomes **Done** (primary) while it is
  on. In Edit mode each row shows a danger-coloured text button **Delete**,
  labelled "Delete <name>", at the end of the row, beside the link, not
  inside it, so Tab reaches the row link and its Delete as separate stops.
  Row links still open receipts in Edit mode. Done, or leaving the page,
  turns Edit mode off; it is not remembered.
- **Delete** opens an `AlertDialog` titled "Delete this receipt?" with
  **Cancel** and a destructive **Delete** action with a trash icon. The
  dialog shows the receipt itself, so the organizer confirms the right one:
  its name and total, then the date and how many people it covers ("3
  people", "1 person"). For a finalized receipt with `unpaidCount` > 0 an
  amber warning follows: "<n> people still owe $48.20. Their links will stop
  working." ("1 person still owes" for one). Every dialog ends "You can undo
  this right after." Screen readers get the same content as the dialog's
  description. Cancel or Escape closes it and returns focus to the row's
  Delete button.
- Confirming sends `DELETE /api/receipts/[id]` (receipts/delete.md). The row
  leaves the list as soon as the user confirms, and a section left empty
  disappears; Edit mode stays on and focus moves to the **Done** button (or to
  the "Your bills" heading when the list is now empty). On 204 a toast reads
  "Deleted <name>" with an **Undo** action. If the list is now empty, the
  empty state shows.
- **Undo** sends `POST /api/receipts/[id]/restore` and the row returns in its
  original section and place. A 409 (already restored) also returns the row.
- If delete fails, the row returns and an error toast reads "Couldn't delete
  <name>. Try again." A 404 means the receipt is already gone: the row stays
  removed with no error. If restore fails, an error toast reads "Couldn't
  restore <name>." and the row stays removed.
- After delete or restore the page refreshes from the server, so a reload
  shows the same list.
- The page uses the shared shell's loading, empty and error states:
  `LoadingState` while the list loads, `EmptyState` with the New receipt
  action when there are no receipts, and the root error boundary
  (`app/error.tsx`) when the read fails.
- The endpoint returns raw decimal and ISO date strings. The page formats
  money and dates before they reach `BillRow`.
- `/` stays public (auth/sign-in.md). A signed-out visitor sees a short
  landing with a Sign in link to `/login`; the summary query never runs for
  them.
- Missing session identity returns 401. An unknown current user returns 401.
  Unexpected failures return the standard generic 500. Errors use
  `{ error: { code, message } }`; raw errors are not returned.

## Examples

| Receipt | Section | Row |
|---|---|---|
| Draft, items not reviewed yet | In progress | Drill Sushi · $38.66 / *teal* Next: check items · Nov 16, 2026 / step bar 1 of 5 |
| Draft, picking open, 2 of 3 guests done | In progress | Chili's · $1,080.00 / *amber* Picks open · 2 of 3 done · Nov 14, 2026 / step bar 3 of 5 |
| Upload with nothing read yet | In progress | *Untitled receipt* · — / *teal* Next: check the scan · Nov 12, 2026 / empty step bar |
| Finalized, 2 bills unpaid totalling $48.20 | Waiting on payment | Taco Night · $96.40 / *amber* 2 still owe · $48.20 left · Nov 10, 2026 |
| Finalized, every bill settled | Settled (collapsed) | Corner Cafe · $16.00 / *muted* All paid · Nov 2, 2026 |
| Finalized, no bills | Settled (collapsed) | Lunch · $12.00 / *muted* Finalized · Oct 30, 2026 |
| Only settled receipts | Settled, open with a plain heading | — |
| No owned, non-deleted receipts | — | Empty state with New receipt action |
| Signed-out visitor opens `/` | — | Landing with a Sign in link; no error |

| Delete action | Result |
|---|---|
| Delete a draft, confirm | Row removed; "Deleted <name>" toast with Undo |
| Delete the last row in a section | Section disappears; Undo brings both back |
| Undo from the toast | Row back in place; its links work again |
| Delete, toast closes, reload | Receipt stays gone |
| Delete the last receipt | Empty state with New receipt action |
| Delete fails (network or 500) | Row returns; "Couldn't delete <name>. Try again." |
| Delete returns 404 (deleted elsewhere) | Row stays removed; no error |
| Edit, then Done | Delete buttons appear on every row, then go away |
| Cancel or Escape in the dialog | Nothing changes; focus back on the row's Delete |

## Verify

- Route tests cover owner scoping, deleted receipts, drafts, empty bill
  lists, participant counts, payer names, newest-first ordering, nullable
  metadata, decimal/ISO serialization, authentication and generic errors;
  `settled`, `unpaidCount` and `outstanding` for drafts, finalized receipts
  without bills, all-settled and partly-settled receipts (each settlement
  condition); `nextStep` for a draft at each step and null when finalized;
  `picks` null before picking, then open/done/total with the organizer
  excluded; and that restore returns the same fields.
- Format tests cover section grouping, newest-first within a section, every
  status row in the table above, whose-move colour for each kind of receipt,
  the step bar's fill, the summary line's every form and exact money sums, the muted untitled draft, the accessible
  name with and without a total, and the delete dialog's people count and warning for a draft, one participant,
  a finalized receipt with no one owing, one person owing and several owing.
- Component tests render `BillRow` from literal props: name, total, date and
  status appear untouched, the status takes each state's colour, and the step
  bar fills to `stepsDone` and is absent when it is null.
- bill-list.test.ts renders the Edit toggle with no Delete buttons at rest,
  and in Edit mode a Delete button outside each row link with its accessible
  name, hides empty sections, shows each heading's count and the
  Waiting on payment total, renders Settled collapsed with
  `aria-expanded="false"` (open, with a plain heading, when it is the only
  section) and shows
  the empty state when there are no receipts.
- Run `pnpm typecheck` and `pnpm build`.
- Every section can be seen locally: `pnpm db:seed:examples` (dev running,
  signed in once) adds Taco Night (waiting on payment, 2 still owe $48.20),
  Brunch Club (settled), Coffee Run (finalized, no bills) and Taco Stand (a
  draft, In progress) to the most
  recently created account, or to the account whose email is passed.
  Rerunning restores them.
- Drill (`pnpm dev`, signed in): delete a receipt, then Undo; it returns to
  its section and its pick link still opens. Delete it again without Undo and
  reload; it stays gone.
- Keyboard-only: Tab reaches Edit, then in Edit mode each row link and its
  Delete separately, and the Settled toggle; Enter on Delete opens the
  dialog, which keeps focus inside, Escape returns focus to that Delete, and
  the toast's Undo is reachable.
- Open `/` signed out: the landing shows with a Sign in link, not an error.
- Complete the phone pass in web.md at 375px for the heading, sections,
  rows (a long name truncates, the total doesn't wrap), Edit mode, dialog, toast
  and New receipt action.

## Constraints & decisions

- The summary is a home-screen projection; it does not replace or widen the
  existing receipt history or detail APIs. It is read-only and does not
  recalculate bill amounts or mutate receipt state.
- `settled`, `unpaidCount` and `outstanding` are nullable because a draft or a
  finalized receipt without bills has no settlement state; treating an empty
  bill list as settled would incorrectly show it as paid. They come from one
  pass over the bills, so they can't disagree.
- `nextStep` reuses the step rules rather than restating them, so the row and
  the receipt's landing page always agree. The cost is that the summary query
  also reads each draft's items and their shared allocations.
- Rows are grouped by the organizer's next action rather than listed by date
  alone, because the screen's job is to show what needs doing; Settled
  collapses because it is the section that grows without bound.
- The section is the status, so rows carry no status badge. Colour encodes
  whose move it is rather than the section, so a draft waiting on guests
  reads differently from one waiting on the organizer. Danger red stays
  reserved for errors: money owed to the organizer is a wait, not a failure.
- The summary line is a sentence, not a row of stat tiles, because it answers
  one question and the list below is the detail.
- Formatting remains in the screen so locale and presentation choices do not
  become part of the API contract.
- The list is a client leaf next to the page (`app/BillList.tsx`), not a
  domain component, because it fetches and owns state; `BillRow` stays a
  presentational layer-2 component (components.md).
- `unpaidCount` and `outstanding` are summary fields rather than a fetch when
  the dialog opens, so the dialog is ready immediately and needs no loading
  state.
- Delete lives behind one Edit toggle rather than a control on every row:
  deleting is rare, and a per-row icon or menu repeats a destructive action
  down the list and competes with the status. A text "Delete" in Edit mode
  says what it does without an icon to decode.
- Delete hides the row before the server answers because the toast is the
  undo path; waiting would make the row linger after the user confirmed.
- The toast is the only restore path. There is no deleted-receipts screen.

## Out of scope

- Filtering, search, pagination, bulk delete, a deleted-receipts screen,
  restore after the toast closes, and deleting from inside a receipt.
- Person avatars on rows.
- Marking bills paid from the list; bill settlement mutations are specified
  in [bill reads](list.md).
- Receipt creation and editing are specified in the receipt upload and edit
  specs.
