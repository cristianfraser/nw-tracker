import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { db } from "./db.js";
import { loadEquityBrokerageCapitalSortFlows } from "./equityBrokerageCapitalFlows.js";
import { depositInflowEventUsd } from "./flowsDeposits.js";

function listDepositFlowAccountIds(): number[] {
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, g.slug AS bucket_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (a.import_key IS NULL OR a.import_key != ?)
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

function listBrokerageEquityMtmAccountIds(): number[] {
  return db
    .prepare(
      `SELECT id FROM accounts
       WHERE equity_ticker IS NOT NULL AND TRIM(equity_ticker) != ''
         AND COALESCE(exclude_from_group_totals, 0) = 0`
    )
    .all()
    .map((r) => (r as { id: number }).id);
}

/** Populate conversion warnings for Rates FX coverage banner. */
export function runFxConversionWarningScan(): void {
  const depositIds = listDepositFlowAccountIds();
  const eventsByAccount = loadMergedDepositInflowEvents(depositIds);
  for (const events of eventsByAccount.values()) {
    for (const e of events) {
      if (e.amt === 0 || !Number.isFinite(e.amt)) continue;
      depositInflowEventUsd(e);
    }
  }

  const mtmIds = listBrokerageEquityMtmAccountIds();
  loadEquityBrokerageCapitalSortFlows(mtmIds);
}
