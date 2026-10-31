/**
 * Read Fintual's dollar wallet cash interest from the site and send it to the server as one
 * `broker.movements` (broker `fintual`); the server books each credit the ledger lacks on
 * Fintual USD. Runs every hourly poll and every night: the credit lands the evening it posts.
 *
 *   npm run import:fintual-wallet              # report only
 *   npm run import:fintual-wallet -- --apply   # write
 *
 * Exit status: non-zero when Fintual's answer cannot be read (an expired cookie, a changed shape),
 * the server is unreachable, or the ledger disagrees with a credit.
 */
import { brokerMovementsKind, type BrokerMovementsApplyDetails } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { fetchFintualCashInterests } from "./walletInterest.js";

const apply = process.argv.includes("--apply");

async function main(): Promise<number> {
  const readAt = new Date().toISOString();
  let movements;
  try {
    movements = await fetchFintualCashInterests();
  } catch (err) {
    console.log(`Fintual wallet NOT read — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let details: BrokerMovementsApplyDetails;
  try {
    const payload = brokerMovementsKind.payload.parse({ broker: "fintual", apply, read_at: readAt, movements, dividends: null });
    const result = await ingestClient().send(brokerMovementsKind, payload, { channel: "web_session", ref: `fintual-wallet-${readAt}`, fetched_at: readAt });
    details = result.details as BrokerMovementsApplyDetails;
  } catch (err) {
    console.log(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
  console.log(`Fintual wallet: ${movements.length} cash interest credit(s)`);
  for (const m of details.movements) {
    console.log(`  ${m.occurred_on}  interest ${m.amount.toFixed(2).padStart(8)} usd  [${m.state}]${m.detail ? ` ${m.detail}` : ""}`);
  }
  console.log(apply ? `  → ${details.inserted} inserted, ${details.duplicates} already present` : "Report only — nothing written.");
  for (const p of details.problems) console.log(`  PROBLEM: ${p}`);
  return details.problems.length > 0 ? 1 : 0;
}

process.exitCode = await main();
