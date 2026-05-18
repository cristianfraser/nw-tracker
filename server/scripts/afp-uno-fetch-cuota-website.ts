/**
 * Fetch [uno.cl](https://www.uno.cl/) and print UNO Fondo A **current** valor cuota (CLP).
 * For historical `fund_unit_daily` rows, use `npm run afp:uno:fetch-cuotas` (¿Qué tal mi AFP?).
 *
 * Usage:
 *   npm run afp:uno:fetch-cuota-website -w nw-tracker-server
 *   npm run afp:uno:fetch-cuota-website -w nw-tracker-server -- --json
 */
import { fetchUnoClFondoAValorCuota } from "../src/afpUnoWebsiteCuota.js";

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 45_000);
  try {
    const r = await fetchUnoClFondoAValorCuota({ signal: ac.signal });
    if (json) {
      console.log(
        JSON.stringify({
          unit_value_clp: r.unit_value_clp,
          quote_day_ymd: r.quote_day_ymd,
          raw_price_fragment: r.raw_price_fragment,
          source: "https://www.uno.cl/",
        })
      );
    } else {
      console.log(
        `Fondo A\tvalor_cuota_clp=${r.unit_value_clp}\tquote_day=${r.quote_day_ymd ?? "?"}\t${r.raw_price_fragment}`
      );
    }
  } finally {
    clearTimeout(t);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
