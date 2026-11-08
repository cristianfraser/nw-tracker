-- Deposit links on the flow (docs/untangle-flow-identity.md, F9 step 3; bug 8): a purchase that
-- funded a deposit is a `funded_deposit` link from the purchase's flow to the deposit's flow
-- (`counterpart_flow_id`), carrying the old row's figures (`payment_clp`, `amortization_clp`, the
-- depto cuota) and its `link_source`. `flow_links` is rebuilt for the kinds still to come (the bill
-- links of migration 286): its explicit `id` column goes (the rowid keeps insertion order, as the
-- old tables' did, and a re-derivation that rewrites the same links is no change). The hook
-- (`flows/flowAssignments280.ts`) copies the financing links, moves every row of
-- `expense_deposit_links`, archives the ones whose key names nothing, proves the move and drops the
-- old table.
CREATE TABLE flow_links_285 (
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  portion TEXT NOT NULL DEFAULT 'gastos' CHECK (portion IN ('gastos', 'deposit')),
  piece_seq INTEGER NOT NULL DEFAULT -1,
  kind TEXT NOT NULL CHECK (kind IN ('finances_facturado', 'funded_deposit', 'bill')),
  financing_link_id INTEGER REFERENCES cc_facturado_financing_links(id) ON DELETE CASCADE,
  counterpart_flow_id INTEGER REFERENCES flows(id) ON DELETE CASCADE,
  counterpart_entry_id INTEGER REFERENCES expense_entries(id) ON DELETE CASCADE,
  account_id INTEGER,
  payment_clp INTEGER,
  amortization_clp INTEGER,
  depto_cuota TEXT,
  depto_occurred_on TEXT,
  link_source TEXT CHECK (link_source IS NULL OR link_source IN ('auto', 'manual', 'synthetic')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (kind <> 'finances_facturado' OR (financing_link_id IS NOT NULL AND account_id IS NOT NULL)),
  CHECK (kind <> 'funded_deposit' OR (counterpart_flow_id IS NOT NULL AND account_id IS NOT NULL
    AND payment_clp IS NOT NULL AND amortization_clp IS NOT NULL AND link_source IS NOT NULL)),
  CHECK (kind <> 'bill' OR (counterpart_entry_id IS NOT NULL AND link_source IN ('auto', 'manual')))
);
