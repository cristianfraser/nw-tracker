-- payment.processor_receipts: the vehicle permit a municipality's receipt is for (permiso de
-- circulación): its year, plate, which cuota of how many, and when the permit it issues expires.
ALTER TABLE payment_processor_receipts ADD COLUMN permit_year INTEGER;
ALTER TABLE payment_processor_receipts ADD COLUMN permit_plate TEXT;
ALTER TABLE payment_processor_receipts ADD COLUMN permit_cuota INTEGER;
ALTER TABLE payment_processor_receipts ADD COLUMN permit_cuotas INTEGER;
ALTER TABLE payment_processor_receipts ADD COLUMN permit_expires_on TEXT
