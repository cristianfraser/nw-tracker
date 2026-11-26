-- A fund unit row written as a certificate's scratch price (pesos ÷ cuotas of one movement line,
-- never a display price) was told apart by its note («afp-cert:monto/cuotas_delta») only. The
-- flag is structured state now; the note stays provenance. Backfilled from the note once, here.
-- The hook re-creates the table's mark and write-log triggers with the column watched.
ALTER TABLE fund_unit_daily ADD COLUMN cert_scratch INTEGER NOT NULL DEFAULT 0 CHECK (cert_scratch IN (0, 1));
UPDATE fund_unit_daily SET cert_scratch = 1 WHERE note LIKE '%afp-cert:monto/cuotas\_delta%' ESCAPE '\';
