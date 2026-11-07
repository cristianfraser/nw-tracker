/**
 * A broker's notice that it split a holder's shares (`broker.notifications` kind `stock_split`:
 * Racional's «SOXX tuvo una división de acciones», mailed before the ex-date's open with the
 * share counts before and after). It records the split (`equitySplits.ts`) — the earliest
 * source of one: Yahoo listed none for SOXX on its ex-date — once the counts check out:
 * - the ratio is after ÷ before, a whole N:1 or 1:N;
 * - the ledger holds, at that broker, exactly the "before" count the day before.
 * The ex-date is the Chile day the notice was sent. A notice already recorded (from any source,
 * within a week) is a duplicate.
 */
import { addDaysIso } from "nw-tracker-contracts";
import type { BrokerNotification, BrokerNotificationPlanRow } from "nw-tracker-contracts";
import { equityTickerForAccount } from "./accountEquityTicker.js";
import { invalidateMarketDataAggregations } from "./cacheRegistry.js";
import { brokerNotificationIsBookable, notificationChileYmd } from "./brokerNotifications.js";
import { equityBrokerHoldings } from "./equityBrokerHoldings.js";
import { equityQuoteCurrency } from "./equityQuote.js";
import { listEquitySplits, recordEquitySplit, splitRatio } from "./equitySplits.js";
import type { BrokerAdapter } from "./brokerAdapter.js";

/** A split within this many days of one on record is the same split (`recordEquitySplit`'s rule). */
const SAME_SPLIT_WINDOW_DAYS = 7;

/** Share counts print 8 decimals: they agree to this. */
const UNITS_EPS = 1e-6;

/** A whole N:1 (or 1:N) ratio that turns `before` shares into `after`, else null. */
export function wholeSplitRatio(before: number, after: number): { numerator: number; denominator: number } | null {
  if (!(before > 0) || !(after > 0)) return null;
  if (after > before) {
    const n = Math.round(after / before);
    return n >= 2 && Math.abs(before * n - after) <= UNITS_EPS ? { numerator: n, denominator: 1 } : null;
  }
  const d = Math.round(before / after);
  return d >= 2 && Math.abs(after * d - before) <= UNITS_EPS ? { numerator: 1, denominator: d } : null;
}

function row(n: BrokerNotification, state: string, detail: string, legs: string | null = null): BrokerNotificationPlanRow {
  return {
    occurred_on: notificationChileYmd(n),
    kind: n.kind,
    amount: 0,
    currency: "usd",
    legs,
    units: n.units_after ?? null,
    state,
    detail,
  };
}

/**
 * Plan (and with `apply`, record) every split notice of the adapter's broker. States: `new` (would record),
 * `split_recorded`, `duplicate`, `conflict` (the counts disagree with the ledger — nothing
 * recorded), `manual` (a notice the server cannot read as a whole split).
 */
export function applyBrokerSplitNotifications(
  adapter: BrokerAdapter,
  notifications: readonly BrokerNotification[],
  apply: boolean
): { rows: BrokerNotificationPlanRow[]; conflicts: string[] } {
  const rows: BrokerNotificationPlanRow[] = [];
  const conflicts: string[] = [];
  let recorded = false;
  for (const n of notifications) {
    if (n.kind !== "stock_split") continue;
    if (!brokerNotificationIsBookable(n)) {
      rows.push(row(n, "manual", "the notice states no share counts — record the split by hand"));
      continue;
    }
    const before = Number(n.units);
    const after = Number(n.units_after);
    const ratio = wholeSplitRatio(before, after);
    if (ratio == null) {
      rows.push(row(n, "manual", `${n.units} → ${n.units_after} shares is not a whole split — record it by hand`));
      continue;
    }
    const exDate = notificationChileYmd(n);
    const stock = adapter.equityAccountId(n.ticker!);
    const ticker = equityTickerForAccount(stock)!;
    const cash = adapter.cashAccountId(equityQuoteCurrency(ticker));
    const legs = `${stock}`;
    const near = listEquitySplits(ticker).find(
      (s) => Math.abs(Date.parse(s.ex_date) - Date.parse(exDate)) <= SAME_SPLIT_WINDOW_DAYS * 86_400_000
    );
    // Once recorded, the ledger's day-before count is the split's own check; held at the broker:
    const dayBefore = addDaysIso(near?.ex_date ?? exDate, -1);
    const held = equityBrokerHoldings(stock, dayBefore, null).find((h) => h.cash_account_id === cash)?.units ?? 0;
    if (Math.abs(held - before) > UNITS_EPS) {
      const msg = `${ticker} split on ${exDate}: the ledger holds ${held} shares at ${adapter.label} on ${dayBefore}, the notice says ${n.units}`;
      conflicts.push(msg);
      rows.push(row(n, "conflict", msg, legs));
      continue;
    }
    const what = `${ticker} ${ratio.numerator}:${ratio.denominator}, ${n.units} → ${n.units_after} shares`;
    if (near != null) {
      if (Math.abs(splitRatio(near) - ratio.numerator / ratio.denominator) > 1e-9) {
        const msg = `${ticker} split on ${exDate}: recorded ${near.numerator}:${near.denominator} on ${near.ex_date}, the notice says ${ratio.numerator}:${ratio.denominator}`;
        conflicts.push(msg);
        rows.push(row(n, "conflict", msg, legs));
        continue;
      }
      if (!apply) {
        rows.push(row(n, "duplicate", `${what} — recorded on ${near.ex_date} (${near.source})`, legs));
        continue;
      }
    }
    if (!apply) {
      rows.push(row(n, "new", what, legs));
      continue;
    }
    const out = recordEquitySplit({ ticker, ex_date: exDate, ...ratio, source: "broker" });
    const wrote = out.status === "recorded" || out.ledger.some((l) => l.status === "written");
    recorded ||= wrote;
    rows.push(
      row(
        n,
        out.status === "recorded" ? "split_recorded" : "duplicate",
        out.status === "recorded" ? `${what}; ${out.rescaled.closes} closes re-framed` : `${what} — recorded on ${out.split.ex_date} (${out.split.source})`,
        legs
      )
    );
  }
  if (recorded) invalidateMarketDataAggregations("historical");
  return { rows, conflicts };
}
