-- Options as an instrument kind (docs/demo-app-features-plan.md §3, wave O1).
--
-- A listed option contract series is its own account, like a stock: `option_contracts` holds the
-- terms the account is valued by (the underlying, call or put, the strike, the expiry, the
-- contract multiplier) and the OCC symbol that names it. `accounts.equity_ticker` stays NULL on a
-- contract account, so the EOD sync, the watchlist and `accountsWithEquityTicker` never see it;
-- the mark reads the UNDERLYING's close through the terms here (`holdingPrices.ts`: intrinsic
-- value while unexpired, 0 on and after the expiry). Contracts are signed on the ledger (a short
-- call is -n) — `movementTransfer.ts`, `optionContracts.ts`.
--
-- `option_assignments` links the two rows an assignment (or an exercise) writes together: the
-- `option_assign` units row that closes the contracts and the `stock_sell` / `stock_buy` at the
-- strike on the underlying's account (`optionAssignment.ts`). One service writes both; the link
-- is what the tax lots (wave O2) read to carry the premium into the share sale's proceeds.
--
-- The `brokerage_opciones` asset group backs the nav bucket of the same slug (kind_slug
-- `options`, route /inversiones/brokerage/opciones), which `seedNavTree` creates and links like
-- `brokerage_acciones` — a bucket with no contract yet is not in the sidebar, as an empty bucket
-- never is. Each contract account sits on its own leaf under it (`brokerage_opciones__<occ>`).

CREATE TABLE IF NOT EXISTS option_contracts (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  underlying_ticker TEXT NOT NULL,
  right TEXT NOT NULL CHECK (right IN ('C', 'P')),
  strike REAL NOT NULL CHECK (strike > 0),
  expiry TEXT NOT NULL CHECK (expiry GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  multiplier INTEGER NOT NULL DEFAULT 100 CHECK (multiplier > 0),
  occ_symbol TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS option_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  option_movement_id INTEGER NOT NULL UNIQUE REFERENCES movements(id) ON DELETE CASCADE,
  stock_movement_id INTEGER NOT NULL UNIQUE REFERENCES movements(id) ON DELETE CASCADE
);

INSERT INTO asset_groups (slug, label, sort_order, parent_id)
SELECT 'brokerage_opciones', 'Opciones', 25, b.id
FROM asset_groups b
WHERE b.slug = 'brokerage'
  AND NOT EXISTS (SELECT 1 FROM asset_groups WHERE slug = 'brokerage_opciones');
