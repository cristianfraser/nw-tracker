-- What runtime read from a bank row's note, in columns of its evidence: a cartola row's branch and
-- its position in its cartola (`stated_branch`, `stated_position`; the position is the row's purchase
-- key with the month, day and pesos it already states), and the description a row written from a
-- mail or a ledger anchor carries (`stated_description`). A mirror conversion keeps the two new
-- facts of each deleted leg with its merge row, as it keeps the others. The hook backfills the rows
-- on file from their notes once and reinstalls the write logs and the note trigger.
ALTER TABLE flow_evidence ADD COLUMN stated_branch TEXT;
ALTER TABLE flow_evidence ADD COLUMN stated_position INTEGER;
ALTER TABLE movement_mirror_merges ADD COLUMN out_listed_branch TEXT;
ALTER TABLE movement_mirror_merges ADD COLUMN out_listed_position INTEGER;
ALTER TABLE movement_mirror_merges ADD COLUMN in_listed_branch TEXT;
ALTER TABLE movement_mirror_merges ADD COLUMN in_listed_position INTEGER;
