/**
 * Revalue AFP account from Σ `movements.units_delta` × `fund_unit_daily` (`afp_uno_cuota_a`), and upsert
 * Chile-today spot row (same pattern as Fintual apply).
 *
 * Run after: `afp:uno:cert-sync --apply` and either `afp:uno:fetch-cuotas --apply` or cert-derived fund units.
 *
 * Usage:
 *   npm run afp:uno:apply-valuation -w nw-tracker-server -- --account-id=NN --dry-run
 *   npm run afp:uno:apply-valuation -w nw-tracker-server -- --account-id=NN --apply
 *   npm run afp:uno:apply-valuation -w nw-tracker-server -- --account-id=NN --apply --preserve-excel-values
 *   npm run afp:uno:apply-valuation -w nw-tracker-server -- --account-id=NN --apply --no-spot
 */
import "../src/db.js";
import { revalueAfpAccountFromCuotas, upsertAfpSpotValuation } from "../src/afpUnoValuation.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!p) return undefined;
  return p.slice(name.length + 3);
}

function main(): void {
  const accountId = Number(arg("account-id"));
  if (!Number.isFinite(accountId) || accountId <= 0) {
    console.error("Required: --account-id=NN");
    process.exit(1);
  }
  const dry = !process.argv.includes("--apply");
  const noSpot = process.argv.includes("--no-spot");
  const preserveExcel = process.argv.includes("--preserve-excel-values");

  const { updated, skipped, lines } = revalueAfpAccountFromCuotas({
    accountId,
    dryRun: dry,
    preserveExcelValues: preserveExcel,
  });
  for (const ln of lines) console.log(ln);
  console.log(`Historical valuations: ${dry ? "[dry-run] " : ""}updated=${updated} skipped=${skipped}`);

  if (!noSpot) {
    const spot = upsertAfpSpotValuation({ accountId, dryRun: dry });
    if (spot) {
      console.log(
        `${dry ? "[dry-run] " : ""}spot\t${spot.as_of_date}\tunits=${spot.units.toFixed(4)}\tpx=${spot.px.toFixed(2)}\tvalue_clp=${spot.value_clp}`
      );
    } else {
      console.warn("Spot valuation skipped (no fund unit or zero cuotas).");
    }
  }
}

main();
