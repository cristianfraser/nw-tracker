/**
 * Backfill AFP UNO Fondo A **historical valor cuota** into `fund_unit_daily` (`series_key = afp_uno_cuota_a`)
 * from ¿Qué tal mi AFP? in **chunks** (feeds market “rates” / `getMarketSeriesPayload` → `afp_uno_cuota_a`).
 *
 * Uses chunked requests so ranges that predate API coverage (empty windows) do not abort the run.
 *
 * Env: **QUETALMIAFP_APIKEY** = `X-API-Key` header value (or set in repo-root `.env`; this script loads it when unset).
 *
 * Usage:
 *   npm run afp:uno:backfill-quetalmiafp -w nw-tracker-server -- --dry-run
 *   npm run afp:uno:backfill-quetalmiafp -w nw-tracker-server -- --apply
 *   npm run afp:uno:backfill-quetalmiafp -w nw-tracker-server -- --from=2018-01-01 --to=2026-05-14 --chunk-days=120 --apply
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../src/db.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { backfillAfpUnoCuotaQuetalmiChunks } from "../src/afpUnoValuation.js";

/** Load `QUETALMIAFP_APIKEY` from repo-root `.env` when not already in the environment (npm run from `server/`). */
function loadQuetalmiKeyFromRootEnv(): void {
  if (process.env.QUETALMIAFP_APIKEY?.trim()) return;
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    if (k !== "QUETALMIAFP_APIKEY") continue;
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env.QUETALMIAFP_APIKEY = v;
    return;
  }
}

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return undefined;
  return p.slice(name.length + 3);
}

async function main(): Promise<void> {
  loadQuetalmiKeyFromRootEnv();
  const apiKey = process.env.QUETALMIAFP_APIKEY ?? "";
  if (!apiKey.trim()) {
    console.error("Set QUETALMIAFP_APIKEY for X-API-Key.");
    process.exit(1);
  }
  const fromIso = arg("from") ?? "2018-01-01";
  const toIso = arg("to") ?? chileCalendarTodayYmd();
  const chunkDays = Math.max(1, Number(arg("chunk-days") ?? "180") || 180);
  const delayMs = Math.max(0, Number(arg("delay-ms") ?? "250") || 250);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromIso) || !/^\d{4}-\d{2}-\d{2}$/.test(toIso)) {
    console.error("--from and --to must be YYYY-MM-DD");
    process.exit(1);
  }
  const dry = !process.argv.includes("--apply");
  if (dry) {
    console.warn(
      "afp:uno:backfill-quetalmiafp is running in dry-run mode (no DB writes). Pass --apply to persist rows."
    );
  }

  const stats = await backfillAfpUnoCuotaQuetalmiChunks({
    apiKey: apiKey.trim(),
    fromYmd: fromIso,
    toYmd: toIso,
    chunkDays,
    dryRun: dry,
    delayMs,
    onChunk: (a, b, n) => {
      const tag = n > 0 ? `${n} rows` : "empty";
      console.log(`${dry ? "[dry-run] " : ""}${a} … ${b}\t${tag}`);
    },
  });

  console.log(
    `${dry ? "[dry-run] " : ""}Done. chunks=${stats.chunks} emptyChunks=${stats.emptyChunks} totalRows=${stats.totalRows} (${fromIso} … ${toIso}, chunkDays=${chunkDays})`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
