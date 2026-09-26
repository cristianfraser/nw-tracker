/**
 * Rebuild / reconcile the AFC cuota ledger from the AFC documents (see `afcCertImport.ts`).
 *
 *   npm run import:afc-cert -w nw-tracker-server -- --cert=<certificado de cotizaciones.pdf> \
 *       [--cartola=<estado cuatrimestral.pdf> …] [--replace-excel-rows] [--drop-ids=1,2] [--apply]
 *
 * Steps, in one transaction: (1) certificate contributions (insert / update units / mismatch),
 * optionally deleting the excel-era contribution rows the certificate supersedes and the extra
 * ids listed; (2) units on every withdrawal (pay-date valor cuota, or the closing −Σ when the
 * account's stored valuation reads 0 right after); (3) one true-up per cartola boundary. Without
 * `--apply` the whole transaction is ROLLED BACK after printing, so the report shows the exact
 * post-import ledger, including the checks below, and writes nothing.
 */
import { db } from "../src/db.js";
import { AFC_CIC_SERIES_KEY } from "../src/afcCicSeries.js";
import {
  applyAfcCartolaTrueUps,
  applyAfcCertImport,
  applyAfcWithdrawalUnits,
  parseAfcCartola,
  parseAfcCotizacionesCertificate,
  pdfTextLayout,
  planAfcCartolaTrueUps,
  planAfcCertImport,
  planAfcWithdrawalUnits,
} from "../src/afcCertImport.js";
import { afpCuotasCumulativeThroughDate } from "../src/afpUnoValuation.js";
import { fundUnitClpOnOrBefore } from "../src/fundUnitDaily.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}
function args(name: string): string[] {
  return process.argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
}
function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US"); // convention-ok: script stdout
}

class Rollback extends Error {}

