-- payment.processor_receipts: the event a ticket receipt is for (PuntoTicket, Toliv, Ticketmaster,
-- Paylogic, AI Tickets, Ticketplus): its name, first day and time, last day, venue.
ALTER TABLE payment_processor_receipts ADD COLUMN event_name TEXT;
ALTER TABLE payment_processor_receipts ADD COLUMN event_starts_on TEXT;
ALTER TABLE payment_processor_receipts ADD COLUMN event_starts_at TEXT;
ALTER TABLE payment_processor_receipts ADD COLUMN event_ends_on TEXT;
ALTER TABLE payment_processor_receipts ADD COLUMN event_venue TEXT
