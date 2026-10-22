-- A transfer between two units accounts (an AFP fund switch) carries two unit counts: the units
-- sold on the from-leg (`units_delta`) and the units bought on the to-leg (`counter_units_delta`).
-- Null on every existing row, so the to-leg keeps reading `units_delta` (`transferToLegUnits`).
-- Allowed only on a transfer (`account_id IS NULL`) — enforced by the writers and the create
-- validation, since SQLite cannot add a CHECK through ALTER TABLE. The mark-input triggers are
-- re-created by this migration's hook (`runMarkInputChangeTriggers242`) so an UPDATE of the new
-- column logs both legs' accounts.
ALTER TABLE movements ADD COLUMN counter_units_delta REAL;
