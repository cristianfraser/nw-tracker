/**
 * Report-first repair: apply the bank-stated «crédito restante» to an already-logged mortgage
 * cuota.
 *
 * The form's optional «Crédito restante UF (banco)» field exists because the derived balance
 * (prior − round4 UF legs) can miss the bank's printed figure by ±0,0001 UF — the bank amortizes
 * in UF at higher precision than the CLP components can express. When the field was left
 * blank at logging time (the bank's balance is usually only visible after the payment posts),
 * this script re-runs the SAME compute the form used, against the ledger WITHOUT that cuota,
 * with the stored inputs plus the stated balance, and rewrites both `depto_payments` rows
 * (mortgage + dividendos) from the result. Same tolerance guard as the form: a stated value
 * farther than 0,005 UF from the derived one throws inside the compute.
 *
 * Only the LATEST payment is editable — later rows chain off its balance, and re-deriving a
 * whole tail is a different (deliberate) operation.
 *
 * Usage:
 *   npx tsx scripts/repair-mortgage-payment-stated-balance.ts --cuota=31 --credito-restante-uf=1769.9999
 *   npx tsx scripts/repair-mortgage-payment-stated-balance.ts --cuota=31 --credito-restante-uf=1769.9999 --apply
 */
import { db } from "../src/db.js";
import { invalidateAggregationForAccountDate } from "../src/aggregationCache.js";
import {
  deptoLedgerChronoCompare,
  deptoPaymentColumnsFromPaymentRow,
  sheetRowToPaymentRow,
} from "../src/deptoDividendosLedger.js";
import { loadDeptoLedgerFromMovements } from "../src/deptoLedgerFromMovements.js";
import {
  computeMortgagePaymentRow,
  type MortgagePaymentInput,
} from "../src/mortgagePaymentCompute.js";

const APPLY = process.argv.includes("--apply");

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

type StoredRow = {
  movement_id: number;
  account_id: number;
  kind: "dividendos" | "mortgage";
  occurred_on: string;
  amount: number;
  cuota: string;
  amount_uf: number | null;
  credito_restante_uf: number | null;
  valor_vivienda_uf: number | null;
  valor_neto_uf: number | null;
  valor_neto_clp: number | null;
  pagado_neto_uf: number | null;
  pago_acumulado_clp: number | null;
  min_uf: number | null;
  amortizacion_clp: number | null;
  amortizacion_uf: number | null;
  amortizacion_ext_clp: number | null;
  amortizacion_ext_uf: number | null;
  interes_clp: number | null;
  interes_uf: number | null;
  incendio_clp: number | null;
  desgravamen_clp: number | null;
};

const PAYMENT_COLUMNS = [
  "cuota",
  "amount_uf",
  "credito_restante_uf",
  "valor_vivienda_uf",
  "valor_neto_uf",
  "valor_neto_clp",
  "pagado_neto_uf",
  "pago_acumulado_clp",
  "min_uf",
  "amortizacion_clp",
  "amortizacion_uf",
  "amortizacion_ext_clp",
  "amortizacion_ext_uf",
  "interes_clp",
  "interes_uf",
  "incendio_clp",
  "desgravamen_clp",
] as const;
type PaymentColumn = (typeof PAYMENT_COLUMNS)[number];

function fmt(v: unknown): string {
  if (v == null) return "NULL";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return String(v);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return a === b;
}

