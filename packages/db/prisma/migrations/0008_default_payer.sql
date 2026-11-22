-- Receipts finalized before finalization defaulted the payer to the organizer
-- counted the organizer's own share as owed to themselves. Backfill the payer
-- from the organizer; receipts that already name a payer are left alone.
BEGIN;

UPDATE receipts
SET paid_by_participant_id = organizer_participant_id
WHERE status = 'FINALIZED'
  AND paid_by_participant_id IS NULL
  AND organizer_participant_id IS NOT NULL;

COMMIT;
