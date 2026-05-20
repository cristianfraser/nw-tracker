/**
 * Print sample sync log bodies for review (no API calls, no DB writes).
 *
 *   npx tsx scripts/preview-sync-log.ts
 */
import { formatSyncLogBody, type SyncFieldChange, type SyncRunLogOptions } from "../src/syncRunLog.js";

function section(
  title: string,
  stale: string[],
  changes: SyncFieldChange[],
  opts?: SyncRunLogOptions
): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(title);
  console.log("=".repeat(60));
  console.log(formatSyncLogBody(stale, changes, opts));
}

section(
  "Typical evening run",
  ["afp_uno", "fintual", "equity_eod"],
  [
    {
      group: "afp",
      label: "AFP UNO",
      oldValue: "27943901",
      newValue: "28012845",
      oldDate: "2026-05-19",
      newDate: "2026-05-19",
    },
    {
      group: "sbif_usd",
      label: "SBIF USD",
      oldValue: "981.59",
      newValue: "982.14",
      oldDate: "2026-05-18",
      newDate: "2026-05-19",
    },
    {
      group: "fintual",
      label: "Risky Norris",
      oldValue: "15234567",
      newValue: "15310200",
      oldDate: "2026-05-19",
      newDate: "2026-05-19",
    },
    {
      group: "tickers",
      label: "SPY",
      oldValue: "733.73",
      newValue: "735.12",
      oldDate: "2026-05-16",
      newDate: "2026-05-19",
    },
    {
      group: "tickers",
      label: "VEA",
      oldValue: "68.99",
      newValue: "69.21",
      oldDate: "2026-05-16",
      newDate: "2026-05-19",
    },
    {
      group: "tickers",
      label: "BTC-USD",
      oldValue: "105420.50",
      newValue: "106100.00",
      oldDate: "2026-05-18",
      newDate: "2026-05-19",
    },
  ]
);

section("Fintual checked, no NAV change", ["fintual"], [], { fintualNoChange: true });

section("AFP only", ["afp_uno"], [
  {
    group: "afp",
    label: "AFP UNO",
    oldValue: "27943901",
    newValue: "28012845",
    oldDate: "2026-05-19",
    newDate: "2026-05-19",
  },
]);

section("Nothing changed", ["afp_uno", "fintual", "equity_eod"], []);

section("SBIF USD only", [], [
  {
    group: "sbif_usd",
    label: "SBIF USD",
    oldValue: "978.20",
    newValue: "981.59",
    oldDate: "2026-05-17",
    newDate: "2026-05-19",
  },
]);
