/**
 * Recovers the Risky Norris proxy's basket history from DB snapshots.
 *
 * Until migration 238 the sync kept only the latest basket (`watchlist_composite_holdings`,
 * rewritten nightly), so the only record of earlier baskets is the copy each snapshot took. Every
 * snapshot's holdings rows are keyed by `synced_at`, which the sync wrote as Fintual's positions
 * date, so each snapshot yields one (positions date → weights) basket. Baskets for the same
 * positions date must agree across snapshots (they do: the weights are Fintual's statement for
 * that day), and the ETF-sleeve weight sum comes from the sync log's note for that date (one
 * decimal) when there is one.
 *
 * Snapshots hold the PRICE tickers (`holdingsForPricing` ran before the write), so a recovered SPY
 * is Fintual's SPXS (the Invesco S&P 500 UCITS ETF, mapped to SPY for Yahoo pricing since
 * 2026-07-01); the fund never held a real SPY, so the recovered rows name SPXS again
 * (`PRICE_TICKER_TO_FINTUAL`). The history records Fintual's own tickers.
 *
 * Report-first; `--apply` writes the recovered baskets as `source = 'snapshot'` rows through the
 * same write-once path the sync uses. Snapshots are opened read-only and immutable through the
 * `sqlite3` CLI (better-sqlite3 cannot open a WAL snapshot read-only without a writable -shm).
 *
 *   npx tsx scripts/backfill-rn-composition-history.ts [--dir=<snapshots dir>]… [--apply]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../src/db.js";
import { RISKY_NORRIS_PROXY_BUCKET } from "../src/watchlistComposite.js";
import {
  compareCompositeHoldings,
  loadCompositePositions,
  recordCompositePositions,
  type CompositePositionHolding,
} from "../src/watchlistCompositeHistory.js";

const APPLY = process.argv.includes("--apply");
const dirArgs = process.argv.filter((a) => a.startsWith("--dir=")).map((a) => a.slice("--dir=".length));
const DIRS = dirArgs.length
  ? dirArgs
  : [
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "../data/snapshots"),
      path.join(os.homedir(), "Documents/backups/nw-tracker"),
    ];

type SnapshotRow = { composition_date: string; positions_date: string; ticker: string; weight: number };

/** Price ticker a snapshot stored → the Fintual ticker it stood for (inverse of `FINTUAL_TICKER_PRICE_PROXY`). */
const PRICE_TICKER_TO_FINTUAL: Readonly<Record<string, string>> = { SPY: "SPXS" };

