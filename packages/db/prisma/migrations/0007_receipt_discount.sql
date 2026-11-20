BEGIN;

ALTER TABLE receipts
  ADD COLUMN discount DECIMAL(12, 2);

ALTER TABLE bills
  ADD COLUMN discount_share DECIMAL(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE receipts
  ADD CONSTRAINT receipts_discount_nonnegative_check
  CHECK (discount IS NULL OR discount >= 0),
  ADD CONSTRAINT receipts_discount_within_subtotal_check
  CHECK (discount IS NULL OR subtotal IS NULL OR discount <= subtotal);

ALTER TABLE receipts DROP CONSTRAINT receipts_finalized_money_check;
ALTER TABLE receipts ADD CONSTRAINT receipts_finalized_money_check CHECK (
  status <> 'FINALIZED' OR (subtotal IS NOT NULL AND tax IS NOT NULL AND total IS NOT NULL
    AND subtotal > 0 AND total = subtotal - COALESCE(discount, 0) + tax + COALESCE(tip, 0))
);

ALTER TABLE bills DROP CONSTRAINT bills_money_check;
ALTER TABLE bills ADD CONSTRAINT bills_money_check
  CHECK (subtotal >= 0 AND discount_share >= 0 AND tax_share >= 0 AND tip_share >= 0
    AND amount_owed = subtotal + tax_share + tip_share - discount_share);

ALTER TABLE bills
  ADD CONSTRAINT bills_discount_share_within_subtotal_check
  CHECK (discount_share >= 0 AND discount_share <= subtotal),
  ADD CONSTRAINT bills_amount_owed_nonnegative_check
  CHECK (amount_owed >= 0);

COMMIT;
