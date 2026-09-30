-- The day a bank posted a movement on one of the accounts it touches, when that differs from the
-- movement's own date. `occurred_on` is when the money really moved (a payment receipt, a
-- broker mail, the card's credit date); a bank document files the same money under its own
-- posting day — Santander's day ends at 14:00, so a wire after the cutoff posts the next
-- workday, sometimes in the next month. Reconciliation against a bank document (the checking
-- ledger anchor, the cartola month table, the xlsx/cartola dedupe) reads
-- COALESCE(posted_on, occurred_on); everything else reads occurred_on. One row per (movement,
-- account) because a transfer between two bank accounts has a posting day on each side.
-- Sparse: no row means the bank posted it on occurred_on.
CREATE TABLE movement_bank_postings (
  movement_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  posted_on TEXT NOT NULL CHECK (posted_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (movement_id, account_id)
);

-- Backfill from the evidence already stored.

-- Converted mirror pairs: each leg's original row was its account's own listing.
INSERT OR IGNORE INTO movement_bank_postings (movement_id, account_id, posted_on)
SELECT m.id, m.from_account_id, mm.out_occurred_on
FROM movement_mirror_merges mm
JOIN movements m ON m.id = mm.transfer_movement_id
WHERE mm.out_occurred_on <> m.occurred_on;

INSERT OR IGNORE INTO movement_bank_postings (movement_id, account_id, posted_on)
SELECT m.id, m.to_account_id, mm.in_occurred_on
FROM movement_mirror_merges mm
JOIN movements m ON m.id = mm.transfer_movement_id
WHERE mm.in_movement_id IS NOT NULL
  AND mm.in_occurred_on <> m.occurred_on;

-- Synthesized transfers the bank later listed: confirmed_on is the bank row's date.
INSERT OR IGNORE INTO movement_bank_postings (movement_id, account_id, posted_on)
SELECT m.id, m.from_account_id, s.confirmed_on
FROM santander_synthetic_cc_payment_transfers s
JOIN movements m ON m.id = s.movement_id
WHERE s.confirmed_on IS NOT NULL AND s.confirmed_on <> m.occurred_on;

INSERT OR IGNORE INTO movement_bank_postings (movement_id, account_id, posted_on)
SELECT m.id, m.to_account_id, s.confirmed_on
FROM fintual_synthetic_retiro_transfers s
JOIN movements m ON m.id = s.movement_id
WHERE s.confirmed_on IS NOT NULL AND s.confirmed_on <> m.occurred_on;

-- Bank rows re-dated by a payment receipt: the import identity in the note keeps the bank date.
INSERT OR IGNORE INTO movement_bank_postings (movement_id, account_id, posted_on)
SELECT id, account_id, substr(note, 24, 10)
FROM movements
WHERE note LIKE 'import:cartola-partial|%'
  AND substr(note, 24, 10) <> occurred_on;

INSERT OR IGNORE INTO movement_bank_postings (movement_id, account_id, posted_on)
SELECT id, account_id, substr(note, instr(note, '|on:') + 4, 10)
FROM movements
WHERE note LIKE 'import:cartola|%'
  AND note NOT LIKE 'import:cartola|anchor|%'
  AND instr(note, '|on:') > 0
  AND substr(note, instr(note, '|on:') + 4, 10) <> occurred_on
