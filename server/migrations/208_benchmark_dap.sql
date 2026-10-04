-- A deposit at a fixed real rate (DAP reajustable): the UF compounded at 2% a year.
INSERT OR IGNORE INTO benchmarks (slug, kind, label_i18n_key, index_key, rate_pct, sort_order)
VALUES ('dap', 'index_plus_rate', 'benchmarks.dap', 'uf', 2, 4);
