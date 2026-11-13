-- What a movement's `occurred_on` rests on when a bank posting is on file (movement_bank_postings):
-- 'evidence' = a document stated the day (a receipt, a mail, the card's credit date); 'fetch' = the
-- day the bank's listing was fetched, the latest day the money could have moved (a row Santander
-- listed after its 14:00 cutoff, `checkingPartialMovementsImport.ts`). A transfer mail stating an
-- earlier day replaces a 'fetch' day; it never replaces an 'evidence' day (`bankTransferNotices.ts`).
ALTER TABLE movement_bank_postings
  ADD COLUMN occurred_on_basis TEXT NOT NULL DEFAULT 'evidence' CHECK (occurred_on_basis IN ('evidence', 'fetch'));
