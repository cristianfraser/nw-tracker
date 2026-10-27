-- `movements.ticker` repeated the stock account's `accounts.equity_ticker`, and only on trades
-- entered through the panel form: the importers never wrote it, so a third of the trades had none.
-- Nothing but the flows table's Ticker column and the XLSX export read it; the counterparty
-- column already names the stock account. The movements update trigger watched the column, so it
-- is dropped first; this migration's hook (`runMarkInputChangeTriggers243`) re-creates the set.
DROP TRIGGER IF EXISTS mark_input_movements_au;
ALTER TABLE movements DROP COLUMN ticker;
