-- An annulled purchase the bank later refunded with a REAL credit line (a nota de crédito on a
-- statement). The purchase then has its refund on a statement, so the synthetic annulment leg
-- (`annulled_on`, the refund the app invents for a purchase the bank silently dropped) must not
-- count a second time: `bank_credit = 1` keeps the purchase leg only, and `annulled_on` is moved to
-- the credit's day. Readers skip the annulment leg and its synthetic refund line for such a row.
ALTER TABLE cc_annulled_purchases ADD COLUMN bank_credit INTEGER NOT NULL DEFAULT 0 CHECK (bank_credit IN (0, 1))
