-- The instrument registry keeps no exchange code (2026-11-11). `mic` (ISO 10383, added by 305) was
-- read by nothing that prices, schedules or values: the calendar and sessions are `market_kind`,
-- under which NYSE, NYSE Arca, NYSE American, Cboe and Nasdaq are one market, and `exchange`
-- already keeps the provider's own name for the venue. The only reader was the demo market's check
-- against Yahoo, which failed the nightly publish when Yahoo's label for a US venue differed from
-- the declaration (LNG, SGOV).
--
-- The write-log UPDATE trigger names every column, so it is dropped first (SQLite refuses to drop
-- a column a trigger reads) and the hook re-creates it over the remaining columns.
DROP TRIGGER IF EXISTS write_log_market_symbols_au;
ALTER TABLE market_symbols DROP COLUMN mic;
