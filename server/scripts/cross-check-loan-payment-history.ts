/**
 * The lender's records against the ledger's loan payments (docs/untangle-flow-model.md A1, A3, A4):
 *
 *   npx tsx scripts/cross-check-loan-payment-history.ts --xlsx=<dividend history> [--plan=<json>]
 *       [--liquidations=<staged mails json>] [--certificate=<art. 55 bis pdf>] [--apply]
 *
 * - The dividend history (one row per cuota, Chilean amounts) is compared with every regular cuota
 *   of the ledger: date, total, principal, extra principal, interest, the two insurances.
 * - The plan (`mortgage` key of the coordinator's plan file) names what to write for a difference —
 *   `set_field_from_bank` {cuota, field}, `set_date_from_bank` {cuota}, `set_interest_residual`
 *   {cuota} — and what the user accepts (`accept` {cuota, field, reason}). Anything else is reported.
 * - Each prepago is split by the liquidation it paid (`liquidations`: the mails archive, whose
 *   attachments carry the `pdftotext -layout` text): principal, accrued interest, prepayment charge;
 *   its cash leg (`prepago_cash_legs` {label, debit_movement_id}: the «Cargo Mercado Capitales»
 *   debit) is linked to it for the prepago's amount, the remainder a `bank_fee` part on the debit.
 * - With a certificate, Σ interest by payment month of its year is checked against it.
 *
 * Everything runs in one IMMEDIATE transaction — the corrections, the parts, then the checks (the
 * balance chain unchanged, Σ parts = payment ± 1 but the accepted rows, the card pairing matching
 * every cuota it matched before) — rolled back without `--apply`, so the report is the exact outcome.
 * Report-first; counts and figures go to the console only.
 */
import fs from "node:fs";
import { parseChileanInteger, parseDdMmYyToIso } from "nw-tracker-contracts";
import XLSX from "xlsx";
import { db } from "../src/db.js";
import { deptoLedgerChronoCompare, isDeptoPrepagoCuota } from "../src/deptoDividendosLedger.js";
import { loadDeptoLedgerFromMovements } from "../src/deptoLedgerFromMovements.js";
import { insertManualFundedDepositLink, linkedFundedDepositOf } from "../src/expenseDepositLinks.js";
import { PARTS_SUM_FIELD, syncLoanPaymentFlowParts } from "../src/flows/loanPaymentParts.js";
import {
  compareInterestCertificate,
  compareLoanPaymentHistory,
  derivePrepagoSplit,
  interestByPaymentMonth,
  parseInterestCertificate,
  parsePrepagoLiquidation,
  planCorrections,
  type BankCuotaRow,
  type CorrectableField,
  type CorrectionPlanItem,
  type LedgerCuotaRow,
  type PrepagoLiquidation,
} from "../src/loanPaymentHistoryCrossCheck.js";
import { mortgageCardMatches } from "../src/mortgagePaymentCardMatch.js";
import { numericCuota } from "../src/mortgagePaymentCompute.js";
import { execFileSync } from "node:child_process";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
const xlsxPath = arg("xlsx");
if (!xlsxPath) {
  console.error("--xlsx=<dividend history> is required");
  process.exit(2);
}

type Plan = {
  mortgage?: {
    set_field_from_bank?: { cuota: string; field: CorrectableField }[];
    set_date_from_bank?: { cuota: string }[];
    set_interest_residual?: { cuota: string; reason?: string }[];
    accept?: { cuota: string; field: string; reason: string }[];
    prepago_cash_legs?: { label: string; debit_movement_id: number }[];
  };
};
const planFile: Plan = arg("plan") ? (JSON.parse(fs.readFileSync(arg("plan")!, "utf8")) as Plan) : {};
const plan = planFile.mortgage ?? {};
const planItems: CorrectionPlanItem[] = [
  ...(plan.set_field_from_bank ?? []).map((i) => ({ kind: "set_field" as const, cuota: i.cuota, field: i.field, source: "bank" as const })),
  ...(plan.set_date_from_bank ?? []).map((i) => ({ kind: "set_date" as const, cuota: i.cuota, source: "bank" as const })),
  ...(plan.set_interest_residual ?? []).map((i) => ({ kind: "set_interest_residual" as const, cuota: i.cuota, reason: i.reason })),
  ...(plan.accept ?? []).map((i) => ({ kind: "accept" as const, cuota: i.cuota, field: i.field, reason: i.reason })),
];
const acceptedEntries = (plan.accept ?? []).map((a) => ({ label: a.cuota, field: a.field, reason: a.reason }));

