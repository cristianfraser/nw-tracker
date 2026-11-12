import type {
  BrokerNotificationsApplyDetails,
  BrokerNotificationsPayload,
} from "nw-tracker-contracts";

import { brokerNotificationIsBookable, racionalFetchDecision } from "./brokerNotifications.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { applyFintualEmailMovementsWithIds, planFintualEmailBatch } from "./fintualEmailImport.js";
import { listOverdueUnconfirmedSyntheticRetiros } from "./fintualSyntheticRetiros.js";
import { applyRacionalEmailMovements, planRacionalEmailMovements } from "./racionalEmailImport.js";
import { brokerAdapter, brokerPlanRow, type BrokerSlug } from "./brokerAdapter.js";
import { brokerCleanThrough } from "./brokerReadCoverage.js";
import { bookIncomingWires, storeWithdrawalRequests, withdrawalRequestFromNotification } from "./incomingWires.js";
import { racionalComisionCrawlDue } from "./racionalMovementsImport.js";
import { recordMovementEventTime } from "./movementEventTimes.js";
import { applyBrokerSplitNotifications } from "./brokerSplitNotifications.js";
import { pesosOrDollars } from "./ingestCurrencies.js";

/**
 * `broker.notifications`: every money notification a broker sent, planned against the ledger
 * and written (a dry run is the ingest receiver's rollback) — the same plan and write the mail importers ran on the staged
 * scans. Re-sending the whole set is idempotent: what is already in the ledger plans as a
 * duplicate.
 */


/** Fintual: movements from mail, its dollar withdrawal requests and the wires that pay them. */
function applyFintualNotifications(payload: BrokerNotificationsPayload): BrokerNotificationsApplyDetails {
  const { broker, notifications } = payload;
  // A requested withdrawal is not a movement: it is kept until the wire's own mail arrives.
  const planned = planFintualEmailBatch(
    notifications.filter((n) => n.kind !== "withdrawal_requested" && n.kind !== "stock_split")
  );
  let eventTimesStamped = 0;
  const applied = applyFintualEmailMovementsWithIds(planned);
  const written = applied.written;
  // The mail's send time orders the movement within its day (`movement_event_times`): a
  // re-sent mail stamps the movement it matched too, and an existing stamp is kept.
  for (const [index, movementId] of applied.movement_ids.entries()) {
    if (movementId == null) continue;
    const source = planned[index]!.source;
    if (recordMovementEventTime(movementId, source.occurred_at, "broker_mail", source.message_id)) {
      eventTimesStamped += 1;
    }
  }
  const requests = notifications
    .filter((n) => n.kind === "withdrawal_requested" && brokerNotificationIsBookable(n))
    .map((n) => withdrawalRequestFromNotification(n, "fintual"));
  storeWithdrawalRequests(requests);
  const usdWithdrawals = bookIncomingWires();
  return {
    broker,
    planned: planned.map(brokerPlanRow),
    written,
    // Fintual sends no browser to fetch: an incomplete notification is for a human.
    incomplete: notifications
      .filter((n) => !brokerNotificationIsBookable(n))
      .map((n) => ({ occurred_at: n.occurred_at, kind: n.kind, subject: n.subject })),
    fetch: null,
    overdue_synthetic_retiros: listOverdueUnconfirmedSyntheticRetiros(chileCalendarTodayYmd()).map((o) => ({
      movement_id: o.movement_id,
      paid_on: o.paid_on,
      amount_clp: o.amount_clp,
      deadline: o.deadline ?? null,
    })),
    usd_withdrawals: usdWithdrawals,
    event_times_stamped: eventTimesStamped,
  };
}

/** Racional: movements from mail, split notices, and whether the crawl must open. */
function applyRacionalNotifications(payload: BrokerNotificationsPayload): BrokerNotificationsApplyDetails {
  const { broker, notifications } = payload;
  const planned = planRacionalEmailMovements(notifications);
  const written = applyRacionalEmailMovements(planned).inserted;
  // A split notice records the split itself (`brokerSplitNotifications.ts`), not a movement.
  const splits = applyBrokerSplitNotifications(brokerAdapter(broker), notifications, true);
  return {
    broker,
    planned: [...planned.map(brokerPlanRow), ...splits.rows],
    written,
    // A Racional notification the server cannot book is the crawl's to describe, not a human's.
    incomplete: [],
    fetch: racionalFetchDecision(
      notifications,
      brokerCleanThrough("racional"),
      racionalComisionCrawlDue()
    ),
    overdue_synthetic_retiros: [],
    usd_withdrawals: null,
  };
}

const NOTIFICATION_HANDLERS: Record<BrokerSlug, (payload: BrokerNotificationsPayload) => BrokerNotificationsApplyDetails> = {
  fintual: applyFintualNotifications,
  racional: applyRacionalNotifications,
};

export function applyBrokerNotifications(payload: BrokerNotificationsPayload): BrokerNotificationsApplyDetails {
  // The brokers' cash accounts are pesos and dollars.
  for (const n of payload.notifications) {
    if (n.currency != null) pesosOrDollars(n.currency, `broker.notifications (${payload.broker})`);
  }
  return NOTIFICATION_HANDLERS[payload.broker](payload);
}
