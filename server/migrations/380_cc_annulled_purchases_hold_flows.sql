-- An annulled card purchase (migration 332) holds its flow: the flow delete triggers retire a flow an
-- annulment names instead of deleting it, so a voided purchase keeps its arrival stamp while the
-- annulment stands and the line that bills or re-lists it later takes that flow back. The hook
-- reinstalls the delete triggers (`flowRetireDeleteTriggerSql`, annulments counted); the index serves
-- their lookup by flow.
CREATE INDEX IF NOT EXISTS idx_cc_annulled_purchases_flow ON cc_annulled_purchases(flow_id);
