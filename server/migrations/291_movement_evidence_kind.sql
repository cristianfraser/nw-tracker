-- A movement's document kind lives in its evidence row (docs/untangle-flow-identity.md, F9 step 4,
-- provenance in columns): readers ask `flow_evidence.source_kind` (a cartola row, its opening
-- anchor, a daily listing row, a mail-written row) instead of testing note prefixes. The hook
-- (`flows/flowEvidenceKind291.ts`) installs the trigger that keeps the kind, the document key and
-- the authority in step when an importer rewrites a note (a promoted credit, a re-dated cartola
-- month), and re-derives every movement's evidence once (counts in the report).
SELECT 1;
