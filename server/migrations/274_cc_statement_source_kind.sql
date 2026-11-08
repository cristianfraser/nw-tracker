-- Statement provenance in a column (docs/untangle-plan.md F9 step 2). What kind of document a
-- `cc_statements` row is was read back out of `source_pdf` by five predicates and ~40 prefix
-- tests; `source_kind` names it once. It is generated from the source id the writer chose (the
-- one classification, here), so a row can never carry a kind its source disagrees with; readers
-- read the column and nothing tests the prefix. `source_pdf` stays the provenance text and the
-- open bucket's identity. Kinds:
--   statement_pdf   a statement from the PDF corpus (a file name)
--   statement_json  the Santander statement JSON (`import:santander-json|…`)
--   statement_other a statement from outside the corpus: rebuilt from mails, the CMR card's mailed
--                   PDFs, an estimate (`import:<kind>|…`), or one with no source id
--   listing_open    the open facturación's bank-listing bucket (feed or paste, `import:web-paste|open|…`)
--   listing_other   any other bank-listing bucket (`import:web-paste…`)
ALTER TABLE cc_statements ADD COLUMN source_kind TEXT GENERATED ALWAYS AS (CASE
  WHEN substr(trim(source_pdf), 1, 22) = 'import:web-paste|open|' THEN 'listing_open'
  WHEN substr(trim(source_pdf), 1, 16) = 'import:web-paste' THEN 'listing_other'
  WHEN substr(trim(source_pdf), 1, 22) = 'import:santander-json|' THEN 'statement_json'
  WHEN substr(trim(source_pdf), 1, 7) = 'import:' OR trim(coalesce(source_pdf, '')) = '' THEN 'statement_other'
  ELSE 'statement_pdf'
END) VIRTUAL;
CREATE INDEX IF NOT EXISTS cc_statements_account_source_kind ON cc_statements (account_id, source_kind);
