/**
 * Report-first repair of the mortgage cuota-mínima (min_uf) column in `depto_payments`.
 *
 * min_uf is the bank's scheduled French-amortization payment (interés + seguros + scheduled
 * amortización, EXCLUDING any prepago). It is a statement figure the app now takes as input
 * to split amortización from prepago — but historically it was either not saved (older manual
 * rows) or clobbered by the old scenario-formula fallback (the bug this repairs). The stored
 * amortización / interés / seguros for those rows are correct, so the real min is recoverable:
 *
 *   min_uf = round4( interés_uf + incendio_uf + desgravamen_uf + amortización_uf )
 *
 * with each leg = round4(clp / uf_día). Deducing this way is exact for a correctly-split row
 * and round-trips through recompute (which reads the stored prepago, not min).
 *
 * Categories:
 *   FILL   — stored min_uf is NULL → set to deduced.
 *   REPAIR — stored min_uf present but differs from deduced (formula-clobbered) → set to deduced.
 *   OK     — stored min_uf matches deduced within rounding → left untouched.
 *   SKIP   — amortización missing → cannot deduce (reported, never written).
 *
 * Rows with a real stored min (OK) double as a sanity check: deduced should land within a
 * rounding tick of the statement value. A large OK-band miss would surface here as REPAIR.
 *
 * Usage:
 *   npx tsx scripts/repair-mortgage-min-uf.ts            # report only
 *   npx tsx scripts/repair-mortgage-min-uf.ts --apply    # write FILL + REPAIR rows
 */
import { db } from "../src/db.js";
import { ufRowOnOrBefore } from "../src/fxRates.js";
import { roundUf4 } from "../src/mortgagePaymentAnalytics.js";
import { isDeptoMortgagePaymentCuota } from "../src/deptoDividendosLedger.js";

const APPLY = process.argv.includes("--apply");

/** min_uf within this many UF of the stored value counts as a match (no change). */
const MATCH_TOLERANCE_UF = 0.0011;

type Row = {
  cuota: string;
  occurred_on: string;
  min_uf: number | null;
  interes_clp: number | null;
  incendio_clp: number | null;
  desgravamen_clp: number | null;
  amortizacion_clp: number | null;
};

function clpToUf(clp: number, uf: number): number {
  return roundUf4(clp / uf);
}

function fmt(n: number | null, dp = 4): string {
  return n == null ? "—" : n.toFixed(dp);
}

function main(): void {
  // One representative row per (cuota, occurred_on) — the dividendos and mortgage rows carry
  // identical component values, so either one deduces the same min.
  const rows = db
    .prepare(
      `SELECT p.cuota, m.occurred_on, p.min_uf, p.interes_clp, p.incendio_clp,
              p.desgravamen_clp, p.amortizacion_clp
         FROM depto_payments p
         JOIN movements m ON m.id = p.movement_id
        WHERE p.kind = 'dividendos'
        ORDER BY m.occurred_on, p.cuota`
    )
    .all() as Row[];

  const fills: { row: Row; deduced: number }[] = [];
  const repairs: { row: Row; deduced: number; delta: number }[] = [];
  const oks: { row: Row; deduced: number; delta: number }[] = [];
  const skips: Row[] = [];

  for (const row of rows) {
    if (!isDeptoMortgagePaymentCuota(row.cuota)) continue; // pie / prepago have no scheduled min
    if (row.amortizacion_clp == null) {
      skips.push(row);
      continue;
    }
    const uf = ufRowOnOrBefore(row.occurred_on)?.clp_per_uf ?? null;
    if (uf == null || !Number.isFinite(uf) || uf <= 0) {
      skips.push(row);
      continue;
    }
    const deduced = roundUf4(
      clpToUf(row.interes_clp ?? 0, uf) +
        clpToUf(row.incendio_clp ?? 0, uf) +
        clpToUf(row.desgravamen_clp ?? 0, uf) +
        clpToUf(row.amortizacion_clp, uf)
    );
    if (row.min_uf == null) {
      fills.push({ row, deduced });
    } else {
      const delta = Math.abs(row.min_uf - deduced);
      if (delta <= MATCH_TOLERANCE_UF) oks.push({ row, deduced, delta });
      else repairs.push({ row, deduced, delta });
    }
  }

  console.log(`\nMortgage min_uf repair — ${APPLY ? "APPLY" : "REPORT ONLY"}\n`);
  console.log(
    `scanned ${rows.filter((r) => isDeptoMortgagePaymentCuota(r.cuota)).length} mortgage-payment cuotas: ` +
      `${fills.length} FILL, ${repairs.length} REPAIR, ${oks.length} OK, ${skips.length} SKIP\n`
  );

  if (oks.length > 0) {
    console.log("OK (stored min matches deduced — sanity check):");
    for (const { row, deduced, delta } of oks) {
      console.log(
        `  cuota ${row.cuota.padStart(3)} ${row.occurred_on}  stored ${fmt(row.min_uf)}  deduced ${fmt(deduced)}  Δ ${delta.toFixed(5)}`
      );
    }
    console.log("");
  }
  if (fills.length > 0) {
    console.log("FILL (stored NULL → deduced):");
    for (const { row, deduced } of fills) {
      console.log(`  cuota ${row.cuota.padStart(3)} ${row.occurred_on}  → ${fmt(deduced)}`);
    }
    console.log("");
  }
  if (repairs.length > 0) {
    console.log("REPAIR (stored present but wrong — likely formula-clobbered):");
    for (const { row, deduced, delta } of repairs) {
      console.log(
        `  cuota ${row.cuota.padStart(3)} ${row.occurred_on}  stored ${fmt(row.min_uf)}  → ${fmt(deduced)}  Δ ${delta.toFixed(5)}`
      );
    }
    console.log("");
  }
  if (skips.length > 0) {
    console.log("SKIP (no amortización or UF — not written):");
    for (const row of skips) {
      console.log(`  cuota ${row.cuota.padStart(3)} ${row.occurred_on}`);
    }
    console.log("");
  }

  const toWrite = [...fills, ...repairs];
  if (!APPLY) {
    console.log(`Dry run — re-run with --apply to write ${toWrite.length} row(s).\n`);
    return;
  }

  // Update BOTH the dividendos and mortgage depto_payments rows for each cuota/date, matching
  // recompute's write scope.
  const upd = db.prepare(
    `UPDATE depto_payments SET min_uf = @min_uf
       WHERE movement_id IN (
         SELECT p.movement_id FROM depto_payments p
           JOIN movements m ON m.id = p.movement_id
          WHERE p.cuota = @cuota AND m.occurred_on = @occurred_on
       )`
  );
  const tx = db.transaction(() => {
    let n = 0;
    for (const { row, deduced } of toWrite) {
      n += upd.run({ min_uf: deduced, cuota: row.cuota, occurred_on: row.occurred_on }).changes;
    }
    return n;
  });
  const changed = tx();
  console.log(`Applied: updated ${changed} depto_payments row(s) across ${toWrite.length} cuota(s).\n`);
}

main();
