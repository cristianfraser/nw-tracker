-- Header-only payments (current Santander CLP format): the previous facturación's MONTO
-- CANCELADO is captured as statement meta, never as a statement line. Store amount + the
-- printed payment date so the daily owed walk can synthesize the PAGO event.
ALTER TABLE cc_statements ADD COLUMN monto_pagado_anterior REAL;
ALTER TABLE cc_statements ADD COLUMN monto_pagado_anterior_date TEXT;
