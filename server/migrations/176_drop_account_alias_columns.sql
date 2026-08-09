-- Drop the liability_view alias columns. Migration 175 deleted the alias rows and every
-- creator; the follow-up code sweep removed the mapping layer, so `account_kind` was
-- 'master' on every row and `source_account_id` NULL everywhere. SQLite's ALTER TABLE
-- DROP COLUMN handles both (verified on a real-DB copy under better-sqlite3: the inline
-- CHECK and self-referencing FK are column constraints and drop with their column; other
-- tables' FKs point at accounts(id) and are untouched; integrity_check ok).
-- Fresh DBs create the columns via the schema baseline and drop them here, same as live.
ALTER TABLE accounts DROP COLUMN account_kind;

ALTER TABLE accounts DROP COLUMN source_account_id;
