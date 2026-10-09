-- The moment a movement happened, when a source states it (a broker mail's send time, ISO UTC).
-- The ledger keeps dates only, and same-day order matters where a dollar withdrawal request falls
-- on a day with other events (usdCashCostLots.ts). Written by the broker.notifications apply and
-- never overwritten.

CREATE TABLE movement_event_times (
  movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('broker_mail')),
  message_id TEXT NOT NULL
);
