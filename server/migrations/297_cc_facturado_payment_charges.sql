-- The one-shot charges that paid a facturado (ccFacturadoFinancingAuto.ts): a card's closed
-- facturado paid with purchases on another card is recorded once, as its `cc_facturado_financing_links`
-- row; the plans among those purchases are its `finances_facturado` flow links, and the purchases
-- made in one charge are rows here, by flow (a re-import keeps the flow). A link row with charges
-- and no plans is a facturado paid outright; with both, only the facturado less these charges was
-- financed (`amount_clp` gives the cuota spread its share).
CREATE TABLE IF NOT EXISTS cc_facturado_payment_charges (
  financing_link_id INTEGER NOT NULL REFERENCES cc_facturado_financing_links(id) ON DELETE CASCADE,
  flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount_clp INTEGER NOT NULL CHECK (amount_clp > 0),
  PRIMARY KEY (financing_link_id, flow_id)
);
