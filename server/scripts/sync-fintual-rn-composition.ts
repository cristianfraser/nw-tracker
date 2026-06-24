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
    `Risky Norris composition synced: ${result.holdings_count} holdings as of ${result.composition_date}`
  );
  console.log(`Tickers: ${result.tickers.join(", ")}`);
  console.log(`Anchor cuota: ${result.anchor_fund_unit_clp} CLP`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
