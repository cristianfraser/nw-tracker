-- Dollar withdrawals a broker confirmed it will wire, and the banks' mails about the wires that
-- pay them. A request and the wire's notices are booked together (transfer + the broker's fee)
-- once both are in. See incomingWires.ts.

CREATE TABLE broker_withdrawal_requests (
  message_id TEXT PRIMARY KEY,
  broker TEXT NOT NULL CHECK (broker IN ('fintual')),
  requested_at TEXT NOT NULL,
  subject TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('usd')),
  gross_amount REAL NOT NULL CHECK (gross_amount > 0),
  net_amount REAL NOT NULL CHECK (net_amount > 0 AND net_amount <= gross_amount),
  destination_account TEXT NOT NULL,
  due_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE incoming_wire_notices (
  message_id TEXT PRIMARY KEY,
  bank TEXT NOT NULL,
  reported_by TEXT NOT NULL CHECK (reported_by IN ('sending_bank', 'receiving_bank')),
  sent_at_chile TEXT NOT NULL,
  subject TEXT NOT NULL,
  value_date TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('usd')),
  amount REAL NOT NULL CHECK (amount > 0),
  beneficiary_bank TEXT,
  beneficiary_account TEXT,
  beneficiary_name TEXT,
  ordering_name TEXT,
  ordering_account TEXT,
  ordering_bank TEXT,
  reference TEXT,
  remittance TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per booked request, kept when its movements are deleted so a mail never books twice.
CREATE TABLE incoming_wire_bookings (
  request_message_id TEXT PRIMARY KEY REFERENCES broker_withdrawal_requests(message_id),
  value_date TEXT NOT NULL,
  transfer_movement_id INTEGER REFERENCES movements(id) ON DELETE SET NULL,
  fee_movement_id INTEGER REFERENCES movements(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE incoming_wire_booking_notices (
  notice_message_id TEXT PRIMARY KEY REFERENCES incoming_wire_notices(message_id),
  request_message_id TEXT NOT NULL REFERENCES incoming_wire_bookings(request_message_id)
);
