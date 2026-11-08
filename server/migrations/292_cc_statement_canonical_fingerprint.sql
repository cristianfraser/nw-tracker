-- The card statement import fingerprint is a hash of what the ledger stores of a statement — its
-- stored columns and its lines' — instead of the parser's CSV cells (docs/untangle-plan.md F13: one
-- canonical card line inside the server). The hook (`cards/statementFingerprint292.ts`) re-derives
-- every stored statement's `import_fingerprint` from its rows; nothing is re-imported.
SELECT 1
