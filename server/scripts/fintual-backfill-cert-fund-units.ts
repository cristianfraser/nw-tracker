/**
 * Reconcile `fund_unit_daily` for the Fintual cert v2 series against the OFFICIAL public serie
 * prices (`src/fintualPublicSeriePrice.ts`): fills days no poll wrote, replaces carry-forward
 * placeholders, corrects published bars beyond tolerance. Report-first — nothing is written
 * without `--apply`.
 *
 *   npm run fintual:backfill-cert-fund-units -w nw-tracker-server                        # last 14 days, report
 *   npm run fintual:backfill-cert-fund-units -w nw-tracker-server -- --from=2019-01-01   # full history, report
 *   npm run fintual:backfill-cert-fund-units -w nw-tracker-server -- --from=… --apply
 *   … -- --series=fintual_cert_reserva2,fintual_cert_apv_a                                # a subset
 *
 * Until 2026-09-14 this read `GET /api/real_assets/:id/days`; that endpoint now sits behind a
 * Bearer-JWT gateway the session cannot mint a token for.
 */
import { chileCalendarAddDays, chileCalendarTodayYmd } from "../src/chileDate.js";
import {
  FINTUAL_PUBLIC_SERIE_BY_SERIES_KEY,
  FINTUAL_PUBLIC_SERIE_VERIFY_WINDOW_DAYS,
  fintualSeriesLabel,
  verifyFintualSeriesAgainstOfficialPrices,
} from "../src/fintualPublicSeriePrice.js";

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}

const apply = process.argv.includes("--apply");
const today = chileCalendarTodayYmd();
const fromYmd = arg("from") ?? chileCalendarAddDays(today, -FINTUAL_PUBLIC_SERIE_VERIFY_WINDOW_DAYS);
const toYmd = arg("to") ?? today;
const seriesKeys = arg("series")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function main(): Promise<void> {
  for (const key of seriesKeys ?? []) {
    if (FINTUAL_PUBLIC_SERIE_BY_SERIES_KEY[key] == null) {
      throw new Error(`unknown series ${key}; known: ${Object.keys(FINTUAL_PUBLIC_SERIE_BY_SERIES_KEY).join(", ")}`);
    }
  }
  console.log(`[official-serie] ${fromYmd}..${toYmd} (${apply ? "APPLY" : "report only"})`);
  const results = await verifyFintualSeriesAgainstOfficialPrices({
    fromYmd,
    toYmd,
    dryRun: !apply,
    seriesKeys,
  });
  let written = 0;
  for (const r of results) {
    const by = { filled: 0, carry_replaced: 0, corrected: 0 };
    for (const row of r.rows) by[row.action] += 1;
    console.log(
      `${fintualSeriesLabel(r.seriesKey)} (${r.seriesKey}, serie ${r.serieId}): ${r.checked} official day(s), ` +
        `${r.agreed} agree, ${by.filled} to fill, ${by.carry_replaced} carries to replace, ${by.corrected} to CORRECT`
    );
    for (const row of r.rows) {
      const stored = row.storedClp != null ? `${row.storedClp} (${row.storedNote})` : "—";
      console.log(`   ${row.day}  ${row.action.padEnd(14)} stored ${stored} → official ${row.officialClp}`);
    }
    written += r.rows.length;
  }
  console.log(
    apply
      ? `Wrote ${written} fund_unit_daily row(s).`
      : `[report] ${written} row(s) would be written; re-run with --apply to write them.`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
