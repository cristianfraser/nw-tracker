/**
 * One-off repair (2026-09-17): four `fund_unit_daily` bars of the Reserva serie
 * (`fintual_cert_reserva2`, Very Conservative Streep A) for 2026-09-17..20 were written as
 * Fintual's shares valuation ÷ the LEDGER's cuota count while a 100.000 retiro was in transit —
 * Fintual had already sold 68,9304 cuotas on 09-17 (paid 09-21), so the four bars read 1,63%
 * low (1.426,67 instead of ~1.450,72), failed the goals-NAV reconcile and kept the source stale.
 *
 * Correct value per day = the balance graph's `sharesValuationAmount` for that day ÷ Fintual's
 * own share count on the closure day (`ReserveShowData.sharesBreakdown[0].sharesQuantity` =
 * 4085,8409 as of 2026-09-20). The official public serie price confirms 09-17 the next morning
 * (`npm run fintual:backfill-cert-fund-units`).
 *
 *   npx tsx server/scripts/repair-fintual-reserva-share-count-rows.ts           # report
 *   npx tsx server/scripts/repair-fintual-reserva-share-count-rows.ts --apply   # write
 *
 * Refuses to touch a bar whose stored value is not the known-wrong one, so it cannot be re-run
 * destructively.
 */
import { db } from "../src/db.js";
import { FINTUAL_GQL_SHARES_PUBLISH_NOTE_PREFIX } from "../src/fintualFundUnitDaily.js";

const SERIES_KEY = "fintual_cert_reserva2";
const IMPORT_NOTES = "import:fintual|cert|key=reserva2";
const FINTUAL_SHARES = 4085.8409;
/** Graph `sharesValuationAmount` per day (2026-09-17 21:19 Chile) and the wrong stored bar. */
const ROWS: { day: string; valuationClp: number; wrongStoredClp: number }[] = [
  { day: "2026-09-17", valuationClp: 5_927_490, wrongStoredClp: 1426.6706 },
  { day: "2026-09-18", valuationClp: 5_927_460, wrongStoredClp: 1426.6634 },
  { day: "2026-09-19", valuationClp: 5_927_430, wrongStoredClp: 1426.6561 },
  { day: "2026-09-20", valuationClp: 5_927_401, wrongStoredClp: 1426.6492 },
];

const apply = process.argv.includes("--apply");
const stmtGet = db.prepare(
  `SELECT unit_value_clp, COALESCE(note, '') AS note FROM fund_unit_daily WHERE series_key = ? AND day = ?`
);
const stmtSet = db.prepare(
  `UPDATE fund_unit_daily SET unit_value_clp = ?, note = ? WHERE series_key = ? AND day = ?`
);
const note = `${FINTUAL_GQL_SHARES_PUBLISH_NOTE_PREFIX}|${IMPORT_NOTES}`;

const plan = ROWS.map((r) => {
  const stored = stmtGet.get(SERIES_KEY, r.day) as { unit_value_clp: number; note: string } | undefined;
  if (!stored) throw new Error(`${r.day}: no stored bar`);
  if (Math.abs(stored.unit_value_clp - r.wrongStoredClp) > 0.00005) {
    throw new Error(
      `${r.day}: stored ${stored.unit_value_clp} is not the known-wrong ${r.wrongStoredClp} — refusing (already repaired or restated)`
    );
  }
  const correct = Math.round((r.valuationClp / FINTUAL_SHARES) * 10000) / 10000;
  return { ...r, storedNote: stored.note, correct };
});

for (const p of plan) {
  console.log(
    `${p.day}: ${p.wrongStoredClp} (${p.storedNote}) → ${p.correct}  [${p.valuationClp} ÷ ${FINTUAL_SHARES}]`
  );
}
if (!apply) {
  console.log("[report] re-run with --apply to write.");
} else {
  db.transaction(() => {
    for (const p of plan) stmtSet.run(p.correct, note, SERIES_KEY, p.day);
  })();
  console.log(`Repaired ${plan.length} bar(s) (note ${note}).`);
}
