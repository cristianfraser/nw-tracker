import type { BrokerNotification } from "nw-tracker-contracts";
import { chileWallClockAt } from "./chileDate.js";

/**
 * Broker money notifications as the feeder sends them (`broker.notifications`): what the
 * notification stated, never what it means for the ledger. This module holds the two server
 * judgments on top — whether a notification states enough to book a movement, and whether a
 * Racional notification still needs the browser crawl to describe it.
 */

/** Fields each kind needs before it can be booked; without them a notification is a nudge. */
const REQUIRED_FIELDS: Record<BrokerNotification["kind"], (keyof BrokerNotification)[]> = {
  dividend: ["ticker", "amount"],
  buy: ["amount", "units"],
  wallet_funded: ["amount"],
  deposit: ["amount"],
  portfolio_buy: ["amount"],
  withdrawal_paid: ["amount"],
  cash_returned: ["amount"],
};

/**
 * Whether the notification states everything its movement needs. Racional's dividend mail
 * states only a gross figure (`gross_amount`, before the 15% US withholding it never credits),
 * so it is never bookable: the crawl reads the net from Racional's own dividends API.
 */
export function brokerNotificationIsBookable(n: BrokerNotification): boolean {
  return REQUIRED_FIELDS[n.kind].every((f) => n[f] != null && n[f] !== "");
}

/** The Chile calendar day a notification was sent — the day the broker booked the event. */
export function notificationChileYmd(n: BrokerNotification): string {
  return chileWallClockAt(new Date(n.occurred_at)).ymd;
}

export type RacionalFetchDecision = {
  needed: boolean;
  reasons: string[];
  /** Notifications that are not bookable (the crawl's to describe). */
  nudges: number;
  /** Nudges a clean crawl already answered. */
  answered: number;
};

/**
 * Whether the Racional browser must open: a nudge mailed after the last crawl imported with
 * nothing left to fix (`broker_read_coverage`), or the monthly portafolio comisión, which sends no mail.
 * Notifications are all re-sent every run, so without the coverage check one dividend mail
 * would ask for a crawl every night (it did, 2026-09-18 → 09-27).
 */
export function racionalFetchDecision(
  notifications: readonly BrokerNotification[],
  cleanCrawlAt: string | null,
  comision: { due: boolean; reason: string | null }
): RacionalFetchDecision {
  const nudges = notifications.filter((n) => !brokerNotificationIsBookable(n));
  const covered = cleanCrawlAt == null ? null : Date.parse(cleanCrawlAt);
  if (covered != null && Number.isNaN(covered)) throw new Error(`Racional clean_crawl_at "${cleanCrawlAt}" is not a timestamp`);
  const open = nudges.filter((n) => covered == null || Date.parse(n.occurred_at) >= covered);
  const reasons = open.map((n) => `${notificationChileYmd(n)} ${n.kind}: ${n.subject}`);
  if (comision.due && comision.reason) reasons.push(comision.reason);
  return { needed: reasons.length > 0, reasons, nudges: nudges.length, answered: nudges.length - open.length };
}
