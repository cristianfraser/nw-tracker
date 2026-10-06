-- The Superintendencia de Pensiones' daily valor cuota of every AFP and fund (A–E), with the
-- SP's own date: the day the fund was valued. The authority the AFP account's price series is
-- checked against and rebuilt from (an AFP's own website shows a day later than this date).
-- `provisional` = printed under «Valores Provisorios - Sujetos a Confirmacion»; a later read
-- of the same day replaces the value. `afp` is the SP column name lower-cased, spaces → '_'.
CREATE TABLE pension_fund_unit_official (
  afp TEXT NOT NULL,
  fund TEXT NOT NULL CHECK (fund IN ('A', 'B', 'C', 'D', 'E')),
  day TEXT NOT NULL,
  unit_value_clp REAL NOT NULL CHECK (unit_value_clp > 0),
  provisional INTEGER NOT NULL CHECK (provisional IN (0, 1)),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (afp, fund, day)
);
