-- What each crypto coin movement is, as structured state: the Buda import wrote the kind into the
-- note only (provenance, never read at runtime). One row per coin-account movement:
--   buy / sell           traded against pesos on the exchange (the Buda CLP buffer's opposite row)
--   swap_out / swap_in   one coin exchanged for another the same day, no pesos involved
--   coin_out             coin sent out of the portfolio (paid away, not a trade)
--   send_fee             coin lost as a network fee on a send
--   round_trip_return    coin that came back after a round trip through another exchange
-- Filled once by server/scripts/backfill-crypto-movement-kinds.ts and written by the Buda rebuild.
CREATE TABLE IF NOT EXISTS crypto_movement_kinds (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('buy', 'sell', 'swap_out', 'swap_in', 'coin_out', 'send_fee', 'round_trip_return'))
);
