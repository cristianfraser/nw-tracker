/**
 * Rebuild BTC/ETH month-end `valuations` from Σ coin units (cripto-sheet movements) × `equity_daily` × FX.
 *
 * Usage:
 *   npm run crypto:apply-valuation -w nw-tracker-server
 *   npm run crypto:apply-valuation -w nw-tracker-server -- --dry-run
 */
import { db } from "../src/db.js";
import { applyCryptoValuationsFromCoinHoldings } from "../src/cryptoValuation.js";

function accountIdForKey(key: string): number | undefined {
  const r = db
    .prepare(`SELECT id FROM accounts WHERE import_key = ?`)
    .get(`import:excel|key=${key}`) as { id: number } | undefined;
  return r?.id;
}

const dryRun = process.argv.includes("--dry-run");

const btcId = accountIdForKey("bitcoin");
const ethId = accountIdForKey("eth");

if (btcId == null && ethId == null) {
  console.error("No bitcoin/eth accounts found.");
  process.exit(1);
}

const result = applyCryptoValuationsFromCoinHoldings({
  btcAccountId: btcId,
  ethAccountId: ethId,
  dryRun,
});

console.log(
  dryRun ? "[dry-run] " : "",
  `crypto:apply-valuation → BTC ${result.btcRows} valuation rows, ETH ${result.ethRows} rows`
);
