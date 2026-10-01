import type { BrokerMovement } from "nw-tracker-contracts";

/**
 * Canonical `broker.movements` rows for server tests, as ingest decodes a crawl's list (server
 * tests never import ingest's decoder). Unstated fields are null; `occurred_at` defaults to
 * midnight of `occurred_on` and the id to the stand-in a row without one gets.
 */
export function brokerMovement(
  m: Pick<BrokerMovement, "kind" | "title" | "occurred_on" | "amount" | "currency"> & Partial<BrokerMovement>
): BrokerMovement {
  return {
    movement_id: `${m.occurred_on}|${m.kind}|${m.amount}`,
    ticker: null,
    occurred_at: `${m.occurred_on}T00:00:00.000Z`,
    units: null,
    price: null,
    commission: null,
    order_id: null,
    dividend: null,
    incomplete: null,
    ...m,
  };
}
