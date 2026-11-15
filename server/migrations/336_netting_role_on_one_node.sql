-- The linked-card netting is declared on one node (docs/untangle-plan.md wave 8b, decision 6).
-- Migration 272 gave it to both the cash bucket and its savings node, so every line builder had
-- to tell the two apart to net once. The savings node keeps it (its own card, line and tile net
-- the cards). The bucket above nets through it: a total over a subtree is net of what the node
-- inside it nets (`nettingGroupWithin`, navTreeModel.ts).
UPDATE portfolio_groups SET nets_linked_group_id = NULL WHERE slug = 'cash_eqs';
