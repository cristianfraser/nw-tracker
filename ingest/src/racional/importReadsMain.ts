/**
 * Send the Racional reads `fetch:racional` staged to the server, one `broker.movements` each,
 * oldest first.
 *
 *   npm run import:racional-movements -w nw-tracker-ingest              # report only
 *   npm run import:racional-movements -w nw-tracker-ingest -- --apply   # write
 *
 * With --apply: a read whose list the server applied (no row it had to write and could not)
 * moves the crawl cursor to its first row, so the next crawl stops there; a read applied with
 * nothing left to fix moves, with the crawl's other files, to `imported/`. Anything else stays
 * staged and is sent again next run — one read never blocks the ones after it.
 *
 * Exit status: non-zero when a read cannot be decoded (an unmapped kind, a changed API shape) or
 * the server reports a problem (a blocked row, a ledger disagreement, a dividend with no ledger
 * row) — data errors that must reach the run's notification.
 */
import path from "node:path";
import { brokerMovementsKind, type BrokerMovementsApplyDetails } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { advanceRacionalCrawlCursor, readRacionalCrawlCursor } from "./crawlCursor.js";
import { archiveRacionalRead, decodeStagedRacionalRead, listStagedRacionalReads } from "./stagedReads.js";

const apply = process.argv.includes("--apply");

async function main(): Promise<number> {
  const reads = listStagedRacionalReads();
  if (reads.length === 0) {
    console.log("No staged Racional reads. Run: npm run fetch:racional");
    return 0;
  }
  const cursor = readRacionalCrawlCursor();
  console.log(cursor ? `Crawl cursor: ${cursor.last_row_key} (from ${cursor.read_file})` : "Crawl cursor: none — the next crawl reads the whole rendered list.");
  const client = ingestClient();
  let failed = 0;
  let cleanThrough: string | null = null;
  for (const read of reads) {
    const name = path.basename(read.movements_file ?? read.dividends_file!);
    let decoded;
    try {
      decoded = decodeStagedRacionalRead(read);
    } catch (err) {
      console.log(`\n${read.stamp}: NOT sent — ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
      continue;
    }
    let details: BrokerMovementsApplyDetails;
    try {
      const payload = brokerMovementsKind.payload.parse({
        broker: "racional",
        apply,
        read_at: read.read_at,
        movements: decoded.movements,
        dividends: decoded.dividends,
      });
      const result = await client.send(brokerMovementsKind, payload, { channel: "web_session", ref: name, fetched_at: read.read_at });
      details = result.details as BrokerMovementsApplyDetails;
    } catch (err) {
      console.log(`\n${read.stamp}: FAILED — ${describeIngestFailure(err)}`);
      return 1;
    }

    console.log(`\n${read.stamp}: ${decoded.movements?.length ?? "no"} listed movement(s), ${decoded.dividends?.length ?? "no"} API dividend(s)`);
    for (const m of details.movements) {
      const units = m.units ? ` · ${m.units} units` : "";
      console.log(`  ${m.occurred_on}  ${m.kind.padEnd(16)} ${String(m.amount).padStart(12)} ${m.currency}  ${m.legs}${units}  [${m.state}]${m.detail ? ` ${m.detail}` : ""}`);
    }
    for (const d of details.dividends) {
      console.log(
        `  ${d.chile_ymd}  ${d.asset_id.padEnd(8)} gross ${d.gross.toFixed(2)} − tax ${d.withholding.toFixed(2)} = net ${d.net.toFixed(2)} usd  ` +
          `[${d.state}${d.movement_id != null ? ` → movement ${d.movement_id}` : ""}]${d.detail ? ` ${d.detail}` : ""}`
      );
    }
    if (details.movements_blocked) console.log("  → the list was NOT imported: nothing from it is written and the cursor does not move past it");
    if (apply) console.log(`  → ${details.inserted} inserted, ${details.duplicates} already present, ${details.breakdowns_written} dividend breakdown(s) written`);
    for (const p of details.problems) console.log(`  PROBLEM: ${p}`);
    if (details.problems.length > 0) failed += 1;
    cleanThrough = details.clean_through;

    if (!apply) continue;
    if (decoded.movements != null && !details.movements_blocked && decoded.first_row_key && read.movements_file) {
      if (advanceRacionalCrawlCursor({ last_row_key: decoded.first_row_key, read_file: path.basename(read.movements_file) }, new Date().toISOString())) {
        console.log(`  → crawl cursor: ${decoded.first_row_key}`);
      }
    }
    if (details.problems.length === 0) console.log(`  → archived ${archiveRacionalRead(read).length} file(s) to imported/`);
  }
  console.log(
    `\n${apply ? "" : "Report only — nothing written. "}Notifications sent before ${cleanThrough ?? "(no clean read yet)"} are answered by a read.`
  );
  return failed > 0 ? 1 : 0;
}

process.exitCode = await main();
