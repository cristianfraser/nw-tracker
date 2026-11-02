-- Ticket vendors as a person reads them: Toliv's charges come as «TOLIV MARKET», «MERPAGO*TOLIVMARKETSPA»
-- and «TUU*toliv», Ticketmaster's as «TICKET MASTER» and «TM *TICKETMASTERNZ». The row's link is the
-- event (the vendor's purchase mail, payment.processor_receipts). The rule keyed on the cut
-- «AI TICKETS (SEBA» moves to the vendor key the catalog now gives it.
UPDATE vendor_catalog SET display = 'PuntoTicket' WHERE source = 'seed' AND match_kind = 'prefix' AND pattern = 'PUNTO TICKET';

INSERT OR IGNORE INTO vendor_catalog (match_kind, pattern, display, source) VALUES
  ('prefix', 'TOLIV', 'Toliv', 'seed'),
  ('prefix', 'TICKET MASTER', 'Ticketmaster', 'seed'),
  ('prefix', 'TM *TICKETMASTER', 'Ticketmaster', 'seed'),
  ('prefix', 'AI TICKETS', 'AI Tickets', 'seed'),
  ('prefix', 'TICKETPLUS', 'Ticketplus', 'seed'),
  ('prefix', 'PAYLOGIC', 'Paylogic', 'seed');

INSERT OR IGNORE INTO expense_category_rules (vendor, link_kind, link_key, category_id)
SELECT 'AI TICKETS', link_kind, link_key, category_id FROM expense_category_rules WHERE vendor = 'AI TICKETS (SEBA';

DELETE FROM expense_category_rules WHERE vendor = 'AI TICKETS (SEBA'
