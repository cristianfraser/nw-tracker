-- The batch a foreign-currency bank listing leaves (rows confirmed against the ledger, none
-- inserted) is named for what it is, not for the dollar: the listing's currency is the account's
-- declared cash currency (untangle wave 9).
UPDATE import_batches SET kind = 'foreign_account_feed' WHERE kind = 'usd_account_feed';
