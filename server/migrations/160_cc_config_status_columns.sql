-- credit_card_account_config.notes was a state column in disguise: it held the machine
-- flags 'nav_retired' and 'superseded:<last4>'. Promote them to honest columns and drop
-- the notes column entirely (nothing human ever lived in it).

ALTER TABLE credit_card_account_config ADD COLUMN nav_retired INTEGER NOT NULL DEFAULT 0 CHECK (nav_retired IN (0, 1));
ALTER TABLE credit_card_account_config ADD COLUMN superseded_target_last4 TEXT;

UPDATE credit_card_account_config SET nav_retired = 1 WHERE TRIM(COALESCE(notes, '')) = 'nav_retired';
UPDATE credit_card_account_config SET superseded_target_last4 = substr(TRIM(notes), 12) WHERE TRIM(COALESCE(notes, '')) LIKE 'superseded:%';

ALTER TABLE credit_card_account_config DROP COLUMN notes;