// --- the lender's history ---------------------------------------------------------------------
const HISTORY_COLUMNS = {
  cuota: "Dividendo",
  paid_on: "Fecha de pago",
  total: "Total",
  insurance_fire: "Seguro incendio",
  principal: "Amortización",
  interest: "Interés",
  insurance_life: "Seguro degravamen",
  extra_principal: "Amortización extraordinaria",
  penalty: "Interés penal o mora",
  other_insurance: "Otros seguros",
} as const;

function readHistory(path: string): BankCuotaRow[] {
  const wb = XLSX.read(fs.readFileSync(path), { type: "buffer" });
  const sheet = wb.Sheets["Dividendos Históricos"];
  if (!sheet) throw new Error(`${path}: no sheet «Dividendos Históricos» (sheets: ${wb.SheetNames.join(", ")})`);
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
  const header = rows[0] ?? [];
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${path}: no column «${name}» (${header.join(" | ")})`);
    return i;
  };
  const idx = Object.fromEntries(Object.entries(HISTORY_COLUMNS).map(([k, name]) => [k, col(name)])) as Record<keyof typeof HISTORY_COLUMNS, number>;
  const pesos = (raw: string, what: string): number => {
    const t = String(raw).trim().replace(/^\$\s*/, "");
    if (t === "") throw new Error(`${path}: empty ${what}`);
    return parseChileanInteger(t);
  };
  return rows.slice(1).filter((r) => String(r[idx.cuota] ?? "").trim() !== "").map((r) => {
    const cuota = String(r[idx.cuota]).trim();
    const paidOn = parseDdMmYyToIso(String(r[idx.paid_on]));
    if (!paidOn) throw new Error(`${path}: cuota ${cuota}: cannot read «${r[idx.paid_on]}» as a date`);
    return {
      cuota,
      paid_on: paidOn,
      total_clp: pesos(r[idx.total]!, `total of ${cuota}`),
      principal_clp: pesos(r[idx.principal]!, `principal of ${cuota}`),
      extra_principal_clp: pesos(r[idx.extra_principal]!, `extra principal of ${cuota}`),
      interest_clp: pesos(r[idx.interest]!, `interest of ${cuota}`),
      insurance_fire_clp: pesos(r[idx.insurance_fire]!, `fire insurance of ${cuota}`),
      insurance_life_clp: pesos(r[idx.insurance_life]!, `life insurance of ${cuota}`),
      penalty_interest_clp: pesos(r[idx.penalty]!, `penalty interest of ${cuota}`),
      other_insurance_clp: pesos(r[idx.other_insurance]!, `other insurance of ${cuota}`),
    };
  });
}

// --- the ledger ---------------------------------------------------------------------------------
type LoanRow = {
  movement_id: number;
  leg: "property" | "loan";
  cuota: string;
  occurred_on: string;
  pago_clp: number;
  flow_id: number | null;
  balance_after: number | null;
  principal: number | null;
  extra_principal: number | null;
  interest: number | null;
  insurance_fire: number | null;
  insurance_life: number | null;
  prepayment_charge: number | null;
  loan_currency: string;
  payment_currency: string;
};

function loanRows(): LoanRow[] {
  const rows = db
    .prepare(
      `SELECT p.movement_id, p.leg, p.cuota, m.occurred_on, CAST(round(abs(m.amount)) AS INTEGER) AS pago_clp, m.flow_id,
              p.balance_after, p.principal, p.extra_principal, p.interest, p.insurance_fire, p.insurance_life, p.prepayment_charge,
              p.loan_currency, p.payment_currency
       FROM loan_payments p JOIN movements m ON m.id = p.movement_id ORDER BY m.occurred_on, p.cuota, p.leg`
    )
    .all() as LoanRow[];
  for (const r of rows) {
    if (r.loan_currency !== "uf" || r.payment_currency !== "clp") throw new Error(`cuota ${r.cuota}: a UF loan paid in pesos expected`);
  }
  return rows;
}

function ledgerCuotas(rows: readonly LoanRow[]): LedgerCuotaRow[] {
  return rows
    .filter((r) => r.leg === "property" && numericCuota(r.cuota) != null)
    .map((r) => ({
      cuota: r.cuota,
      paid_on: r.occurred_on,
      total_clp: r.pago_clp,
      principal_clp: r.principal,
      extra_principal_clp: r.extra_principal,
      interest_clp: r.interest,
      insurance_fire_clp: r.insurance_fire,
      insurance_life_clp: r.insurance_life,
    }));
}

function balanceChain(rows: readonly LoanRow[]): string {
  return JSON.stringify(rows.filter((r) => r.leg === "loan").map((r) => [r.cuota, r.balance_after]));
}

// --- liquidations -------------------------------------------------------------------------------
function readLiquidations(path: string): PrepagoLiquidation[] {
  const mails = JSON.parse(fs.readFileSync(path, "utf8")) as { attachments?: { filename?: string; name?: string; text?: string }[] }[];
  const out: PrepagoLiquidation[] = [];
  for (const m of mails) {
    for (const a of m.attachments ?? []) {
      if (!a.text || !/LIQUIDACI[ÓO]N PREPAGO/i.test(a.text)) continue;
      out.push(parsePrepagoLiquidation(a.text, a.filename ?? a.name ?? "attachment"));
    }
  }
  if (out.length === 0) throw new Error(`${path}: no liquidation text among the attachments`);
  return out;
}

// --- run ----------------------------------------------------------------------------------------
const bank = readHistory(xlsxPath);
const before = loanRows();
const comparison = compareLoanPaymentHistory(bank, ledgerCuotas(before));
console.log(`History: ${bank.length} rows (${bank.filter((b) => b.total_clp > 0).length} with a payment); ledger: ${ledgerCuotas(before).length} regular cuotas.`);
console.log(`Compared ${comparison.compared}: ${comparison.agreeing.length} agree on every field; ${comparison.differences.length} difference(s) on ${new Set(comparison.differences.map((d) => d.cuota)).size} cuota(s).`);
for (const d of comparison.differences) console.log(`  cuota ${d.cuota} ${d.field}: bank ${d.bank}, ledger ${d.ledger}`);
if (comparison.bank_only.length) console.log(`  history only: ${comparison.bank_only.join(", ")}`);
if (comparison.ledger_only.length) console.log(`  ledger only: ${comparison.ledger_only.join(", ")}`);
for (const u of comparison.unmodelled) console.log(`  cuota ${u.cuota}: the history prints ${u.column} ${u.amount_clp} (no home in the ledger)`);

const planned = planCorrections(comparison, bank, ledgerCuotas(before), planItems);
console.log(`\nPlan: ${planned.corrections.length} correction(s), ${planned.accepted.length} accepted, ${planned.unplanned.length} unplanned difference(s).`);
for (const c of planned.corrections) {
  const what = c.kind === "set_field" ? `${c.field} ${c.from} → ${c.to}` : c.kind === "set_date" ? `paid_on ${c.from} → ${c.to}` : `interest ${c.from} → ${c.to} (the total's residual)`;
  console.log(`  cuota ${c.cuota}: ${what}`);
}
for (const a of planned.accepted) console.log(`  accepted: cuota ${a.cuota} ${a.field} — ${a.reason}`);
for (const d of planned.unplanned) console.log(`  UNPLANNED: cuota ${d.cuota} ${d.field}: bank ${d.bank}, ledger ${d.ledger}`);

const pairingBefore = mortgageCardMatches();
const matchedBefore = new Set(pairingBefore.payments.filter((p) => p.status === "matched").map((p) => p.cuota));

const liquidations = arg("liquidations") ? readLiquidations(arg("liquidations")!) : null;
const certificate = arg("certificate")
  ? parseInterestCertificate(execFileSync("pdftotext", ["-layout", arg("certificate")!, "-"], { encoding: "utf8" }))
  : null;

const neededAccepted: { label: string; field: string; reason: string }[] = [];
const acceptedKeys = new Set(acceptedEntries.map((a) => `${a.label}|${a.field}`));
const needAccepted = (label: string, field: string, reason: string) => {
  if (!acceptedKeys.has(`${label}|${field}`) && !neededAccepted.some((n) => n.label === label && n.field === field)) {
    neededAccepted.push({ label, field, reason });
  }
};

const run = db.transaction(() => {
  // 1. The regular cuotas' corrections (both legs of the cuota).
  for (const c of planned.corrections) {
    const legs = before.filter((r) => r.cuota === c.cuota);
    if (legs.length !== 2) throw new Error(`cuota ${c.cuota}: expected the loan + property rows, found ${legs.length}`);
    for (const leg of legs) {
      if (c.kind === "set_field") {
        const value = c.field === "extra_principal" && c.to === 0 ? null : c.to;
        db.prepare(`UPDATE loan_payments SET ${c.field} = ? WHERE movement_id = ?`).run(value, leg.movement_id);
      } else if (c.kind === "set_interest_residual") {
        db.prepare(`UPDATE loan_payments SET interest = ? WHERE movement_id = ?`).run(c.to, leg.movement_id);
      } else {
        // The movement's day moves; so does its flow's (nothing keeps the two in step on an update).
        db.prepare(`UPDATE movements SET occurred_on = ? WHERE id = ?`).run(c.to, leg.movement_id);
        db.prepare(`UPDATE flows SET occurred_on = ? WHERE id = ?`).run(c.to, leg.flow_id);
      }
    }
  }

  // 2. The prepagos: their split from the liquidation that was paid, and their cash legs.
  if (liquidations) {
    const ledger = [...loadDeptoLedgerFromMovements()].sort(deptoLedgerChronoCompare);
    console.log(`\nPrepagos: ${liquidations.length} liquidation(s) read.`);
    for (let i = 0; i < ledger.length; i++) {
      const row = ledger[i]!;
      if (!isDeptoPrepagoCuota(row.cuota)) continue;
      const prev = ledger[i - 1];
      if (!prev?.credito_restante_uf || row.credito_restante_uf == null) throw new Error(`${row.cuota}: no balance before / after`);
      const split = derivePrepagoSplit(
        { label: row.cuota, paid_on: row.occurred_on, total_clp: Math.round(row.pago_clp), balance_before_uf: prev.credito_restante_uf, balance_after_uf: row.credito_restante_uf },
        liquidations
      );
      console.log(
        `  ${row.cuota} (${row.occurred_on}): ${split.basis} via ${split.liquidation} — principal ${split.principal_clp} (ledger ${row.amortizacion_ext_clp}), interest ${split.interest_clp} (ledger ${row.interes_clp}), charge ${split.prepayment_charge_clp}` +
          (split.basis === "round_payment"
            ? ` [principal = balance drop × the liquidation's parity; interest = printed × drop / liquidation principal; charge = the remainder, against ${split.printed_charge_scaled_clp} printed and scaled]`
            : "")
      );
      const legs = before.filter((r) => r.cuota === row.cuota);
      if (legs.length !== 2) throw new Error(`${row.cuota}: expected the loan + property rows, found ${legs.length}`);
      for (const leg of legs) {
        db.prepare(`UPDATE loan_payments SET extra_principal = ?, interest = ?, prepayment_charge = ? WHERE movement_id = ?`).run(
          split.principal_clp,
          split.interest_clp,
          split.prepayment_charge_clp,
          leg.movement_id
        );
      }
      // The cash leg: the checking debit that bought the vale vista, linked for the prepago's amount;
      // what it paid above that is the bank's document fee, a cost part on the debit.
      const cash = (plan.prepago_cash_legs ?? []).find((c) => c.label === row.cuota);
      if (!cash) {
        console.log(`    no cash leg named in the plan`);
        continue;
      }
      const propertyLeg = legs.find((l) => l.leg === "property")!;
      const debit = db.prepare(`SELECT id, account_id, flow_id, CAST(round(abs(amount)) AS INTEGER) AS clp, occurred_on FROM movements WHERE id = ?`).get(cash.debit_movement_id) as
        | { id: number; account_id: number; flow_id: number; clp: number; occurred_on: string }
        | undefined;
      if (!debit) throw new Error(`${row.cuota}: debit movement ${cash.debit_movement_id} not found`);
      if (debit.occurred_on !== row.occurred_on) throw new Error(`${row.cuota}: the debit is dated ${debit.occurred_on}, the prepago ${row.occurred_on}`);
      const fee = debit.clp - Math.round(row.pago_clp);
      if (fee <= 0) throw new Error(`${row.cuota}: the debit (${debit.clp}) is not above the prepago (${row.pago_clp})`);
      const linked = linkedFundedDepositOf(debit.id, propertyLeg.movement_id);
      if (!linked) {
        insertManualFundedDepositLink({ outflowMovementId: debit.id, depositMovementId: propertyLeg.movement_id, paymentClp: Math.round(row.pago_clp), deptoCuota: row.cuota, deptoOccurredOn: row.occurred_on });
        console.log(`    cash leg: debit ${debit.id} linked for the prepago`);
      } else if (linked.payment_clp !== Math.round(row.pago_clp)) {
        throw new Error(`${row.cuota}: the debit's link carries ${linked.payment_clp}, the prepago ${row.pago_clp}`);
      } else {
        console.log(`    cash leg: debit ${debit.id} already linked (${linked.link_source})`);
      }
      const existingFee = db.prepare(`SELECT amount_clp FROM flow_parts WHERE flow_id = ? AND kind = 'bank_fee'`).all(debit.flow_id) as { amount_clp: number }[];
      if (existingFee.length === 0) {
        const seq = ((db.prepare(`SELECT MAX(seq) AS s FROM flow_parts WHERE flow_id = ?`).get(debit.flow_id) as { s: number | null }).s ?? -1) + 1;
        db.prepare(`INSERT INTO flow_parts (flow_id, seq, kind, amount_clp) VALUES (?, ?, 'bank_fee', ?)`).run(debit.flow_id, seq, fee);
        console.log(`    bank fee part written on the debit: ${fee}`);
      } else if (existingFee.length !== 1 || existingFee[0]!.amount_clp !== fee) {
        throw new Error(`${row.cuota}: the debit already carries bank fee part(s) ${existingFee.map((f) => f.amount_clp).join(", ")}, expected ${fee}`);
      } else {
        console.log(`    bank fee part already on the debit`);
      }
    }
  }

  // 3. Parts and checks.
  const after = loanRows();
  if (balanceChain(after) !== balanceChain(before)) throw new Error("the balance_after chain changed");
  const propertyRows = after.filter((r) => r.leg === "property" && r.cuota.trim().toLowerCase() !== "pie");
  for (const r of propertyRows) {
    const sum = Math.round(r.principal ?? 0) + Math.round(r.extra_principal ?? 0) + Math.round(r.interest ?? 0) + Math.round(r.insurance_fire ?? 0) + Math.round(r.insurance_life ?? 0) + Math.round(r.prepayment_charge ?? 0);
    if (Math.abs(sum - r.pago_clp) > 1) {
      if (!acceptedKeys.has(`${r.cuota}|${PARTS_SUM_FIELD}`)) needAccepted(r.cuota, PARTS_SUM_FIELD, "the parts do not add up to the payment");
      console.log(`  ${numericCuota(r.cuota) != null ? "cuota " : ""}${r.cuota}: parts add up to ${sum} against a payment of ${r.pago_clp}${acceptedKeys.has(`${r.cuota}|${PARTS_SUM_FIELD}`) ? " (accepted)" : " (NOT accepted)"}`);
    }
  }
  if (neededAccepted.length > 0) {
    console.log(`\nAccepted differences the config lacks (accepted_differences in cfraser/mortgage-sheet.json):`);
    for (const n of neededAccepted) console.log(`  { "label": "${n.label}", "field": "${n.field}", "reason": "${n.reason}" }`);
    throw new Error(`${neededAccepted.length} difference(s) need an accepted entry before anything is written`);
  }
  syncLoanPaymentFlowParts(acceptedEntries);
  const parts = db.prepare(`SELECT COUNT(DISTINCT flow_id) AS flows, COUNT(*) AS n FROM flow_parts WHERE kind <> 'piece'`).get() as { flows: number; n: number };
  console.log(`\nParts: ${parts.n} part(s) on ${parts.flows} flow(s).`);

  const pairingAfter = mortgageCardMatches();
  const matchedAfter = new Set(pairingAfter.payments.filter((p) => p.status === "matched").map((p) => p.cuota));
  const lost = [...matchedBefore].filter((c) => !matchedAfter.has(c));
  if (lost.length) throw new Error(`card pairing lost cuota(s) ${lost.join(", ")}`);
  const gained = [...matchedAfter].filter((c) => !matchedBefore.has(c));
  console.log(`Card pairing: ${matchedBefore.size} cuota(s) matched before, ${matchedAfter.size} after${gained.length ? ` (+ ${gained.join(", ")})` : ""}; ${pairingAfter.unmatched_lines.length} mortgage card line(s) without a cuota.`);
  for (const p of pairingAfter.payments) {
    if (p.status === "matched" && p.line && p.line.amount_clp !== p.pago_clp) {
      const field = "card_amount";
      const ok = acceptedKeys.has(`${p.cuota}|${field}`);
      console.log(`  cuota ${p.cuota}: the card paid ${p.line.amount_clp} against the ledger's ${p.pago_clp}${ok ? " (accepted)" : " (NOT accepted)"}`);
      if (!ok) throw new Error(`cuota ${p.cuota}: the card amount differs from the ledger and no accepted entry (${field}) names it`);
    }
  }

  // 4. The certificate.
  if (certificate) {
    const months = interestByPaymentMonth(
      after.filter((r) => r.leg === "loan" && r.cuota.trim().toLowerCase() !== "pie").map((r) => ({ paid_on: r.occurred_on, interest_clp: r.interest })),
      certificate.year
    );
    const r = compareInterestCertificate(certificate.months, months);
    console.log(`\nCertificate ${certificate.year}: ${r.agreeing} of 12 months agree.`);
    for (const d of r.differences) console.log(`  ${d.month}: certificate ${d.certificate_clp}, ledger ${d.ledger_clp}`);
    if (r.differences.length > 0) throw new Error("the ledger's interest by payment month differs from the certificate");
  }

  if (!apply) throw new RollBack();
});

class RollBack extends Error {}

try {
  run.immediate();
  console.log(`\nApplied.`);
} catch (e) {
  if (e instanceof RollBack) {
    console.log(`\nReport only — nothing written. Re-run with --apply.`);
  } else {
    console.error(`\nFAILED (nothing written): ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
