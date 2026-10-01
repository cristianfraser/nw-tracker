import type {
  BrokerNotificationPlanRow,
  BrokerNotificationsApplyDetails,
  BrokerNotificationsPayload,
} from "nw-tracker-contracts";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { brokerNotificationIsBookable, racionalFetchDecision } from "./brokerNotifications.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  applyFintualEmailMovements,
  planFintualEmailBatch,
  type FintualPlannedMovement,
} from "./fintualEmailImport.js";
import { listOverdueUnconfirmedSyntheticRetiros } from "./fintualSyntheticRetiros.js";
import {
  applyRacionalEmailMovements,
  planRacionalEmailMovements,
  type RacionalEmailPlannedMovement,
} from "./racionalEmailImport.js";
import { brokerCleanThrough } from "./brokerReadCoverage.js";
import { racionalComisionCrawlDue } from "./racionalMovementsImport.js";

/**
 * `broker.notifications`: every money notification a broker sent, planned against the ledger
 * and (with `apply`) written — the same plan and write the mail importers ran on the staged
 * scans. Re-sending the whole set is idempotent: what is already in the ledger plans as a
 * duplicate.
 */

function legs(from: number | null, to: number | null): string | null {
  return from != null || to != null ? `${from ?? "?"} → ${to ?? "?"}` : null;
}

function fintualRow(p: FintualPlannedMovement): BrokerNotificationPlanRow {
  const state =
    p.duplicate_of != null
      ? "duplicate"
      : p.requires_manual != null
        ? "manual"
        : p.synthesized
          ? "synthesized"
          : p.promote_movement_id != null
            ? "promoted"
            : "new";
  const detail =
    p.duplicate_of != null
      ? `already in the ledger as movement ${p.duplicate_of}`
      : p.requires_manual ??
        (p.synthesized
          ? "synthesized from the mail; the bank's listing of the credit will dedupe as superseded_by_transfer"
          : p.promote_movement_id != null
            ? `checking credit ${p.promote_movement_id} becomes the transfer`
            : null);
  return {
    occurred_on: p.occurred_on,
    kind: p.source.kind,
    amount: p.amount,
    currency: p.currency,
    legs: legs(p.from_account_id, p.to_account_id),
    units: p.units_delta,
    state,
    detail,
  };
}

function racionalRow(p: RacionalEmailPlannedMovement): BrokerNotificationPlanRow {
  const state =
    p.duplicate_of != null
      ? "duplicate"
      : p.requires_manual != null
        ? "manual"
        : p.create_account
          ? "creates_account"
          : "new";
  const detail =
    p.duplicate_of != null
      ? `already in the ledger as movement ${p.duplicate_of}`
      : p.requires_manual ??
        (p.create_account
          ? `creates the ${p.create_account.ticker} position in ${p.create_account.bucket_slug}`
          : p.counter_amount != null
            ? `US$${p.counter_amount} counter leg`
            : null);
  return {
    occurred_on: p.occurred_on,
    kind: p.source.kind,
    amount: p.amount,
    currency: p.currency,
    legs: legs(p.from_account_id, p.to_account_id),
    units: p.units_delta,
    state,
    detail,
  };
}

function invalidateWritten(rows: readonly { from_account_id: number | null; to_account_id: number | null; occurred_on: string }[]): void {
  for (const p of rows) {
    for (const accountId of [p.from_account_id, p.to_account_id]) {
      if (accountId != null) invalidateAggregationForAccountDate(accountId, p.occurred_on);
    }
  }
}

export function applyBrokerNotifications(payload: BrokerNotificationsPayload): BrokerNotificationsApplyDetails {
  const { broker, apply, notifications } = payload;
  if (broker === "fintual") {
    const planned = planFintualEmailBatch(notifications);
    const writable = planned.filter((p) => p.duplicate_of == null && p.requires_manual == null);
    const written = apply ? applyFintualEmailMovements(planned) : 0;
    if (apply) invalidateWritten(writable);
    return {
      broker,
      applied: apply,
      planned: planned.map(fintualRow),
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
    };
  }
  const planned = planRacionalEmailMovements(notifications);
  const writable = planned.filter((p) => p.duplicate_of == null && p.requires_manual == null);
  const written = apply ? applyRacionalEmailMovements(planned).inserted : 0;
  if (apply) invalidateWritten(writable);
  return {
    broker,
    applied: apply,
    planned: planned.map(racionalRow),
    written,
    // A Racional notification the server cannot book is the crawl's to describe, not a human's.
    incomplete: [],
    fetch: racionalFetchDecision(
      notifications,
      brokerCleanThrough("racional"),
      racionalComisionCrawlDue()
    ),
    overdue_synthetic_retiros: [],
  };
}
