-- A plan's stored cuota is tied to its statement line by `parser_row_id`, and nothing indexed it on
-- either side. The card readers join the two on every expense-line build: the plan cuotas with
-- their statement's period (`ledgerPlanCuotas`), the printed principal of a priced plan
-- (`planPrintedCuotaLines`), and the plan behind a cuota line (`installmentLedgerTotalViaPaymentRow`,
-- once per line). Without the indexes SQLite rebuilt a temporary index over every statement line
-- on each join and scanned every stored cuota on each lookup.
CREATE INDEX idx_cc_statement_lines_parser_row_id ON cc_statement_lines(parser_row_id);
CREATE INDEX idx_cc_inst_payments_parser_row_id ON cc_installment_payments(parser_row_id)
