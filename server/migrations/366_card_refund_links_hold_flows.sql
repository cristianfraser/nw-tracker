-- A card refund link (migration 365) holds both its flows: the flow delete triggers retire a flow
-- either end of a link names instead of deleting it, so a re-import that rewrites the refund's or
-- the purchase's line row folds the old flow into the new line and the link survives. The hook
-- reinstalls the delete triggers (`installFlowRetireDeleteTriggers`, refund links counted); this
-- file only marks the step.
SELECT 1;
