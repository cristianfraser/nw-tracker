/**
 * Record a stock split by hand (`src/equitySplits.ts`): the ticker's stored prices before the
 * ex-date are re-framed to post-split terms and every holder gets its `stock_split` row, in one
 * transaction. Report-first: without --apply it prints what it would write and rolls back.
 *
 *   npm run equity:record-split -w nw-tracker-server -- --ticker=SOXX --ex-date=2026-11-05 --ratio=3:1 [--apply]
 *
 * The running server picks the change up from the mark-input log; restart it only if a page
 * still shows the old frame.
 */
import { db } from "../src/db.js";
import { recordEquitySplit, type RecordEquitySplitResult } from "../src/equitySplits.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}

class Rollback extends Error {}

function main(): void {
  const ticker = arg("ticker");
  const exDate = arg("ex-date");
  const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(arg("ratio") ?? "");
  if (!ticker || !exDate || !ratio) {
    throw new Error("usage: --ticker=SOXX --ex-date=YYYY-MM-DD --ratio=3:1 [--apply]");
  }
  const apply = process.argv.includes("--apply");
  let out: RecordEquitySplitResult | null = null;
  try {
    db.transaction(() => {
      out = recordEquitySplit({
        ticker,
        ex_date: exDate,
        numerator: Number(ratio[1]),
        denominator: Number(ratio[2]),
        source: "manual",
      });
      if (!apply) throw new Rollback();
    })();
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const r = out as RecordEquitySplitResult | null;
  if (!r) throw new Error("nothing recorded");
  console.log(`${apply ? "" : "[report only] "}${r.split.ticker} ${r.split.numerator}:${r.split.denominator} on ${r.split.ex_date}: ${r.status}`);
  console.log(`  re-framed: ${r.rescaled.closes} closes, ${r.rescaled.dividends} dividends, ${r.rescaled.live_quotes} live quotes`);
  for (const l of r.ledger) {
    console.log(`  account ${l.account_id}: ${l.units_before} + ${l.units_added} shares (movement ${l.movement_id}, ${l.status})`);
  }
  if (!apply) console.log("Re-run with --apply to write.");
}

main();
