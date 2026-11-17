# Releasing a personal link cleared participant readiness

**Found:** group-link plan review. **Spec:** `docs/specs/receipts/guest-picks.md`.

## Report

Review found that revoking a personal link after pressing done cleared
`picksSubmittedAt`. The group recovery flow then allowed a fresh claim of the
same participant, but their recorded readiness was already lost.

## Expected vs actual

ADR-0017 says: "picks and done state belong to the participant, not the link,
so they survive rotation and release." Revocation instead cleared both the
credential hash and the participant's done timestamp.

## Root cause

Credential invalidation and readiness reset shared the same update. The
feature spec and revocation test both described that implementation, while
the accepted group-recovery decision required preservation.

## The fix

Personal revocation clears only the token hash. Reclaim issues a fresh
credential for the existing participant and preserves their picks and done
timestamp.

## Why our defenses missed it

The existing test explicitly expected the timestamp to be cleared. No
release-and-reclaim test compared participant state across both operations.

## What changed beyond the fix

The guest-picks spec now states the preservation rule. Personal-link tests
check it directly, and the group route suite exercises picking, done, group
rotation/revocation, personal rotation, release and reclaim while asserting
unchanged picks, done timestamp and receipt revision for link changes.
