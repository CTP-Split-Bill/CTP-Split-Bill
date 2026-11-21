---
type: feature
---
# A guest with a pick link chooses the items they had, then sees the split

## Why

At the table, the organizer should not have to ask who ate what. Each guest
opens their own link, taps the items they had, and says when they are done,
so the organizer only reviews and fixes the gaps before finalizing. After the
receipt is finalized, the same link shows what everyone owes, so guests know
what to pay without an account or a second link.

## Where it lives

- packages/db/prisma/schema.prisma: Participant.pickTokenHash,
  Participant.picksSubmittedAt, Receipt.picksOpenedAt and the nullable unique
  Receipt.groupTokenHash, added by
  append-only migrations.
- packages/domain/src/group-links.ts: owner group-link issue/revoke, public
  group projection, claim validation and the claim transaction.
- apps/web/app/api/receipts/[id]/group-link/route.ts: owner POST and DELETE.
- apps/web/app/api/groups/[token]/route.ts and claim/route.ts: anonymous GET
  and POST claim, with no derived user identity.
- apps/web/app/lib/page-access.ts: public `/g/` and `/p/` page-path exceptions.
- apps/web/tests/group-links-route.test.ts: group API integration coverage.
- apps/db-server/drills/group-links.ts and apps/web/drills/group-links.ts:
  isolated PostgreSQL contention and live HTTP verification.
- packages/domain/src/picks.ts: token issue/rotate/revoke, token lookup,
  ReplacePicks validation, reconcileHolderPicks (shared by guest and
  organizer picks), the pick transactions and the picking switch.
- packages/domain/src/receipt-access.ts: lockReceiptForGuest, the guest
  sibling of lockEditableReceipt. Same DRAFT and not-PARSING guard and the
  same revision increment (optional, for done), but no owner and no expected
  revision, and it requires picking to be open where lockEditableReceipt
  requires it closed.
- packages/domain/src/receipt.ts and receipt-parsing.ts: item replacement and
  parse completion clear every participant's picksSubmittedAt.
- apps/web/app/api/receipts/[id]/participants/[participantId]/pick-link/route.ts:
  POST issues or rotates, DELETE revokes (owner-scoped).
- apps/web/app/api/picks/[token]/route.ts: GET projection (pick or split),
  PUT picks.
- apps/web/app/api/picks/[token]/done/route.ts: POST done.
- apps/web/app/api/receipts/[id]/picking/route.ts: POST open or pause
  (owner-scoped).
- apps/web/app/api/receipts/[id]/picks/route.ts: PUT the organizer's own
  picks (owner-scoped).
- apps/web/app/p/[token]/: the server guest page, draft picker, request
  controller, loading/error boundaries and server-only finalized summary.
- apps/web/tests/guest-pick-page.test.ts and guest-pick-session.test.ts:
  page projections, markup, request ordering and failure recovery.
- apps/web/tests/picks-route.test.ts and picking-route.test.ts.

## Behavior

- Pick links follow ADR-0015. Token routes derive no user identity; the token
  hash lookup is the only scope. Unknown, revoked and rotated tokens, removed
  participants, deleted receipts and parsing receipts return 404 `NOT_FOUND`,
  indistinguishable from each other. Tokens have no expiry.
- Owner routes use the normal ritual: identity, owner check, 404 for foreign or
  unknown receipts and participants. Both work on a receipt in any state, so
  the owner can still rotate or revoke after finalize. POST returns
  `{ url }` once, built from the request's origin as `<origin>/p/<token>`; the
  raw token is never readable again. DELETE clears only the hash and is
  idempotent; picks and picksSubmittedAt survive rotation and revocation
  (ADR-0017). Neither
  changes the receipt revision, because receipt content is unchanged.
- The organizer's own row (receipts/participants.md) never gets a link: POST
  for it returns 400 `INVALID_INPUT` and writes nothing. DELETE for it is the
  usual idempotent no-op, since it has no hash.
- Removing a participant (receipts/participants.md) deletes their row, and
  their hash with it, so their link 404s with no separate revoke.
- The server sends no messages. The owner's screen turns the returned url into
  `sms:` and `mailto:` links pre-filled with the participant's stored phone or
  email (receipts/participants.md), plus a copy action. Sending again later
  means rotating, which invalidates the earlier link.
