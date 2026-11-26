-- What a bank listing printed for a row it wrote, in columns (the daily↔cartola match reads them
-- instead of the note): a cartola or daily-listing movement's evidence states the bank day it was
-- listed on (`stated_on`), its signed amount (`stated_amount`), its description (`stated_description`)
-- and, here, its document number ('' when it printed none) and the cartola month it came from (NULL
-- for a daily-listing row). The hook backfills the rows on file from their notes once, reinstalls the
-- evidence write log over the new columns, and makes the flow delete triggers read a restated row's
-- earlier evidence (`source_table` 'restated:<table>') as history, not as a row that holds the flow.
ALTER TABLE flow_evidence ADD COLUMN stated_document_no TEXT;
ALTER TABLE flow_evidence ADD COLUMN stated_period TEXT;
