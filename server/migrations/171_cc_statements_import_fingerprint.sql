-- Content fingerprint of the parsed rows a statement was last imported from, so the nightly
-- run can skip statements whose parse has not changed instead of re-importing and
-- re-reconciling the entire historical corpus every night (240 statements, ~9 minutes, and one
-- unresolvable legacy statement aborting all of it). NULL means "never fingerprinted" and is
-- treated as changed, so existing rows import once and settle.
ALTER TABLE cc_statements ADD COLUMN import_fingerprint TEXT;
