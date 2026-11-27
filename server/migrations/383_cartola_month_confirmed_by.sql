-- A cartola month confirmed by a second document (`checkingCartolaCrossCheck.ts`): the xlsx and the
-- PDF of one month, or two cuenta vista documents covering it, must state the month alike. The
-- record keeps the document that confirmed it and when, so a later copy of that document is the
-- same document again (it writes nothing). Cleared when another document replaces the month. The
-- paired hook reinstalls the table's write-log update trigger over the new columns.
ALTER TABLE checking_cartola_imports ADD COLUMN confirmed_by_file TEXT;
ALTER TABLE checking_cartola_imports ADD COLUMN confirmed_at TEXT