- GET returns the receipt revision, merchant, purchase date, currency,
  `pickingOpen`, items ordered by lineNumber, every participant's id and
  display name, the token holder's participant id, each item's pickers, and
  the holder's done state.
  Phones, emails, bills, owner id and image data are never returned while the
  receipt is a draft.
- On a FINALIZED receipt, GET returns the same receipt and item fields plus,
  for every participant, display name, discount share, amount owed and settled state, and the
  payer's display name. Amounts come from the receipt's bills (bills/list.md)
  in the same fixed decimal strings. Phones, emails, owner id and image data
  are still never returned.
- PUT picks and POST done on a FINALIZED receipt return 409 `CONFLICT` and
  write nothing.
- PUT takes `{ itemIds }`: the complete set of items the holder had, at most
  500 unique ids, each belonging to this receipt (404 otherwise). It takes no
  expectedRevision: a guest writes only their own rows, so guests picking at
  the same moment are serialized on the receipt row lock instead of rejecting
  each other. Under that lock it reconciles the holder's rows only:
  - An item picked by the holder alone becomes the holder's individual
    assignment.
  - An item picked by two or more participants becomes equal shared
    allocations among them, and the receipt moves to SHARED_ITEMS if it was
    ITEMIZED. EVEN receipts are moved to ITEMIZED on the first pick.
  - Unpicking removes the holder from the item; a shared item left with one
    picker becomes that picker's individual assignment.
  - Other participants' picks are never removed by a guest write.
  The revision advances, so the organizer's picks screen sees the change on
  its next read; reviewedAt is kept because receipt content is unchanged
  (same rule as bills/allocations.md).
- POST done sets picksSubmittedAt to now; it is idempotent. It needs picking
  open, like PUT, and runs under the same receipt row lock. The press that
  sets it advances the revision, so the organizer's picks screen sees it on
  its next read; a repeat press changes nothing. Picking is open, so no owner
  draft can go stale. A later PUT by the same holder clears it until they
  press done again.
- The owner replacing items (receipts/items.md) and a successful parse
  (receipts/parse.md) each clear every participant's picksSubmittedAt, in the
  same transaction, since their picks were cleared with the old items.
- Receipt detail adds `hasPickLink` and `picksSubmittedAt` per participant
  for the owner's review screen. Readiness is derived there: a participant is
  ready when submitted, or when they have no link (the owner picks for them).
- Finalization is not gated on readiness. Its existing completeness rules in
  bills/split-allocation.md still apply.

### Group links and claims

- The owner issues or rotates a group link with
  `POST /api/receipts/[id]/group-link`. Each successful POST returns 200
  `{ url: "<origin>/g/<token>" }` with `Cache-Control: no-store`. The token is
  32 CSPRNG bytes encoded as 43 base64url characters; only its SHA-256 hex
  hash is stored in `receipts.group_token_hash`. Existing receipts have null.
  The raw token is returned once and never stored or logged.
- Owner POST and DELETE require identity and ownership, exclude deleted
  receipts, and work in every receipt state, including FINALIZED and PARSING.
  Foreign, unknown or deleted receipts return 404. DELETE returns empty 204,
  clears the group hash, and is idempotent. Rotation and revocation invalidate
  the old group token without changing personal links, picks, done state,
  picking mode or receipt revision.
- `GET /api/groups/[token]` and `POST /api/groups/[token]/claim` are anonymous;
  the group hash is their only access scope. Malformed tokens (anything other
  than 43 base64url characters), unknown, rotated or revoked tokens, deleted
  receipts and PARSING receipts all return 404 `NOT_FOUND`, "Link not found".
  Tokens have no expiry. GET makes no database changes.
- A DRAFT group GET returns exactly `status`, `merchantName`, `purchasedAt`,
  `pickingOpen` and `participants`. Each participant has exactly `id`,
  `displayName` and `claimed`; claimed is `pickTokenHash !== null`. The
  organizerParticipantId row is omitted from this claim roster. Older
  receipts with no organizerParticipantId include their full roster.
  Participants are ordered by joinedAt then id. Nullable merchant/date values
  remain null and dates serialize as ISO strings.
