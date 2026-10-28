-- A place bill paid for several months at once (two months of HOA in one transfer, a bill
-- issued every two months) is one payment, one row, but a monthly view must show it in every
-- month it pays for. `months_covered` counts those months, ending at the bill's own month
-- (`spent_on`); the real-estate chart divides the amount evenly over them. 1 = a month's bill.
ALTER TABLE expense_entries ADD COLUMN months_covered INTEGER NOT NULL DEFAULT 1 CHECK (months_covered >= 1);
