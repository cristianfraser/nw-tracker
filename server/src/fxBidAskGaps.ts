import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { db } from "./db.js";
import {
  fxBidAskRowOnDate,
  inferBidAskFromMid,
  materializeInferredBidAskForDate,
  midClpPerUsdOnOrBefore,
  upsertFxBidAskRow,
  type FxBidAskRow,
} from "./fxBidAsk.js";

export type FxBidAskGapRow = {
  date: string;
  mid_clp_per_usd: number | null;
  buy_clp_per_usd: number | null;
  sell_clp_per_usd: number | null;
  source: string | null;
  suggested_buy: number | null;
  suggested_sell: number | null;
};

const TRUSTED_BID_ASK_SOURCES = new Set(["movement_compra_usd", "manual"]);

function listDepositFlowAccountIds(): number[] {
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, g.slug AS bucket_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (a.notes IS NULL OR a.notes != ?)
         AND COALESCE(a.exclude_from_group_totals, 0) = 0
         AND g.slug != 'individual_stocks'`
    )
    .all(NOTE_STOCKS_LEGACY) as { account_id: number; bucket_slug: string }[];
  return rows
    .filter((r) => {
      const group_slug = dashboardBucketForAssetGroupSlug(r.bucket_slug);
      return (
        group_slug != null &&
        ["real_estate", "cash_eqs", "brokerage", "retirement"].includes(group_slug)
      );
    })
    .map((r) => r.account_id);
}

/** Dates where CLP→USD directional conversion is needed (deposits without native USD). */
export function collectDirectionalFxPaymentDates(): string[] {
  const dates = new Set<string>();
  const ids = listDepositFlowAccountIds();
  if (ids.length === 0) return [];

  const eventsByAccount = loadMergedDepositInflowEvents(ids);
  for (const events of eventsByAccount.values()) {
    for (const e of events) {
      if (e.amt === 0 || !Number.isFinite(e.amt)) continue;
      if (e.amt_usd != null && Number.isFinite(e.amt_usd)) continue;
      dates.add(e.occurred_on);
    }
  }

  const expenseDates = db
    .prepare(
      `SELECT DISTINCT spent_on AS d FROM expense_entries WHERE amount_clp != 0
       UNION
       SELECT DISTINCT occurred_on AS d FROM movements
       WHERE flow_kind IN ('compra_usd', 'compra_usd_venta_clp') AND amount_clp > 0`
    )
    .all() as { d: string }[];
  for (const { d } of expenseDates) {
    if (d) dates.add(d);
  }

  return [...dates].sort();
}

function gapRowForDate(date: string): FxBidAskGapRow | null {
  const mid = midClpPerUsdOnOrBefore(date);
  const suggested = mid != null ? inferBidAskFromMid(mid) : null;
  const row = fxBidAskRowOnDate(date);

  if (!row) {
    if (mid == null) {
      return {
        date,
        mid_clp_per_usd: null,
        buy_clp_per_usd: null,
        sell_clp_per_usd: null,
        source: null,
        suggested_buy: null,
        suggested_sell: null,
      };
    }
    return {
      date,
      mid_clp_per_usd: mid,
      buy_clp_per_usd: null,
      sell_clp_per_usd: null,
      source: null,
      suggested_buy: suggested!.buy_clp_per_usd,
      suggested_sell: suggested!.sell_clp_per_usd,
    };
  }

  if (TRUSTED_BID_ASK_SOURCES.has(row.source)) return null;

  return {
    date,
    mid_clp_per_usd: mid,
    buy_clp_per_usd: row.buy_clp_per_usd,
    sell_clp_per_usd: row.sell_clp_per_usd,
    source: row.source,
    suggested_buy: suggested?.buy_clp_per_usd ?? row.buy_clp_per_usd,
    suggested_sell: suggested?.sell_clp_per_usd ?? row.sell_clp_per_usd,
  };
}

/** Materialize inferred rows for payment dates, then list gaps needing manual review. */
export function listFxBidAskGaps(opts?: { materialize?: boolean }): FxBidAskGapRow[] {
  const materialize = opts?.materialize !== false;
  const dates = collectDirectionalFxPaymentDates();
  const gaps: FxBidAskGapRow[] = [];

  for (const date of dates) {
    if (materialize) {
      const row = fxBidAskRowOnDate(date);
      if (!row || row.source === "mid_spread_inferred") {
        materializeInferredBidAskForDate(date);
      }
    }
    const gap = gapRowForDate(date);
    if (gap) gaps.push(gap);
  }

  return gaps.sort((a, b) => b.date.localeCompare(a.date));
}

export function upsertManualFxBidAskRow(
  date: string,
  buy_clp_per_usd: number,
  sell_clp_per_usd: number
): FxBidAskRow {
  const row: FxBidAskRow = {
    date,
    buy_clp_per_usd,
    sell_clp_per_usd,
    source: "manual",
  };
  upsertFxBidAskRow(row);
  return row;
}
