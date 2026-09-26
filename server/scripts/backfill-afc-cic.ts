/**
 * Backfill the AFC Fondo de Cesantía (CIC) valor cuota — `fund_unit_daily` series `afc_cic` —
 * from the Superintendencia de Pensiones' yearly CSVs (one request per year, ~15 KB each,
 * history since 2002). Every row is upserted: the SP is the authority, so a stored value that
 * differs from the download is replaced and listed.
 *
 *   npm run backfill:afc-cic -w nw-tracker-server -- [--from-year=2016] [--to-year=2026] [--dry-run]
 *
 * Default from-year is the portfolio start year (`portfolioStartYmd`), to-year the current year.
 * The nightly `afc_cic` sync only re-reads the current (and, in January, the previous) year.
 */
import "../src/db.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { fetchSpCesantiaYear, latestAfcCicRow, upsertAfcCicRows } from "../src/afcCicSeries.js";
import { portfolioStartYmd } from "../src/portfolioStart.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry-run");
  const nowYear = chileWallClockNow().year;
  const fromYear = Number(arg("from-year") ?? portfolioStartYmd().slice(0, 4));
  const toYear = Number(arg("to-year") ?? nowYear);
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
    throw new Error(`invalid year range ${fromYear}..${toYear}`);
  }
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (let year = fromYear; year <= toYear; year++) {
    const rows = await fetchSpCesantiaYear(year);
    const r = upsertAfcCicRows(rows, { dryRun: dry, note: `sp:cesantia-csv|year=${year}` });
    inserted += r.inserted;
    updated += r.updated;
    unchanged += r.unchanged;
    console.log(
      `${dry ? "[dry-run] " : ""}${year}: ${rows.length} rows (${rows[0]?.day} … ${rows[rows.length - 1]?.day}) ` +
        `inserted=${r.inserted} updated=${r.updated} unchanged=${r.unchanged}`
    );
    for (const x of r.restated) console.log(`  restated ${x.day}: ${x.previous} → ${x.next}`);
    if (year < toYear) await new Promise((res) => setTimeout(res, 250));
  }
  const latest = latestAfcCicRow();
  console.log(
    `${dry ? "[dry-run] " : ""}afc_cic: inserted=${inserted} updated=${updated} unchanged=${unchanged}; latest row ${latest?.day ?? "—"} = ${latest?.unit_value_clp ?? "—"}`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