- A FINALIZED group GET returns exactly `status`, `revision`, `merchantName`,
  `purchasedAt`, `currency`, `items`, `paidBy` and `participants`. Items have
  exactly `id`, `lineNumber`, `name`, `quantity`, `totalPrice` and `pickedBy`,
  with the same serialization and ordering as a personal-link GET.
  Participants include everyone, including the organizer, with exactly `id`,
  `displayName`, `discountShare`, `amountOwed` and `settled`. Amounts and settlement follow the
  existing personal-link projection and bills/list.md; `paidBy` is the payer's
  display name or null. There is no holder `participantId` or
  `picksSubmittedAt`, and no claim roster in the finalized response.
- Claim accepts JSON `{ participantId: string }`, validated by a shared
  domain Zod schema: trimmed, nonempty, at most 200 characters. Invalid JSON
  or input returns 400 in the normal error envelope. A successful claim
  returns 200 `{ url: "<origin>/p/<personal-token>" }` once.
- Claim first resolves the token, then takes the receipt row lock in a
  transaction without advancing revision or requiring picking to be open.
  Under the lock it rechecks the token, deletion and parsing state, then
  rejects FINALIZED with 409 `CONFLICT`, "Receipt is finalized". A participant
  outside the receipt or missing from it returns 404. The organizer row
  returns 400 `INVALID_INPUT`, "You can't send yourself a pick link".
- If the participant already holds a personal token, claim returns 409
  `CONFLICT`, "Already claimed". Otherwise a conditional update scoped by
  participant id, receipt id and null pickTokenHash stores a new personal
  token hash; exactly one row must change. Two claims for one participant
  produce one success and one 409. Claim preserves picks and done state,
  changes no receipt revision or picking mode, and works in Editing and
  Picking open. The personal token uses the existing ADR-0015 mechanism.
- Group rotation/revocation uses the same receipt row lock. If it wins the
  lock before a waiting claim, the old-token claim returns 404 and issues no
  personal token. Participant replacement, parsing, deletion and finalization
  coordinate through that receipt row, so claim cannot issue an orphan token.
- Existing personal-link issue makes a name claimed; personal rotation keeps
  it claimed. Personal revocation releases it, and the next group GET reports
  claimed false. Reclaim creates a fresh personal token while retaining that
  participant's picks and done state; the revoked token remains invalid.
- Group GET and claim use `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex` on successes and
  errors, and force dynamic handling. Explicit selections and serialization
  exclude contacts, owner identity, image/blob fields, extraction, token
  hashes and raw tokens from GET. Claim returns only its personal URL.
- Owner receipt detail exposes `hasGroupLink` derived from the hash, never
  the hash itself. The `/g/` path prefix is public for signed-out visitors;
  `/groups`, `/group` and other protected page paths stay protected. The
  `/g/[token]` page and sharing controls are separate UI work.

### Picking and editing

- A DRAFT receipt is in one of two modes (ADR-0017), stored as
  Receipt.picksOpenedAt: null is **Editing**, a timestamp is **Picking
  open**. Every receipt starts in Editing, including receipts that existed
  before the column.
- `POST /api/receipts/[id]/picking` takes `{ open: boolean }` with the owner
  ritual and no expectedRevision. Under the receipt row lock it sets
  picksOpenedAt to now or null and returns receipt detail. Opening an open
  receipt keeps its timestamp; pausing a paused one is a no-op. It does not
  change the revision. FINALIZED and PARSING receipts return 409.
