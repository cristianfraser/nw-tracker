/**
 * Fetch AFP Uno Fondo A “valor cuota” from ¿Qué tal mi AFP? and upsert `fund_unit_daily`
 * (`series_key = afp_uno_cuota_a`). For **today’s** published cuota when the API lags, use
 * `npm run afp:uno:fetch-cuota-website` or `npm run afp:uno:spot-from-website` ([uno.cl](https://www.uno.cl/)).
 *
 * Env: **QUETALMIAFP_APIKEY** = `X-API-Key` header value.
 *
 * For a **long** history (e.g. since 2018) use chunked backfill: `npm run afp:uno:backfill-quetalmiafp`.
 *
 * Usage:
 *   npm run afp:uno:fetch-cuotas -w nw-tracker-server -- --from=2025-01-01 --to=2026-05-14 --dry-run
 *   npm run afp:uno:fetch-cuotas -w nw-tracker-server -- --from=2025-01-01 --to=2026-05-14 --apply
 *
 * If the JSON shape changes, extend `extractFundUnitRowsFromQuetalmiJson` in `server/src/afpQuetalmiApi.ts`
 * (dry-run prints row count only after a successful parse).
 */
import "../src/db.js";
import { toDdMmYyyy } from "../src/afpQuetalmiApi.js";
import { upsertFundUnitsFromQuetalmiFetch } from "../src/afpUnoValuation.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return undefined;
  return p.slice(name.length + 3);
}

async function main(): Promise<void> {
  const apiKey = process.env.QUETALMIAFP_APIKEY ?? "";
  if (!apiKey.trim()) {
    console.error("Set QUETALMIAFP_APIKEY for X-API-Key.");
    process.exit(1);
  }
  const fromIso = arg("from") ?? "2024-01-01";
  const toIso = arg("to") ?? new Date().toISOString().slice(0, 10);
  const fi = toDdMmYyyy(fromIso);
  const ff = toDdMmYyyy(toIso);
  if (!fi || !ff) {
    console.error("--from and --to must be YYYY-MM-DD");
    process.exit(1);
  }
  const dry = !process.argv.includes("--apply");
  const { rows } = await upsertFundUnitsFromQuetalmiFetch({
    apiKey: apiKey.trim(),
    fechaInicialDdMmYyyy: fi,
    fechaFinalDdMmYyyy: ff,
    dryRun: dry,
  });
  console.log(`${dry ? "[dry-run] " : ""}Upserted ${rows} row(s) into fund_unit_daily (${fi} … ${ff}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
