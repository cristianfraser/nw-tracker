-- A card's facturado paid with purchases on another card (`cc_facturado_financing_links`, its
-- one-shot charges and its `finances_facturado` plans) is one `pago_tarjeta` transfer per part:
-- paying card master → paid card master (`cardToCardPayments.ts`, derived state). This table ties
-- each transfer to the part it records: `part_ref` is the charge's flow id for a one-shot charge
-- (charges are recorded by flow), the `cc_installment_purchases.id` for a plan. The hook adds the
-- write-log triggers and the trigger that deletes the transfer when its row goes (a link deleted).
CREATE TABLE IF NOT EXISTS card_to_card_payments (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  financing_link_id INTEGER NOT NULL REFERENCES cc_facturado_financing_links(id) ON DELETE CASCADE,
  part_kind TEXT NOT NULL CHECK (part_kind IN ('charge', 'plan')),
  part_ref INTEGER NOT NULL,
  UNIQUE (financing_link_id, part_kind, part_ref)
);
