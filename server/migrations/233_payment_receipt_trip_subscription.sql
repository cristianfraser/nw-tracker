-- payment.processor_receipts: the ride a receipt is for (Uber: where it started and ended, as
-- printed) and whether the document states the payment is a subscription's (Uber One).
ALTER TABLE payment_processor_receipts ADD COLUMN trip_from TEXT;
ALTER TABLE payment_processor_receipts ADD COLUMN trip_to TEXT;
ALTER TABLE payment_processor_receipts ADD COLUMN trip_started_at_chile TEXT;
ALTER TABLE payment_processor_receipts ADD COLUMN trip_ended_at_chile TEXT;
ALTER TABLE payment_processor_receipts ADD COLUMN trip_distance_km REAL;
ALTER TABLE payment_processor_receipts ADD COLUMN subscription INTEGER NOT NULL DEFAULT 0 CHECK (subscription IN (0, 1));