function resolveAccountId(): number {
  const explicit = arg("account-id");
  if (explicit != null) return Number(explicit);
  const rows = db.prepare(`SELECT id FROM accounts WHERE fund_series_key = ? ORDER BY id`).all(AFC_CIC_SERIES_KEY) as { id: number }[];
  if (rows.length !== 1) throw new Error(`expected one account on ${AFC_CIC_SERIES_KEY}, found ${rows.length}; pass --account-id=NN`);
  return rows[0]!.id;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const replaceExcel = process.argv.includes("--replace-excel-rows");
  const dropIds = (arg("drop-ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const certPath = arg("cert");
  if (!certPath) throw new Error("--cert=<pdf> is required");
  const cartolaPaths = args("cartola");
  const accountId = resolveAccountId();

  const cert = parseAfcCotizacionesCertificate(pdfTextLayout(certPath));
  console.log(`Certificado de cotizaciones: ${cert.legs.length} legs, total ${fmt(cert.total_clp)} CLP`);

  try {
    db.transaction(() => {
      // 1. contributions
      const plan = planAfcCertImport(accountId, cert);
      const counts = { insert: 0, unchanged: 0, update_units: 0, mismatch: 0 };
      console.log(`\n[1] Contributions — account ${accountId}, series ${plan.series_key}`);
      console.log("status         período  pago         pesos       px       cuotas  employer");
      for (const it of plan.items) {
        counts[it.status] += 1;
        const c = it.contribution;
        console.log(
          `${it.status.padEnd(14)} ${c.period_ym}  ${c.pay_ymd}  ${fmt(c.amount_clp).padStart(9)}  ${it.px.toFixed(2).padStart(8)}  ${it.units.toFixed(4).padStart(9)}  ${c.employer}${it.detail ? `  (${it.detail})` : ""}`
        );
      }
      console.log(`→ insert ${counts.insert}, unchanged ${counts.unchanged}, update units ${counts.update_units}, mismatch ${counts.mismatch}`);
      if (plan.excel_contribution_rows.length > 0) {
        console.log(
          `\nExcel-era contribution rows (import:excel|afc-flow, amount > 0): ${plan.excel_contribution_rows.length}, ` +
            `${fmt(plan.excel_contribution_rows.reduce((a, m) => a + m.amount, 0))} CLP — ${replaceExcel ? "DELETED (superseded by the certificate)" : "kept (pass --replace-excel-rows to delete)"}`
        );
      }
      if (plan.excel_other_rows.length > 0) {
        console.log(`\nExcel-era non-contribution rows (kept unless listed in --drop-ids):`);
        for (const m of plan.excel_other_rows) {
          console.log(`  id ${m.id}  ${m.occurred_on}  ${fmt(m.amount).padStart(12)}  ${dropIds.includes(m.id) ? "DROP" : "keep"}  ${m.note ?? ""}`);
        }
      }
      const r1 = applyAfcCertImport(plan, { replaceExcelContributions: replaceExcel, dropIds });
      console.log(`→ wrote: inserted ${r1.inserted}, units updated ${r1.units_updated}, deleted ${r1.deleted}, mismatches skipped ${r1.mismatches}`);

      // 2. withdrawals (priced ones; a closing row is re-measured after the cartola true-ups)
      const withdrawals = (label: string, quiet: boolean) => {
        const wplan = planAfcWithdrawalUnits(accountId);
        console.log(`\n${label} — ${wplan.length}`);
        for (const w of wplan) {
          if (quiet && w.status === "unchanged") continue;
          console.log(
            `${w.status.padEnd(10)} id ${w.movement.id}  ${w.movement.occurred_on}  ${fmt(Math.abs(w.movement.amount)).padStart(12)}  px ${w.px.toFixed(2)}  cuotas ${w.units_abs.toFixed(4)}${w.closes_position ? "  (closes the position)" : ""}`
          );
        }
        const n = applyAfcWithdrawalUnits(wplan);
        console.log(`→ units set on ${n} withdrawal(s)`);
      };
      withdrawals("[2] Withdrawals", false);

      // 3. cartolas
      for (const cp of cartolaPaths) {
        const cartola = parseAfcCartola(pdfTextLayout(cp));
        console.log(
          `\n[3] Cartola ${cartola.period_from_ymd}..${cartola.period_to_ymd}: saldo ${cartola.saldo_inicial_ymd} ${fmt(cartola.saldo_inicial_clp)} → ${cartola.saldo_final_ymd} ${fmt(cartola.saldo_final_clp)}; ` +
            `cotizaciones ${fmt(cartola.cotizaciones_clp)}, ganancia ${fmt(cartola.ganancia_clp)}, comisiones ${fmt(cartola.comisiones_clp)}`
        );
        const cplan = planAfcCartolaTrueUps(accountId, cartola);
        for (const t of cplan.trueups) {
          console.log(
            `${t.status.padEnd(10)} saldo ${t.which.padEnd(7)} ${t.day_ymd}  target ${t.target_units.toFixed(4)} cuotas, ledger ${t.ledger_units.toFixed(4)} → true-up ${t.units.toFixed(4)} cuotas = ${fmt(t.amount_clp)} CLP (${t.flow_kind ?? "—"})`
          );
        }
        const r3 = applyAfcCartolaTrueUps(cplan);
        console.log(`→ true-ups: inserted ${r3.inserted}, updated ${r3.updated}, deleted ${r3.deleted}`);
      }

      // 4. closing withdrawals absorb the true-ups planted before them
      if (cartolaPaths.length > 0) withdrawals("[4] Withdrawals after the true-ups (changed rows only)", true);

      // 5. checks on the resulting ledger
      console.log(`\n[5] Resulting ledger checks`);
      const stored = db
        .prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
        .all(accountId) as { as_of_date: string; value: number }[];
      const diffs: number[] = [];
      for (const v of stored) {
        const px = fundUnitClpOnOrBefore(AFC_CIC_SERIES_KEY, v.as_of_date);
        if (px == null) continue;
        const cu = afpCuotasCumulativeThroughDate(accountId, v.as_of_date);
        const derived = Math.round(cu * px);
        if (v.value > 0) diffs.push((derived - v.value) / v.value);
      }
      if (diffs.length > 0) {
        const abs = diffs.map(Math.abs).sort((a, b) => a - b);
        console.log(
          `stored excel month-ends vs ledger × valor cuota: n=${diffs.length}, median |diff| ${(abs[Math.floor(abs.length / 2)]! * 100).toFixed(2)}%, max |diff| ${(abs[abs.length - 1]! * 100).toFixed(2)}%`
        );
      }
      const last = db
        .prepare(`SELECT occurred_on FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ? ORDER BY date(occurred_on) DESC, id DESC LIMIT 1`)
        .get(accountId, accountId, accountId) as { occurred_on: string } | undefined;
      if (last) {
        console.log(`cuotas after the last movement (${last.occurred_on}): ${afpCuotasCumulativeThroughDate(accountId, last.occurred_on).toFixed(4)}`);
      }

      if (!apply) throw new Rollback("report only");
    })();
    console.log(`\nAPPLIED.`);
  } catch (e) {
    if (e instanceof Rollback) {
      console.log(`\nREPORT ONLY — every change above was rolled back. Re-run with --apply to write.`);
      return;
    }
    throw e;
  }
}

main();
