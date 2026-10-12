/**
 * Loads the Risky Norris basket history from the CMF's monthly portfolio files.
 *
 * The regulator publishes every mutual fund's foreign-securities portfolio each month
 * (`cmfFundPortfolio.ts`); Risky Norris is RUN 9570. Each file gives the fund's foreign ETF sleeve
 * on the month's last day, which this script records in `watchlist_composite_positions` as a
 * `cmf` basket (weights renormalized to the sleeve, `etf_weight_sum` = the sleeve's share of fund
 * assets) — the only record of the basket before the evening sync existed (2026-06).
 *
 * Files are read from `cfraser/cmf-ffm-cartera/FFM_INV_EXTR_YYYYMM.txt`; `--fetch` downloads
 * the months missing on disk (from the fund's first month, 2018-02, through the latest month the
 * CMF has published) before reading. Report-first; `--apply` writes. A positions date the history
 * already holds from Fintual (sync / snapshot) is left alone and listed: Fintual's own statement
 * for that day wins over the regulator's month-end.
 *
 *   npx tsx scripts/import-cmf-rn-composition.ts [--fetch] [--from=YYYYMM] [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import { cmfBasketForFund, cmfPeriodEndIso, parseCmfForeignPortfolio } from "../src/cmfFundPortfolio.js";
import { RISKY_NORRIS_PROXY_BUCKET } from "../src/watchlistComposite.js";
import {
  compareCompositeHoldings,
  loadCompositePositions,
  recordCompositePositions,
} from "../src/watchlistCompositeHistory.js";

/** Risky Norris's RUN at the CMF (public: the fund's registry number). */
const RISKY_NORRIS_CMF_RUN = 9570;
const FIRST_PERIOD = "201802";
const CMF_DOWNLOAD_URL = "https://www.cmfchile.cl/institucional/estadisticas/ffm_download.php";

const APPLY = process.argv.includes("--apply");
const FETCH = process.argv.includes("--fetch");
const fromArg = process.argv.find((a) => a.startsWith("--from="))?.slice("--from=".length);
const FROM = fromArg ?? FIRST_PERIOD;
const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../cfraser/cmf-ffm-cartera");

function periodsFrom(from: string): string[] {
  const now = new Date();
  // The CMF publishes a month a few weeks after it ends; the previous month is the latest to try.
  const lastYear = now.getUTCFullYear();
  const lastMonth = now.getUTCMonth(); // 0-based → previous month as 1-based
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(4, 6));
  while (y < lastYear || (y === lastYear && m <= lastMonth)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

async function fetchPeriod(period: string, file: string): Promise<boolean> {
  const body = new URLSearchParams({
    mm: period.slice(4, 6),
    aa: period.slice(0, 4),
    cartera: "EXTR",
    btnConsulta: "GENERAR ARCHIVO",
  });
  const res = await fetch(CMF_DOWNLOAD_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0" },
    body,
  });
  if (!res.ok) throw new Error(`CMF ${period}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.startsWith("Run Fondo;")) {
    // A month not published yet answers with a short non-file body; leave nothing on disk.
    return false;
  }
  fs.writeFileSync(file, text);
  return true;
}

async function main(): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  const periods = periodsFrom(FROM);
  const missing: string[] = [];
  for (const period of periods) {
    const file = path.join(DIR, `FFM_INV_EXTR_${period}.txt`);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) continue;
    if (!FETCH) {
      missing.push(period);
      continue;
    }
    const ok = await fetchPeriod(period, file);
    console.log(`${period}: ${ok ? "downloaded" : "not published yet"}`);
    if (!ok) missing.push(period);
  }
  if (missing.length) console.log(`Not on disk: ${missing.join(", ")}${FETCH ? "" : " (run with --fetch)"}`);

  type Planned = { period: string; date: string; sum: number; holdings: { ticker: string; weight: number }[] };
  const planned: Planned[] = [];
  const noHoldings: string[] = [];
  for (const period of periods) {
    const file = path.join(DIR, `FFM_INV_EXTR_${period}.txt`);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) continue;
    const rows = parseCmfForeignPortfolio(fs.readFileSync(file, "utf8"), RISKY_NORRIS_CMF_RUN);
    if (!rows.length) {
      noHoldings.push(period);
      continue;
    }
    const basket = cmfBasketForFund(rows, RISKY_NORRIS_CMF_RUN);
    planned.push({ period, date: cmfPeriodEndIso(period), sum: basket.etf_weight_sum, holdings: basket.holdings });
  }
  if (noHoldings.length) console.log(`Months with no Risky Norris foreign holdings: ${noHoldings.join(", ")}`);

  let previous: Set<string> | null = null;
  const counts = { insert: 0, unchanged: 0, fintual: 0, conflict: 0 };
  console.log(`\n${"month-end".padEnd(11)} ${"sleeve".padStart(6)}  basket (share of the sleeve; changes vs the previous month)`);
  for (const p of planned) {
    const curr = new Set(p.holdings.map((h) => h.ticker));
    const change =
      previous == null
        ? "(first)"
        : [...[...curr].filter((t) => !previous!.has(t)).map((t) => `+${t}`), ...[...previous].filter((t) => !curr.has(t)).map((t) => `−${t}`)].join(" ") ||
          "same tickers";
    const stored = loadCompositePositions(RISKY_NORRIS_PROXY_BUCKET, p.date);
    let verdict: string;
    if (!stored) {
      verdict = "→ insert";
      counts.insert++;
    } else if (stored.source !== "cmf") {
      verdict = `kept (${stored.source} row from Fintual)`;
      counts.fintual++;
    } else if (compareCompositeHoldings(stored.holdings, p.holdings).length) {
      verdict = "CONFLICT with the stored cmf row";
      counts.conflict++;
    } else {
      verdict = "stored";
      counts.unchanged++;
    }
    console.log(
      `${p.date} ${(p.sum * 100).toFixed(1).padStart(5)}%  ${p.holdings.map((h) => `${h.ticker} ${(h.weight * 100).toFixed(1)}`).join(", ")}  [${change}]  ${verdict}`
    );
    previous = curr;
  }
  console.log(
    `\n${planned.length} month(s) read: ${counts.insert} to insert, ${counts.unchanged} already stored, ${counts.fintual} dated like a Fintual row (kept), ${counts.conflict} conflict(s).`
  );
  if (!APPLY) {
    console.log("Report only. Re-run with --apply to write.");
    return;
  }
  let inserted = 0;
  db.transaction(() => {
    for (const p of planned) {
      const stored = loadCompositePositions(RISKY_NORRIS_PROXY_BUCKET, p.date);
      if (stored) continue;
      const r = recordCompositePositions({
        bucket_slug: RISKY_NORRIS_PROXY_BUCKET,
        positions_date: p.date,
        etf_weight_sum: p.sum,
        source: "cmf",
        holdings: p.holdings,
      });
      if (r.status === "inserted") inserted++;
    }
  })();
  console.log(`Applied: ${inserted} cmf basket(s) written.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