function readSnapshotHoldings(file: string): SnapshotRow[] | null {
  const sql =
    `SELECT m.composition_date, h.synced_at AS positions_date, h.ticker, h.weight ` +
    `FROM watchlist_composite_meta m JOIN watchlist_composite_holdings h USING (bucket_slug) ` +
    `WHERE m.bucket_slug = '${RISKY_NORRIS_PROXY_BUCKET}'`;
  try {
    const out = execFileSync("sqlite3", ["-json", `file:${file}?mode=ro&immutable=1`, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() ? (JSON.parse(out) as SnapshotRow[]) : [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/.test(msg)) return null;
    throw new Error(`${path.basename(file)}: ${msg}`);
  }
}

/** The sync log's «N ETFs as of D (ETF sleeve X% normalized)» notes, latest figure per positions date. */
function sleeveSumsFromSyncLog(): Map<string, number | null> {
  const rows = db
    .prepare(
      `SELECT body FROM app_messages WHERE body LIKE '%Risky Norris composition: % ETFs as of%' ORDER BY id`
    )
    .all() as { body: string }[];
  const re = /Risky Norris composition: (\d+) ETFs as of (\d{4}-\d{2}-\d{2}) \(ETF sleeve ([\d.]+)% normalized\)/g;
  const out = new Map<string, number | null>();
  for (const { body } of rows) {
    for (const m of body.matchAll(re)) {
      const date = m[2];
      const sum = Number(m[3]) / 100;
      const prev = out.get(date);
      if (prev === undefined) out.set(date, sum);
      else if (prev != null && Math.abs(prev - sum) > 1e-9) out.set(date, null); // disagreeing log lines: store nothing
    }
  }
  return out;
}

function main(): void {
  const files: string[] = [];
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) {
      console.log(`(skip) ${dir}: no such directory`);
      continue;
    }
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".db")) files.push(path.join(dir, name));
    }
  }
  files.sort();
  console.log(`${files.length} snapshot file(s) in ${DIRS.length} dir(s)`);

  type Basket = { holdings: CompositePositionHolding[]; snapshots: string[]; composition_dates: Set<string> };
  const baskets = new Map<string, Basket>();
  let withTable = 0;
  const disagreements: string[] = [];
  for (const file of files) {
    const rows = readSnapshotHoldings(file);
    if (rows == null) continue;
    withTable++;
    if (!rows.length) continue;
    const byDate = new Map<string, SnapshotRow[]>();
    for (const r of rows) {
      const list = byDate.get(r.positions_date) ?? [];
      list.push(r);
      byDate.set(r.positions_date, list);
    }
    for (const [positionsDate, list] of byDate) {
      const holdings = list
        .map((r) => {
          const stored = r.ticker.trim().toUpperCase();
          return { ticker: PRICE_TICKER_TO_FINTUAL[stored] ?? stored, weight: r.weight };
        })
        .sort((a, b) => b.weight - a.weight || a.ticker.localeCompare(b.ticker));
      const existing = baskets.get(positionsDate);
      if (!existing) {
        baskets.set(positionsDate, {
          holdings,
          snapshots: [path.basename(file)],
          composition_dates: new Set(list.map((r) => r.composition_date)),
        });
        continue;
      }
      const diffs = compareCompositeHoldings(existing.holdings, holdings);
      if (diffs.length) {
        disagreements.push(
          `${positionsDate}: ${path.basename(file)} disagrees with ${existing.snapshots[0]} on ${diffs
            .map((d) => `${d.ticker} ${d.stored} vs ${d.stated}`)
            .join(", ")}`
        );
        continue;
      }
      existing.snapshots.push(path.basename(file));
      for (const r of list) existing.composition_dates.add(r.composition_date);
    }
  }
  console.log(`${withTable} snapshot(s) carry the composition tables; ${baskets.size} distinct positions date(s) recovered`);
  if (disagreements.length) {
    console.log(`\nDISAGREEMENTS between snapshots for one positions date (nothing written for these):`);
    for (const d of disagreements) console.log(`  ${d}`);
  }

  const sleeve = sleeveSumsFromSyncLog();
  const dates = [...baskets.keys()].sort();
  let previous: CompositePositionHolding[] | null = null;
  console.log(`\n${"positions".padEnd(11)} ${"snaps".padStart(5)} ${"sleeve".padStart(6)}  basket (changes vs the previous recovered date)`);
  for (const date of dates) {
    const b = baskets.get(date)!;
    const sum = sleeve.get(date);
    const prevSet = new Set((previous ?? []).map((h) => h.ticker));
    const currSet = new Set(b.holdings.map((h) => h.ticker));
    const entered = [...currSet].filter((t) => !prevSet.has(t));
    const left = [...prevSet].filter((t) => !currSet.has(t));
    const change = previous == null ? "(first)" : [...entered.map((t) => `+${t}`), ...left.map((t) => `−${t}`)].join(" ") || "same tickers";
    const stored = loadCompositePositions(RISKY_NORRIS_PROXY_BUCKET, date);
    const storedNote = stored
      ? compareCompositeHoldings(stored.holdings, b.holdings).length
        ? " [STORED ROW DIFFERS]"
        : ` [stored, ${stored.source}]`
      : "";
    console.log(
      `${date} ${String(b.snapshots.length).padStart(5)} ${sum == null ? "   —  " : (sum * 100).toFixed(1).padStart(5) + "%"}  ` +
        `${b.holdings.map((h) => `${h.ticker} ${(h.weight * 100).toFixed(1)}`).join(", ")}  ${change}${storedNote}`
    );
    previous = b.holdings;
  }

  const logDates = [...sleeve.keys()].sort();
  const unrecoverable = logDates.filter((d) => !baskets.has(d));
  const recoveredWithoutLog = dates.filter((d) => !sleeve.has(d));
  console.log(
    `\nSync log names ${logDates.length} positions date(s) (${logDates[0]} → ${logDates[logDates.length - 1]}); ` +
      `${unrecoverable.length} of them have no snapshot and cannot be recovered` +
      (unrecoverable.length ? `: ${unrecoverable.join(", ")}` : "")
  );
  if (recoveredWithoutLog.length) {
    console.log(`Recovered without a log line (sleeve sum unknown): ${recoveredWithoutLog.join(", ")}`);
  }

  if (!APPLY) {
    console.log(`\nReport only. Re-run with --apply to write ${dates.length} basket(s) as source = 'snapshot'.`);
    return;
  }
  const counts = { inserted: 0, unchanged: 0, conflict: 0 };
  db.transaction(() => {
    for (const date of dates) {
      const b = baskets.get(date)!;
      const r = recordCompositePositions({
        bucket_slug: RISKY_NORRIS_PROXY_BUCKET,
        positions_date: date,
        etf_weight_sum: sleeve.get(date) ?? null,
        source: "snapshot",
        holdings: b.holdings,
      });
      counts[r.status]++;
      if (r.status === "conflict") {
        console.log(`  CONFLICT ${date}: ${r.differences.map((d) => `${d.ticker} ${d.stored} vs ${d.stated}`).join(", ")}`);
      }
    }
  })();
  console.log(`\nApplied: ${counts.inserted} inserted, ${counts.unchanged} already stored, ${counts.conflict} conflict(s) left as stored.`);
}

main();
