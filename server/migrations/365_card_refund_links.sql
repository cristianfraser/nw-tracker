-- A card credit the user names as the refund of one purchase (the Expenses row's «Reembolso de…»):
-- a partial refund, the difference of an overcharge. One row per refund flow, pointing at the
-- purchase's flow; flow merges move both ends (`mergeFlowInto`). The expense pipeline turns it into
-- the refund line's `refund_of` (`cardRefundLinks.ts`). Its write-log triggers come from the hook.
CREATE TABLE card_refund_links (
  flow_id INTEGER PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  purchase_flow_id INTEGER NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (flow_id <> purchase_flow_id)
);
CREATE INDEX idx_card_refund_links_purchase ON card_refund_links(purchase_flow_id);
