-- A merchant's own records of what card charges bought (`merchant.purchase_document`): App Store
-- receipts and subscription notices. The card statement names only «APPLE.COM/BILL»; these name
-- the app, which the expense-note matcher (merchantExpenseNotes.ts) writes onto the charge.
-- One source = one mail; its payload is kept verbatim to tell a resend from a conflicting copy.
CREATE TABLE merchant_document_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant TEXT NOT NULL,
  source_ref TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE merchant_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES merchant_document_sources(id) ON DELETE CASCADE,
  merchant TEXT NOT NULL,
  issued_on TEXT NOT NULL,
  order_id TEXT,
  card_last4 TEXT,
  total_amount REAL NOT NULL CHECK (total_amount > 0),
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd'))
);
CREATE INDEX merchant_receipts_merchant_issued ON merchant_receipts (merchant, issued_on);

CREATE TABLE merchant_receipt_items (
  receipt_id INTEGER NOT NULL REFERENCES merchant_receipts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  app TEXT,
  product TEXT,
  amount REAL NOT NULL CHECK (amount > 0),
  renews INTEGER NOT NULL CHECK (renews IN (0, 1)),
  period TEXT CHECK (period IN ('day', 'week', 'month', 'quarter', 'half_year', 'year')),
  icon_url TEXT,
  PRIMARY KEY (receipt_id, position),
  CHECK (app IS NOT NULL OR product IS NOT NULL)
);

CREATE TABLE merchant_subscription_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES merchant_document_sources(id) ON DELETE CASCADE,
  merchant TEXT NOT NULL,
  notice TEXT NOT NULL CHECK (notice IN ('confirmed', 'renewal', 'expiring', 'price_increase')),
  mailed_on TEXT NOT NULL,
  app TEXT NOT NULL,
  plan TEXT,
  price REAL NOT NULL CHECK (price > 0),
  currency TEXT NOT NULL CHECK (currency IN ('clp', 'usd')),
  period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month', 'quarter', 'half_year', 'year')),
  purchased_on TEXT,
  next_charge_on TEXT,
  expires_on TEXT,
  card_last4 TEXT
);
CREATE INDEX merchant_subscription_notices_merchant ON merchant_subscription_notices (merchant, app);
