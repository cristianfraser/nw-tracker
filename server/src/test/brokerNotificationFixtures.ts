import type { BrokerNotification } from "nw-tracker-contracts";

/**
 * Canonical `broker.notifications` rows for server tests, as ingest would send them after
 * reading the mail (server tests never import ingest's classifier). Every field the
 * notification does not state is null; message ids are unique per call unless given.
 */
let seq = 0;

export function brokerNotification(
  n: Pick<BrokerNotification, "kind" | "subject" | "occurred_at"> & Partial<BrokerNotification>
): BrokerNotification {
  seq += 1;
  return {
    message_id: `<vitest-broker-${seq}-${Date.now()}@test>`,
    ticker: null,
    fund_name: null,
    goal_name: null,
    amount: null,
    gross_amount: null,
    currency: null,
    units: null,
    price: null,
    clp_amount: null,
    paid_to: null,
    ...n,
    occurred_at: new Date(n.occurred_at).toISOString(),
  };
}

/** «Pagamos tu retiro de 🏦 <goal>» paid to the bank, with the cuotas the body printed (or none). */
export function fintualRetiroPaid(o: {
  goal: string;
  amount_clp: number;
  units: string | null;
  at: string;
  message_id?: string;
  paid_to?: BrokerNotification["paid_to"];
}): BrokerNotification {
  return brokerNotification({
    kind: "withdrawal_paid",
    subject: `Pagamos tu retiro de 🏦 ${o.goal}`,
    occurred_at: o.at,
    goal_name: o.goal,
    amount: o.amount_clp,
    currency: "clp",
    units: o.units,
    paid_to: o.paid_to ?? "bank",
    ...(o.message_id ? { message_id: o.message_id } : {}),
  });
}