- Opening requires reviewedAt to be set (409 `CONFLICT` "Review the receipt
  before opening picking") and at least one participant other than the
  organizer's row (409 `CONFLICT` "Add someone to pick before opening
  picking").
- While picking is open, every owner write that takes expectedRevision
  returns 409 `CONFLICT` "Pause picking to make changes" and writes nothing:
  receipt PATCH (receipts/edit.md), item replacement (receipts/items.md),
  the roster (receipts/participants.md), assignments and shared allocations
  (bills/allocations.md), parse (receipts/parse.md) and finalize
  (bills/split-allocation.md). This check comes before the revision check,
  so a stale request gets this message rather than "reload". Pick links,
  the organizer's own picks and the picking route keep working.
- While editing, guest PUT and POST done return 409 `CONFLICT` "The
  organizer is making changes" and write nothing. GET still works; the token
  is valid, so this is never the 404.
- Switching modes clears no picks and no picksSubmittedAt.

### The organizer's own picks

- `PUT /api/receipts/[id]/picks` takes `{ itemIds }`, validated as the guest
  PUT, with the owner ritual and no expectedRevision. It reconciles the
  receipt's organizer row exactly like a guest's picks, under the same row
  lock, and advances the revision. It works in either mode, since it changes
  only the organizer's own picks (ADR-0018). FINALIZED and PARSING receipts
  return 409; a receipt with no organizer row returns 409 `CONFLICT` "You
  aren't on this receipt". It returns receipt detail.
- The organizer has no done state; their row's picksSubmittedAt stays null.

### Links and previews

- Opening a link changes nothing; only PUT and POST write. Link previews that
  messaging apps generate are therefore harmless.
- The guest page's title and preview metadata are generic ("Split Bill") and
  never include the merchant, names or amounts. It sends
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`, and request
  logging records token routes without the token, so a link does not leak
  through previews, referrers, search engines or logs.
- The pick page is phone-first and meets the mobile standard in web.md: each
  item is a full-width row that toggles when tapped anywhere on it, and the
  done action stays reachable without horizontal scrolling.
- Invalid input 400. Failures roll back all changes.

### Guest page

- `/p/<token>` is public for signed-out visitors; `/p`, `/people` and other
  protected paths still require sign-in. It has no receipt step bar or account
  menu, including when the browser holds an organizer session.
- The server reads `getPicks` directly, dynamically, without an HTTP request
  to itself. Unknown links show "This link isn't valid" with no receipt data;
  other failures show a generic retry card, never the underlying error.
- Draft items are ordered by line number, with their name, quantity, price
  in the receipt currency and who else picked it, as the same colored initial
  circles the organizer's picks board uses (same color per person, by roster
  position; up to three, then "+N"). Screen readers get the names in the row's
  description instead of the circles. Each labeled checkbox row
  is at least 44px tall and toggles across its full width. The token holder,
  never the signed-in account, determines the checked items.
- Changes show immediately. One PUT is in flight at a time; later taps are
  coalesced into the next complete item set. A response updates the confirmed
  projection without discarding later taps. Failed writes discard queued
  changes, restore the last confirmed picks and show an explanatory toast
  and inline retry. A network failure may have committed, so retry refreshes
  the projection before allowing more writes.
- **I'm done** waits for outstanding saves before POSTing. Only a successful
  response confirms submission. A later selection clears the visible done
  state immediately; the successful PUT clears it on the server too.
- While editing, rows are read-only and the page says "The organizer is
  making changes. Check back in a minute." with **Check again**. A button
  press or a visible window regaining focus refreshes GET, with no polling.
  Refreshes and writes are serialized. A visible return during an outstanding
  GET records one trailing read, even if the current read fails; multiple
  returns during that read coalesce. Writes stay disabled until the trailing
  read completes so an earlier Editing snapshot cannot hide reopened picking.
  A 409 refreshes the projection before
  any further write; a write 404 also refreshes because an item may have been
  removed while the personal link remains valid. Only a GET 404 invalidates
  the link. Failed refreshes leave writes disabled until a successful retry.
- Closing or navigating away with a request outstanding uses the browser's
  unsaved-change warning. Requests already sent may commit; reopening the
  link always reads the server's current state.
- Finalized links render everyone's already-calculated amount and settlement
  state, plus **Pay <payer>** or a neutral message when the payer is unknown.
  Money is formatted directly from decimal strings without floating-point
  conversion or recalculation. The summary includes no picker or mutating
  controls. A draft refresh that discovers finalization refreshes the server
  page to replace the picker with this server-rendered summary.
- The HTML, including loading and error responses, is not cached and sends
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. Title,
  description, Open Graph and Twitter metadata say only "Split Bill".

## Examples

| State / input | Behavior |
|---|---|
| Sam's token, PUT rice + mango | Both become Sam's individual assignments |
| Maya then Sam pick the dumplings | Equal shared allocation; ITEMIZED becomes SHARED_ITEMS |
| Sam unpicks dumplings he shared with Maya | Dumplings become Maya's assignment |
| Item id from another receipt | 404, nothing written |
| Token rotated, old link opened | 404 |
| Receipt finalized, link opened | Split summary: everyone's name, amount owed and settled state, and the payer |
| Receipt finalized, guest PUTs picks | 409, nothing written |
| Sam removed from the roster, his link opened | 404 |
| Maya and Sam save picks at the same moment | Both saved, one after the other |
| Guest saves an item the owner has since removed | 404, guest reloads |
| Sam presses done, then edits picks | picksSubmittedAt cleared until done again |
| Sam presses done twice | First press sets picksSubmittedAt and advances the revision; the second changes nothing |
| Picking paused, Sam PUTs picks | 409 "The organizer is making changes"; GET still works |
| Picking open, owner PATCHes the tip | 409 "Pause picking to make changes" |
| Open picking on an unreviewed receipt | 409, still Editing |
| Open picking with only the organizer's row | 409, still Editing |
| Organizer PUTs their picks while picking is open | Saved; revision advances |
| Pause picking after Maya pressed done | Maya's picks and done state kept |
| Owner requests a pick link for their own row | 400 |
| Group link opened while Editing | Unclaimed guest roster, pickingOpen false, no write |
| Two guests claim Maya at the same time | One personal URL; the other gets 409 Already claimed |
| Group claim names the organizer | 400, no personal token issued |
| Owner revokes Maya's personal link, then Maya reclaims | Old personal token 404; fresh token; picks and done state kept |
| Owner rotates the group link after Maya claims | Old group token 404; Maya's personal token still works |
| Finalized group link opened | Every participant's split, including the organizer; no holder identity |
| Finalized receipt receives a claim | 409, nothing written |

## Verify

- `guest-pick-page.test.ts` checks public access, generic metadata, guest
  headers, invalid versus retryable failures, checkbox labels and initial
  picks, editing/submitted states, and every finalized participant's amount,
  settlement and payer with no picker controls.
- `guest-pick-session.test.ts` exercises full-set writes, rapid taps, save
  rollback, queued done, done failure, focus refresh without polling, a
  trailing read when picking reopens during an outstanding GET, mode
  conflicts, removed items, revoked links and draft-to-finalized handoff.
- pnpm test (group-links-route.test.ts) covers owner authentication and scope,
  issue/rotate/idempotent revoke in both draft modes and after finalize,
  hash-only storage, the identical 404 family, read-only GET, exact draft and
  finalized projections, organizer exclusion/rejection, malformed claim input,
  foreign participants, repeated and parallel claims, revision preservation,
  privacy and all guest response headers. Existing personal-link issue,
  rotation, release and reclaim preserve picks/done and report claimed state.
- Receipt detail tests cover hasGroupLink on both sides of issuance/revocation
  and absence of groupTokenHash from every receiptDetail response. Page-access
  tests allow signed-out `/g/<token>` while protecting unrelated paths.
- Migration verification applies the new SQL to existing receipt fixtures,
  confirms null defaults and preserved content, permits multiple null hashes,
  and rejects duplicate non-null hashes.
- API drill (pnpm dev, owner session): POST the group-link route, anonymously
  GET the roster, claim a guest, and GET the returned personal token. A repeat
  claim returns 409. Rotate the group link: old group GET is 404 while the
  personal token still works. Pause picking, finalize normally, then confirm
  current group GET returns the split and claim returns 409. Inspect response
  bodies and headers for privacy and cache/referrer/index protection.
- `pnpm --filter @project/db-server exec tsx drills/group-links.ts` runs the
  lock and live HTTP drills against an isolated temporary PostgreSQL cluster
  after `pnpm build`. It uses installed embedded-postgres binaries, applies
  the same migrations, starts the built Next server on a temporary port with
  an isolated database session, and stops both servers and removes temporary
  data on completion. It does not open the development cluster or a shared
  database. Raw credentials are not printed.
  The live HTTP drill also requests personal guest HTML signed out and with
  an owner session, checks Editing, Picking, submitted, finalized and rotated
  states, confirms the owner's submitted timestamp, generic metadata,
  account-menu omission and privacy headers, and verifies protected routes
  still redirect to login. These HTTP checks do not replace the phone and
  keyboard browser passes below.
- Append `--dev` to the isolated drill command to exercise the same HTTP flow
  under `next dev --turbopack`, including absence of tokens from request logs.
- Lock drill uses an isolated local PostgreSQL database with independent
  connections, separate from the service-free PGlite suite. Pause a claim
  behind a held receipt lock; queue owner rotation or revocation ahead of it
  and observe both blocked updates through pg_stat_activity. Release the
  lock, then assert claim returns 404 and stores no personal hash. Repeat for
  rotation and revocation, and exercise the reverse
  order where a committed claim survives a later group change. Parallel calls
  on one PGlite connection do not establish PostgreSQL lock contention.
- pnpm test covers token issue/rotate/revoke, hash-only storage, the 404
  family, reconciliation of individual and shared rows, mode transitions,
  concurrent guest saves all landing, rollback, the finalized split
  projection, 409 on writes after finalize, and that phones and emails never
  appear in token responses.
- pnpm test (picking-route.test.ts) covers open and pause with their 409
  preconditions, every owner write returning 409 while picking is open and
  writing nothing, guest PUT and done returning 409 while editing with GET
  still 200, `pickingOpen` in the projection, the organizer's picks in both
  modes reconciling like a guest's, and 400 for the organizer's pick link.
- API drill (pnpm dev, signed in): with picking paused, a guest PUT returns
  409; POST picking `{ open: true }`, and the same PUT succeeds while the
  owner's PATCH returns 409; pause again, and the PATCH succeeds.
- pnpm typecheck and pnpm build pass.
- API drill (pnpm dev, signed in): POST the pick-link route for a seeded
  participant; `curl /api/picks/<token>` with no cookie shows the projection
  with no phone or email; PUT two item ids and POST done; the
  owner's GET /api/receipts/[id] shows the assignments, `hasPickLink: true`
  and a picksSubmittedAt. Rotate, and the old token's GET returns 404.
- Drill: issue a link, open /p/<token> in a private window, pick items, then
  confirm the owner's receipt detail shows them and the participant is ready.
- Phone drill: open /p/<token> at 375px wide (devtools or a real phone); pick
  and unpick items by tapping their rows and press done, with no zooming and
  no horizontal scroll.
- Finalize drill: finalize the receipt, reopen the same /p/<token>; the split
  summary shows every participant's amount, PUT returns 409, and the page
  title shows no merchant or names.

## Known gaps against this contract

These statements above are contract, not yet fact. A PR that closes one
deletes its line from this section.

- **Guest visual verification remains pending.** The HTTP and automated
  markup/controller drills cover the guest flow; the 375px phone and
  keyboard-only browser passes still require visual verification.
- **The group page and organizer sharing controls do not exist.** The group
  API and public `/g/` path rule do not provide a working `/g/[token]` page.
  Name confirmation, browser-local "Continue as" and sharing/claimed UI are
  separate work; this feature's drill addresses the API directly.

## Constraints & decisions

- Permitted by ADR-0015, which supersedes the earlier public share link.
- Guest writes cannot use lockEditableReceipt, which requires an owner and an
  expected revision; lockReceiptForGuest keeps the same row lock and revision
  advance without either.
- Issuing and revoking links leave the revision alone, so the owner can send
  links mid-edit without their next save returning 409.
- The link is built from the request origin because the app has no configured
  public origin; a proxied deployment would add one.
- One token per participant rather than per receipt, so a guest cannot pick
  for someone else and the owner can revoke one person.
- One token for both phases instead of a separate share link, so there is one
  route family to audit. After finalize every holder sees every amount; ADR-0015
  accepts that because names and amounts are low-sensitivity and revocation
  ends it.
- Only hashes are stored, so a database read does not leak working links.
- ADR-0017 adds the group token as a roster/claim credential; it never
  authorizes picks. A claim uses a state-independent receipt lock because
  lockReceiptForGuest requires Picking open and advances revision.
- The draft roster omits the organizer because that row cannot hold a
  personal token (ADR-0018). The finalized summary includes it so amounts
  describe the whole split. A shared holder-independent finalized projection
  keeps group and personal amount/settlement semantics aligned.
- Personal revocation preserves done state as required by ADR-0017's recovery
  flow; releasing a credential does not change the participant's picks.
- Weighted portions are out; shared means equal, as in bills/allocations.md.
- Picking and editing lock each other out (ADR-0017), so a guest save can't
  undo an owner's fix and an owner save is never stale because of a pick.
  The switch is manual; nothing opens or pauses it automatically.
- The organizer picks through their own row with no expectedRevision
  (ADR-0018), so polling guests' picks never makes their save stale.

## Out of scope

- The app sending the link by SMS or email itself; the organizer sends it.
- Guests marking their own bill paid; only the owner records payment.
- Guests adding or editing items or other participants.
- The `/g/[token]` page, confirmation, browser storage and organizer group
  sharing controls; the group UI spec is not yet written.
