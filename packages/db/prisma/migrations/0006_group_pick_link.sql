-- Shared roster/claim credential (ADR-0017). Existing receipts have no link.
BEGIN;

ALTER TABLE receipts ADD COLUMN group_token_hash TEXT;
CREATE UNIQUE INDEX receipts_group_token_hash_key ON receipts(group_token_hash);

COMMIT;
