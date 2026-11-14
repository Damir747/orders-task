ALTER TABLE orders
  ADD COLUMN amount_paid_kop BIGINT,
  ADD COLUMN discount_percent NUMERIC;

UPDATE orders
SET amount_paid_kop = amount_kop,
    discount_percent = 0;

ALTER TABLE orders
  ALTER COLUMN amount_paid_kop SET NOT NULL,
  ALTER COLUMN amount_paid_kop DROP DEFAULT,
  ALTER COLUMN discount_percent SET NOT NULL,
  ALTER COLUMN discount_percent DROP DEFAULT;

ALTER TABLE orders
  ADD CONSTRAINT orders_amount_paid_kop_nonnegative CHECK (amount_paid_kop >= 0),
  ADD CONSTRAINT orders_discount_percent_range CHECK (discount_percent >= 0 AND discount_percent <= 100);
