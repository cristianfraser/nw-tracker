-- Manual expenses are spending with no card line behind them (docs/untangle-flow-identity.md, F9
-- step 3): their flows take the new `purchase` kind instead of the `card_purchase` placeholder. The
-- hook (`flows/flowAssignments280.ts`) re-kinds the existing flows, checks none is left and
-- re-creates the insert trigger that gives a new manual expense its flow.
SELECT 1
