-- A mirror conversion deletes its legs; the listing facts a bank leg's evidence stated (migration 371)
-- are kept with the merge row so an undo restores them (`restoreMirrorLegListing`). The hook backfills
-- the merge rows on file from the leg notes they kept, once, and reinstalls the write log.
ALTER TABLE movement_mirror_merges ADD COLUMN out_listed_on TEXT;
ALTER TABLE movement_mirror_merges ADD COLUMN out_listed_description TEXT;
ALTER TABLE movement_mirror_merges ADD COLUMN out_listed_document_no TEXT;
ALTER TABLE movement_mirror_merges ADD COLUMN out_listed_period TEXT;
ALTER TABLE movement_mirror_merges ADD COLUMN in_listed_on TEXT;
ALTER TABLE movement_mirror_merges ADD COLUMN in_listed_description TEXT;
ALTER TABLE movement_mirror_merges ADD COLUMN in_listed_document_no TEXT;
ALTER TABLE movement_mirror_merges ADD COLUMN in_listed_period TEXT;
