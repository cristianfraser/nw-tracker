-- A grocery receipt's source names the kind of document that owns it, not the chain that sent
-- it: 'lider_email' → 'email' (a mailed receipt from any chain), 'manual_pdf' → 'pdf'. The
-- `store.receipt` ingest kind carries these names (email | pdf | photo).
UPDATE grocery_receipts SET source = 'email' WHERE source = 'lider_email';
UPDATE grocery_receipts SET source = 'pdf' WHERE source = 'manual_pdf';