function main(): void {
  const cuota = argValue("cuota")?.trim();
  const statedRaw = argValue("credito-restante-uf");
  if (!cuota || statedRaw == null) {
    throw new Error("Usage: --cuota=<n> --credito-restante-uf=<uf> [--apply]");
  }
  const stated = Number(statedRaw);
  if (!Number.isFinite(stated) || stated < 0) {
    throw new Error(`Invalid --credito-restante-uf: ${statedRaw}`);
  }

  const stored = db
    .prepare(
      `SELECT p.*, m.account_id, m.occurred_on, m.amount
         FROM depto_payments p
         JOIN movements m ON m.id = p.movement_id
        WHERE p.cuota = ?
        ORDER BY p.kind`
    )
    .all(cuota) as StoredRow[];
  if (stored.length !== 2) {
    throw new Error(`Expected exactly 2 depto_payments rows for cuota ${cuota} (mortgage + dividendos), found ${stored.length}`);
  }
  const [dividendosRow, mortgageRow] = stored;
  if (dividendosRow!.kind !== "dividendos" || mortgageRow!.kind !== "mortgage") {
    throw new Error(`Cuota ${cuota} rows are not one dividendos + one mortgage row`);
  }
  if (dividendosRow!.occurred_on !== mortgageRow!.occurred_on) {
    throw new Error(`Cuota ${cuota} rows disagree on occurred_on (${dividendosRow!.occurred_on} vs ${mortgageRow!.occurred_on})`);
  }
  const occurredOn = mortgageRow!.occurred_on;

  const ledger = loadDeptoLedgerFromMovements();
  const sorted = [...ledger].sort(deptoLedgerChronoCompare);
  const last = sorted[sorted.length - 1];
  if (!last || last.cuota !== cuota || last.occurred_on !== occurredOn) {
    throw new Error(
      `Cuota ${cuota} (${occurredOn}) is not the latest ledger row (latest is cuota ${last?.cuota} on ${last?.occurred_on}); only the latest payment can be re-stated`
    );
  }
  const ledgerWithout = ledger.filter((r) => !(r.cuota === cuota && r.occurred_on === occurredOn));
  if (ledgerWithout.length !== ledger.length - 1) {
    throw new Error(`Expected to remove exactly one ledger row for cuota ${cuota}, removed ${ledger.length - ledgerWithout.length}`);
  }

  const m = mortgageRow!;
  for (const [k, v] of Object.entries({ interes_clp: m.interes_clp, incendio_clp: m.incendio_clp, desgravamen_clp: m.desgravamen_clp, amortizacion_ext_clp: m.amortizacion_ext_clp })) {
    if (v == null) throw new Error(`Stored ${k} is NULL on cuota ${cuota}; cannot rebuild the compute input`);
  }
  const input: MortgagePaymentInput = {
    occurred_on: occurredOn,
    pago_clp: Math.abs(m.amount),
    interes_clp: m.interes_clp!,
    incendio_clp: m.incendio_clp!,
    desgravamen_clp: m.desgravamen_clp,
    cuota,
    min_uf: m.min_uf,
    // Explicit stored prepago: the split is data once written; only the balance is re-stated.
    amortizacion_ext_clp: m.amortizacion_ext_clp,
    credito_restante_uf: stated,
  };

  const computed = computeMortgagePaymentRow(ledgerWithout, input);
  const next = deptoPaymentColumnsFromPaymentRow(sheetRowToPaymentRow(computed.sheet));

  console.log(`cuota ${cuota} on ${occurredOn} — stated crédito restante ${fmt(stated)} UF (derived ${fmt(computed.credito_restante_derived_uf)} UF, override used: ${computed.credito_restante_used_override})`);
  let anyChange = false;
  for (const row of stored) {
    console.log(`\n${row.kind} row — movement ${row.movement_id} (account ${row.account_id})`);
    for (const col of PAYMENT_COLUMNS) {
      const before = row[col as PaymentColumn];
      const after = next[col as PaymentColumn];
      if (!sameValue(before, after)) {
        anyChange = true;
        console.log(`  ${col.padEnd(22)} ${fmt(before)} → ${fmt(after)}`);
      }
    }
  }
  if (!anyChange) {
    console.log("\nNo column changes — stored rows already match the stated balance.");
    return;
  }
  if (!APPLY) {
    console.log("\n(report only — re-run with --apply to write)");
    return;
  }

  const update = db.prepare(
    `UPDATE depto_payments SET ${PAYMENT_COLUMNS.map((c) => `${c} = @${c}`).join(", ")} WHERE movement_id = @movement_id`
  );
  db.transaction(() => {
    for (const row of stored) {
      const res = update.run({ ...next, movement_id: row.movement_id });
      if (res.changes !== 1) throw new Error(`UPDATE touched ${res.changes} rows for movement ${row.movement_id}`);
    }
  })();
  for (const row of stored) invalidateAggregationForAccountDate(row.account_id, occurredOn);
  console.log(`\nApplied: ${stored.length} depto_payments rows rewritten (movements ${stored.map((r) => r.movement_id).join(", ")}).`);
}

main();
