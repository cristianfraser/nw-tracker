-- The INE's official monthly IPC variation, as the SII publishes it (sii.cl/valores_y_fechas/utm/
-- utm<year>.htm, one decimal) — the figure the UF follows and the SII reajusta with (a crypto cost
-- under art. 17 N°8 m): «entre el mes anterior a la adquisición y el mes anterior al de la
-- enajenación»). `ipc_daily` keeps the Banco Central's spliced index, which differs from it in
-- some months. `index_points` is the index as printed, in the base of its day (2013, 2018 or 2023
-- = 100), so ratios across a base change are meaningless; reajustes chain `variation_pct`.
CREATE TABLE IF NOT EXISTS ipc_official_monthly (
  month TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-01'),
  variation_pct REAL NOT NULL,
  index_points REAL NOT NULL CHECK (index_points > 0)
);
