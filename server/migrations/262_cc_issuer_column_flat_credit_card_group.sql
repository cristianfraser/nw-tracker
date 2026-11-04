-- A card's issuer is a column of its config, read wherever an issuer rule applies (the derived
-- pay-by, the issuer's web-paste sign rule). It used to be parsed out of the master's import_key
-- (`credit_card_master|<issuer>|<last4>`), which stays the card's identity only.
ALTER TABLE credit_card_account_config ADD COLUMN issuer TEXT;

UPDATE credit_card_account_config
SET issuer = (
  SELECT substr(substr(a.import_key, 20), 1, instr(substr(a.import_key, 20), '|') - 1)
  FROM accounts a
  WHERE a.id = credit_card_account_config.account_id
    AND a.import_key LIKE 'credit_card_master|%|%'
);

-- Pasivos › tarjeta de crédito holds its cards directly: the issuer groups (Santander, BCI, CMR)
-- and their pages are gone. The liability items lose their credit_card_group kind, and the nav seed,
-- which runs at every boot, links each card master to the group as an account item.
CREATE TABLE liability_group_items_new (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES liability_groups(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('group', 'account')),
  child_group_id INTEGER REFERENCES liability_groups(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (item_kind = 'group' AND child_group_id IS NOT NULL AND account_id IS NULL)
    OR (item_kind = 'account' AND account_id IS NOT NULL AND child_group_id IS NULL)
  ),
  UNIQUE (group_id, child_group_id),
  UNIQUE (group_id, account_id)
);

INSERT INTO liability_group_items_new (id, group_id, item_kind, child_group_id, account_id, sort_order)
SELECT id, group_id, item_kind, child_group_id, account_id, sort_order
FROM liability_group_items
WHERE item_kind IN ('group', 'account');

DROP TABLE liability_group_items;

ALTER TABLE liability_group_items_new RENAME TO liability_group_items;

CREATE INDEX IF NOT EXISTS idx_liability_group_items_group ON liability_group_items(group_id);

DROP TABLE IF EXISTS credit_card_group_items;

DROP TABLE IF EXISTS credit_card_groups;
