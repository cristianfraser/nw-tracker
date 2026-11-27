-- The vendor catalog's spellings (`checkingRestatementCarry.ts`): when a cartola month imported
-- again in place reads a description in the shared reading (`cartolaText`) and the catalog no
-- longer reaches the new spelling, the import adds it as an `exact` row of source `spelling` with
-- the display the old spelling had, so the row keeps its name. Matched like a branch choice (after
-- the user's rows, before the seeds) and left alone by the loader of the user's catalog file. The
-- paired hook `runVendorCatalogSpelling384` rebuilds the table to widen its CHECK, keeping its
-- rows, ids and write-log triggers.
SELECT 1;
