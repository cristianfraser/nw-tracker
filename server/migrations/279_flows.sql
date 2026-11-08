-- Flow identity (docs/untangle-plan.md F9 step 3, docs/untangle-flow-identity.md): one `flows` row
-- per expense identity, the documents that record it as `flow_evidence`, and the outside parties a
-- flow may start or end at. Every movement, card line, plan and manual expense points at its flow
-- (`flow_id`). The hook (`flows/flowTables279.ts`) seeds parties, flows and evidence, installs the
-- triggers that give every row written later its own flow, and reports counts (no names, no amounts).
CREATE TABLE outside_parties (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('merchant', 'person', 'employer', 'state', 'bank', 'family', 'broker', 'other')),
  name TEXT NOT NULL CHECK (name <> ''),
  name_key TEXT NOT NULL,
  rut TEXT,
  source TEXT NOT NULL CHECK (source IN ('vendor_catalog', 'counterparty', 'employer', 'payee', 'manual', 'system'))
);
CREATE UNIQUE INDEX idx_outside_parties_identity ON outside_parties(kind, name_key, IFNULL(rut, ''));

CREATE TABLE flows (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  from_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  from_party_id INTEGER REFERENCES outside_parties(id),
  to_party_id INTEGER REFERENCES outside_parties(id),
  occurred_on TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  counter_amount REAL,
  counter_currency TEXT,
  description TEXT,
  legacy_key TEXT UNIQUE,
  CHECK (from_account_id IS NOT NULL OR from_party_id IS NOT NULL),
  CHECK (to_account_id IS NOT NULL OR to_party_id IS NOT NULL)
);
CREATE INDEX idx_flows_from_account ON flows(from_account_id);
CREATE INDEX idx_flows_to_account ON flows(to_account_id);

CREATE TABLE flow_evidence (
  id INTEGER PRIMARY KEY,
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'statement_pdf', 'statement_json', 'statement_other', 'listing_open', 'listing_stale', 'cartola', 'cartola_anchor',
    'daily_listing', 'mail_notice', 'mail_rebuilt', 'broker_document', 'legacy_import', 'receipt', 'manual',
    'payslip', 'plan', 'gap_mirror'
  )),
  source_table TEXT NOT NULL,
  source_row_id INTEGER NOT NULL,
  document_key TEXT,
  stated_on TEXT,
  stated_amount REAL,
  stated_currency TEXT,
  stated_description TEXT,
  authority INTEGER NOT NULL CHECK (authority IN (1, 2, 3)),
  UNIQUE (source_table, source_row_id)
);
CREATE INDEX idx_flow_evidence_flow ON flow_evidence(flow_id);

ALTER TABLE movements ADD COLUMN flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL;
ALTER TABLE cc_statement_lines ADD COLUMN flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL;
ALTER TABLE cc_installment_purchases ADD COLUMN flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL;
ALTER TABLE expense_entries ADD COLUMN flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL;
ALTER TABLE income_entries ADD COLUMN flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL;
CREATE INDEX idx_movements_flow ON movements(flow_id);
CREATE INDEX idx_cc_statement_lines_flow ON cc_statement_lines(flow_id);
CREATE INDEX idx_cc_installment_purchases_flow ON cc_installment_purchases(flow_id);
CREATE INDEX idx_expense_entries_flow ON expense_entries(flow_id);

-- Assignments whose key no row carries any more (the movement or line is gone; nothing reads them):
-- kept, never dropped, as the row they were (`payload`, JSON). Each assignment migration (280+)
-- moves its orphans here.
CREATE TABLE flow_orphan_assignments (
  id INTEGER PRIMARY KEY,
  source_table TEXT NOT NULL,
  purchase_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
