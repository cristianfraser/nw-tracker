/**
 * Read live Fondo A valor cuota from [uno.cl](https://www.uno.cl/), upsert `fund_unit_daily` (`afp_uno_cuota_a`),
 * and upsert Chile-today AFP **spot** valuation = Σ cuotas × that price.
 *
 * Usage:
 *   npm run afp:uno:spot-from-website -w nw-tracker-server -- --account-id=NN --dry-run
 *   npm run afp:uno:spot-from-website -w nw-tracker-server -- --account-id=NN --apply
 */
import "../src/db.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { fetchUnoClFondoAValorCuota } from "../src/afpUnoWebsiteCuota.js";
import {
  AFP_UNO_CUOTA_SERIES_KEY,
  upsertAfpSpotValuationWithExplicitPx,
  upsertFundUnitDailyRow,
} from "../src/afpUnoValuation.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return undefined;
  return p.slice(name.length + 3);
}

async function main(): Promise<void> {
  const accountId = Number(arg("account-id"));
  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.error("Required: --account-id=NN");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry-run") || !process.argv.includes("--apply");
  const asOfOverride = arg("as-of");

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 45_000);
  let parsed;
  try {
    parsed = await fetchUnoClFondoAValorCuota({ signal: ac.signal });
  } finally {
    clearTimeout(t);
  }

  const chileToday = chileCalendarTodayYmd();
  const asOf = asOfOverride && /^\d{4}-\d{2}-\d{2}$/.test(asOfOverride) ? asOfOverride : chileToday;
  const fundUnitDay = parsed.quote_day_ymd ?? asOf;

  upsertFundUnitDailyRow({
    day: fundUnitDay,
    unit_value_clp: parsed.unit_value_clp,
    note: `uno.cl:homepage|Fondo-A|${parsed.raw_price_fragment}`,
    dryRun: dry,
  });

  const spot = upsertAfpSpotValuationWithExplicitPx({
    accountId,
    asOfYmd: asOf,
    px: parsed.unit_value_clp,
    dryRun: dry,
  });

  console.log(
    `${dry ? "[dry-run] " : ""}uno.cl\tpx=${parsed.unit_value_clp}\tfund_unit_day=${fundUnitDay}\tspot_as_of=${asOf}`
  );
  if (spot) {
    console.log(
      `${dry ? "[dry-run] " : ""}spot\tunits=${spot.units.toFixed(4)}\tvalue_clp=${spot.value_clp}`
    );
  } else {
    console.warn("Spot skipped (zero cuotas through as-of, or invalid px).");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
