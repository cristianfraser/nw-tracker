-- depto_dividendos_sheet_rows was the import/manual-entry staging mirror of the spreadsheet
-- master. The excel import is retired and manual mortgage payments now write depto_payments
-- directly (migration 157 backfilled + cross-checked against this staging before the drop).
DROP TABLE IF EXISTS depto_dividendos_sheet_rows;
