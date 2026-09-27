#!/usr/bin/env tsx
/**
 * Sync Risky Norris proxy ETF composition from Fintual inversiones API.
 *
 *   npm run sync:fintual-rn-composition -w nw-tracker-server
 */
import "./../src/db.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { syncRiskyNorrisComposition } from "../src/fintualRiskyNorrisComposition.js";

async function main(): Promise<void> {
  const cl = chileWallClockNow();
  const result = await syncRiskyNorrisComposition(cl);
  console.log(
    `Risky Norris composition synced: ${result.holdings_count} holdings as of ${result.positions_date}, anchored ${result.composition_date}`
  );
  console.log(`Tickers: ${result.tickers.join(", ")}`);
  console.log(
    `Anchor cuota: ${result.anchor_fund_unit_clp} CLP` +
      (result.anchor_apv_fund_unit_clp != null ? ` (APV ${result.anchor_apv_fund_unit_clp})` : "")
  );
  if ("error" in result.official_refresh) {
    console.log(`Official serie refresh FAILED: ${result.official_refresh.error}`);
  } else {
    for (const r of result.official_refresh.results) {
      for (const row of r.rows) console.log(`Official serie ${r.seriesKey} ${row.day}: ${row.action} ${row.officialClp}`);
    }
  }
  const check = result.self_check;
  if (check != null) {
    console.log(
      `Self-check: the ${check.previous_anchor_ymd} anchor predicted ${check.predicted_clp.toFixed(4)} for ${check.anchor_ymd}, ` +
        `official ${check.official_clp} (${check.error_bp >= 0 ? "+" : ""}${check.error_bp.toFixed(1)} bp)${check.alarm ? " — ALARM" : ""}`
    );
  } else if (result.self_check_error) {
    console.log(`Self-check unavailable: ${result.self_check_error}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
