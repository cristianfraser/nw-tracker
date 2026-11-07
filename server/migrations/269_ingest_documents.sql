-- The ingest receiver's memory of `document` kinds (contracts `defineKind.ts`): one row per
-- (kind, source ref) applied with a final outcome. A resend of the same payload answers
-- `duplicate` with the first answer's details; another payload under the same ref is a conflict.
CREATE TABLE ingest_documents (
  kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  details_json TEXT,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (kind, source_ref)
);
