#!/usr/bin/env npx tsx
/**
 * Backfill `fx_daily_bid_ask` buy rates from brokerage `compra_usd` / `compra_usd_venta_clp` movements.
 * Sell leg: Yahoo mid on that date when below buy, else buy − 4 CLP (typical retail spread).
 *
 * Usage: npm run backfill:fx-bid-ask-from-movements -w nw-tracker-server [--dry-run]
 */

import { db } from "../src/db.js";
import { upsertFxBidAskRow, FX_BID_ASK_SPREAD_CLP, midClpPerUsdOnOrBefore } from "../src/fxBidAsk.js";

const DRY = process.argv.includes("--dry-run");

type MovRow = {
  occurred_on: string;
  amount_clp: number;
  amount_usd: number;
};

function inferSellClpPerUsd(date: string, buy: number): number {
  const mid = midClpPerUsdOnOrBefore(date);
  if (mid != null && mid > 0 && mid < buy) return mid;
  return Math.max(buy - FX_BID_ASK_SPREAD_CLP, buy * 0.995);
}

function main() {
  const rows = db
    .prepare(
      `SELECT occurred_on, amount_clp, amount_usd
       FROM movements
       WHERE flow_kind IN ('compra_usd_venta_clp', 'compra_usd')
         AND amount_clp > 0
         AND amount_usd IS NOT NULL
         AND ABS(amount_usd) > 0
         AND ABS(COALESCE(units_delta, 0)) < 1e-12
       ORDER BY occurred_on, id`
    )
    .all() as MovRow[];

  const byDate = new Map<string, { buy: number; n: number }>();
  for (const r of rows) {
    const buy = Math.abs(r.amount_clp) / Math.abs(r.amount_usd);
    if (!Number.isFinite(buy) || buy <= 0) continue;
    const cur = byDate.get(r.occurred_on);
    if (!cur) byDate.set(r.occurred_on, { buy, n: 1 });
    else {
      cur.buy = (cur.buy * cur.n + buy) / (cur.n + 1);
      cur.n += 1;
    }
  }

  let upserted = 0;
  for (const [date, { buy }] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sell = inferSellClpPerUsd(date, buy);
    if (!DRY) {
      upsertFxBidAskRow({
        date,
        buy_clp_per_usd: buy,
        sell_clp_per_usd: sell,
        source: "movement_compra_usd",
      });
    }
    upserted += 1;
    console.log(
      `${DRY ? "[dry-run] " : ""}${date} buy=${buy.toFixed(4)} sell=${sell.toFixed(4)}`
    );
  }

  console.log(`${DRY ? "[dry-run] " : ""}Done. ${upserted} fx_daily_bid_ask row(s).`);
}

main();
