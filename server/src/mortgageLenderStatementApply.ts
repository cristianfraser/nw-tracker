/**
 * `mortgage.lender_statement` v1 → the depto ledger and the lender's quotes. One reading of the
 * lender's portal (MetLife Hipotecario's «Centro de pago»): the credit's balance, the cuota the bank
 * asks for now (its quote) and the cuotas of the last months.
 *
 * - The loan: the one loan whose `lender_pattern` words name the lender (`METLIFE`); none or
 *   several throw.
 * - The quote: every pending cuota's figures go to `mortgage_lender_quotes` (migration 308), its
 *   insurance in UF from the cuota's own history row; a reading whose figures equal the latest row
 *   stored for that cuota stores nothing. «Próximos pagos» and the mortgage scenarios read it
 *   (`mortgageLenderQuoteForCuota`).
 * - A paid cuota the ledger has (by cuota number on the loan's `loan_payments`) is cross-checked
 *   field by field — principal, extra principal, interest, the two insurances and the total to the
 *   peso, the payment day, and for the credit's last paid cuota the balance after it to
 *   `UF_TOLERANCE`; any difference is an `IngestConflict` listing every field, nothing written.
 * - A paid cuota the ledger lacks is written through `commitMortgagePayment` (origin `import`: a
 *   lender's portal is an import like the sheet was) only when it is the credit's last paid cuota —
 *   the only one whose balance after the reading states — else it waits. The pesos, the day and the
 *   parts are the lender's, the balance after is the credit's; the minimum and maximum are the
 *   latest stored quote of that cuota, or null when it was paid before any quote was read
 *   (`loan_payments.min_payment` / `max_payment` are nullable; the split does not need them, the
 *   lender states the extra principal). The app must reproduce the lender's principal to the peso
 *   and the balance chain (before − principal − extra = after in UF at the day's UF) within
 *   `BALANCE_CHAIN_TOLERANCE_UF`, and a stored payment receipt (`mortgage_payment_receipts`) for
 *   the cuota's due month must state the same total; else conflict. A charge the ledger has no
 *   column for (default interest, collection fee, other insurance) on a cuota to write is a conflict.
 *
 * One transaction: a conflict rolls everything back, a dry run is the receiver's rollback.
 */
import type {
  IngestConflictEntry,
  MortgageLenderStatementApplyDetails,
  MortgageLenderStatementPayload,
} from "nw-tracker-contracts";
import { db } from "./db.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";
import { deptoLedgerForLoan } from "./deptoLedgerFromMovements.js";
import { ufRowOnOrBefore } from "./fxRates.js";
import { IngestConflict } from "./ingestReceiver.js";
import { commitMortgagePayment } from "./mortgagePaymentCreate.js";
import { computeMortgagePaymentRow, numericCuota } from "./mortgagePaymentCompute.js";
import type { MortgagePaymentInput } from "./mortgagePaymentTypes.js";
import { loanAccountIdForLender, mortgageLenderQuoteForCuota, type StoredLenderQuote } from "./mortgageLenderQuotes.js";

/** 4-decimal UF figures on both sides; 0,0002 is the CLP→UF rounding noise, never a real gap. */
export const UF_TOLERANCE = 0.0002;
/**
 * The app derives the balance after a cuota from the balance before minus its two amortization
 * parts, each rounded to 4 UF decimals, while the bank amortizes at a higher precision: two
 * roundings plus the bank's own leave up to ~0,0003 UF. More is a wrong part or a wrong balance.
 */
export const BALANCE_CHAIN_TOLERANCE_UF = 0.0005;
const CLP_TOLERANCE = 1;

type Payload = MortgageLenderStatementPayload;
type HistoryRow = Payload["history"][number];
type PendingRow = Payload["pending"][number];

const QUOTE_FIGURES = [
  "due_on",
  "fee_uf",
  "fee_pesos",
  "min_uf",
  "min_pesos",
  "max_uf",
  "max_pesos",
  "amortization_pesos",
  "interest_pesos",
  "default_interest_pesos",
  "collection_fee_pesos",
  "insurance_fire_uf",
  "insurance_life_uf",
  "insurance_other_uf",
] as const;

function quoteRowFrom(due: PendingRow, history: readonly HistoryRow[]): Pick<StoredLenderQuote, (typeof QUOTE_FIGURES)[number]> {
  const own = history.find((h) => h.cuota === due.cuota && h.status !== "paid");
  if (!own) throw new Error(`mortgage.lender_statement: pending cuota ${due.cuota} has no history row stating its insurance`);
  return {
    due_on: due.due_on,
    fee_uf: due.fee_uf,
    fee_pesos: due.fee_pesos,
    min_uf: due.min_uf,
    min_pesos: due.min_pesos,
    max_uf: due.max_uf,
    max_pesos: due.max_pesos,
    amortization_pesos: due.amortization_pesos,
    interest_pesos: due.interest_pesos,
    default_interest_pesos: due.default_interest_pesos,
    collection_fee_pesos: due.collection_fee_pesos,
    insurance_fire_uf: own.insurance.fire_uf,
    insurance_life_uf: own.insurance.life_uf,
    insurance_other_uf: own.insurance.other_uf,
  };
}

function storeQuote(
  payload: Payload,
  loanAccountId: number,
  due: PendingRow
): { stored: boolean; first_seen_at: string } {
  const figures = quoteRowFrom(due, payload.history);
  const latest = db
    .prepare(
      `SELECT * FROM mortgage_lender_quotes WHERE lender = ? AND credit_number = ? AND cuota = ? ORDER BY read_at DESC, id DESC LIMIT 1`
    )
    .get(payload.lender, payload.credit_number, due.cuota) as StoredLenderQuote | undefined;
  const first = db
    .prepare(`SELECT MIN(first_seen_at) AS f FROM mortgage_lender_quotes WHERE lender = ? AND credit_number = ? AND cuota = ?`)
    .get(payload.lender, payload.credit_number, due.cuota) as { f: string | null };
  const firstSeen = first.f ?? payload.read_at;
  if (latest && QUOTE_FIGURES.every((f) => latest[f] === figures[f])) return { stored: false, first_seen_at: firstSeen };
  db.prepare(
    `INSERT INTO mortgage_lender_quotes (
       lender, credit_number, loan_account_id, cuota, due_on, fee_uf, fee_pesos, min_uf, min_pesos, max_uf, max_pesos,
       amortization_pesos, interest_pesos, default_interest_pesos, collection_fee_pesos,
       insurance_fire_uf, insurance_life_uf, insurance_other_uf, read_at, first_seen_at
     ) VALUES (
       @lender, @credit_number, @loan_account_id, @cuota, @due_on, @fee_uf, @fee_pesos, @min_uf, @min_pesos, @max_uf, @max_pesos,
       @amortization_pesos, @interest_pesos, @default_interest_pesos, @collection_fee_pesos,
       @insurance_fire_uf, @insurance_life_uf, @insurance_other_uf, @read_at, @first_seen_at
     )`
  ).run({
    ...figures,
    lender: payload.lender,
    credit_number: payload.credit_number,
    loan_account_id: loanAccountId,
    cuota: due.cuota,
    read_at: payload.read_at,
    first_seen_at: firstSeen,
  });
  return { stored: true, first_seen_at: firstSeen };
}

type Difference = { cuota: number; field: string; lender: number | string | null; ledger: number | string | null };

function near(a: number | null | undefined, b: number | null | undefined, tol: number): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tol;
}

/** The lender's paid cuota against the ledger's row of the same cuota. */
function compareStored(h: HistoryRow, stored: DeptoMortgageSheetRow, balanceAfterUf: number | null): Difference[] {
  const out: Difference[] = [];
  const add = (field: string, lender: number | string | null, ledger: number | string | null) =>
    out.push({ cuota: h.cuota, field, lender, ledger });
  if (h.paid_on !== stored.occurred_on) add("paid_on", h.paid_on, stored.occurred_on);
  const pairs: [string, number | null, number | null][] = [
    ["total", h.total_pesos, stored.pago_clp],
    ["principal", h.amortization_pesos, stored.amortizacion_clp],
    ["extra_principal", h.extra_amortization_pesos ?? 0, stored.amortizacion_ext_clp ?? 0],
    ["interest", h.interest_pesos, stored.interes_clp],
    ["insurance_fire", h.insurance.fire_pesos, stored.incendio_clp],
    ["insurance_life", h.insurance.life_pesos, stored.desgravamen_clp],
  ];
  for (const [field, l, s] of pairs) if (!near(l, s, CLP_TOLERANCE)) add(field, l, s);
  if (balanceAfterUf != null && !near(balanceAfterUf, stored.credito_restante_uf, UF_TOLERANCE)) {
    add("balance_after", balanceAfterUf, stored.credito_restante_uf);
  }
  return out;
}

type StoredReceipt = { amount_clp: number; due_on: string; transaction_id: string };

/** The stored payment receipts of the cuota due in month `dueMonth` (YYYY-MM) of this credit. */
function receiptsForDueMonth(lender: string, creditNumber: string, dueMonth: string): StoredReceipt[] {
  return db
    .prepare(
      `SELECT amount_clp, due_on, transaction_id FROM mortgage_payment_receipts
       WHERE lender = ? AND credit_number = ? AND substr(due_on, 1, 7) = ?`
    )
    .all(lender, creditNumber, dueMonth) as StoredReceipt[];
}

function checkReceipts(payload: Payload, h: HistoryRow, out: Difference[]): void {
  for (const r of receiptsForDueMonth(payload.lender, payload.credit_number, h.due_on.slice(0, 7))) {
    if (r.amount_clp !== h.total_pesos) {
      out.push({ cuota: h.cuota, field: `receipt ${r.transaction_id} amount`, lender: h.total_pesos, ledger: r.amount_clp });
    }
  }
}

function inputFromHistory(h: HistoryRow, balanceAfterUf: number, quote: StoredLenderQuote | null): MortgagePaymentInput {
  return {
    occurred_on: h.paid_on!,
    pago_clp: h.total_pesos!,
    interes_clp: h.interest_pesos!,
    incendio_clp: h.insurance.fire_pesos!,
    desgravamen_clp: h.insurance.life_pesos!,
    cuota: String(h.cuota),
    min_uf: quote?.min_uf ?? null,
    max_uf: quote?.max_uf ?? null,
    amortizacion_ext_clp: h.extra_amortization_pesos ?? 0,
    credito_restante_uf: balanceAfterUf,
  };
}

/** What the app derives from the lender's figures must be the lender's own; differences listed. */
function checkWrite(h: HistoryRow, ledger: readonly DeptoMortgageSheetRow[], input: MortgagePaymentInput): Difference[] {
  const out: Difference[] = [];
  const unmodelled: [string, number | null][] = [
    ["default_interest", h.default_interest_pesos],
    ["collection_fee", h.collection_fee_pesos],
    ["insurance_other", h.insurance.other_pesos],
  ];
  for (const [field, v] of unmodelled) if ((v ?? 0) !== 0) out.push({ cuota: h.cuota, field, lender: v, ledger: "no column" });
  const uf = ufRowOnOrBefore(h.paid_on!);
  if (!uf || uf.date !== h.paid_on) {
    throw new Error(`mortgage.lender_statement: no UF for ${h.paid_on} in uf_daily (cuota ${h.cuota}) — sync the UF first`);
  }
  let computed;
  try {
    computed = computeMortgagePaymentRow(ledger, input);
  } catch (e) {
    out.push({ cuota: h.cuota, field: "compute", lender: e instanceof Error ? e.message : String(e), ledger: null });
    return out;
  }
  if (!near(computed.sheet.amortizacion_clp, h.amortization_pesos, CLP_TOLERANCE)) {
    out.push({ cuota: h.cuota, field: "principal", lender: h.amortization_pesos, ledger: computed.sheet.amortizacion_clp });
  }
  if (!near(computed.credito_restante_derived_uf, input.credito_restante_uf, BALANCE_CHAIN_TOLERANCE_UF)) {
    out.push({
      cuota: h.cuota,
      field: "balance_chain",
      lender: input.credito_restante_uf ?? null,
      ledger: computed.credito_restante_derived_uf,
    });
  }
  return out;
}

function conflict(differences: Difference[], details: MortgageLenderStatementApplyDetails): IngestConflict {
  const first = differences[0]!;
  const entries: IngestConflictEntry[] = differences.map((d) => ({
    at: `loan_payments:${d.cuota}`,
    fields: [d.field],
    message: `cuota ${d.cuota} ${d.field}: lender ${d.lender}, ledger ${d.ledger}`,
  }));
  return new IngestConflict(
    `${differences.length} difference(s) between the lender's portal and the ledger — nothing written (first: cuota ${first.cuota} ${first.field}: lender ${first.lender}, ledger ${first.ledger})`,
    entries,
    { ...details, differences } as unknown as Record<string, unknown>
  );
}

export function applyMortgageLenderStatement(payload: Payload): MortgageLenderStatementApplyDetails {
  const loanId = loanAccountIdForLender(payload.lender);
  return db.transaction((): MortgageLenderStatementApplyDetails => {
    const details: MortgageLenderStatementApplyDetails = { quote: null, paid: [] };
    const differences: Difference[] = [];

    // The quotes: the next unpaid cuota (the lowest pending) is the one reported.
    const pending = [...payload.pending].sort((a, b) => a.cuota - b.cuota);
    for (const due of pending) {
      const s = storeQuote(payload, loanId, due);
      if (details.quote == null) details.quote = { cuota: due.cuota, due_on: due.due_on, stored: s.stored, first_seen_at: s.first_seen_at };
    }

    let ledger = deptoLedgerForLoan(loanId);
    const paidRows = payload.history.filter((h) => h.status === "paid").sort((a, b) => a.cuota - b.cuota);
    for (const h of paidRows) {
      const isLast = payload.credit.last_paid_cuota === h.cuota;
      const balanceAfter = isLast ? payload.credit.balance_uf : null;
      const stored = ledger.find((r) => numericCuota(r.cuota) === h.cuota);
      checkReceipts(payload, h, differences);
      if (stored) {
        const d = compareStored(h, stored, balanceAfter);
        differences.push(...d);
        details.paid.push({ cuota: h.cuota, outcome: "matches", detail: d.length === 0 ? "equal to the ledger" : `${d.length} difference(s)` });
        continue;
      }
      if (!isLast || balanceAfter == null) {
        details.paid.push({
          cuota: h.cuota,
          outcome: "waiting",
          detail: `not the credit's last paid cuota (${payload.credit.last_paid_cuota ?? "none"}): no balance after it is stated`,
        });
        continue;
      }
      const quote = mortgageLenderQuoteForCuota(loanId, h.cuota);
      const input = inputFromHistory(h, balanceAfter, quote);
      const d = checkWrite(h, ledger, input);
      if (d.length > 0) {
        differences.push(...d);
        details.paid.push({ cuota: h.cuota, outcome: "written", detail: `refused: ${d.length} difference(s)` });
        continue;
      }
      if (differences.length > 0) {
        details.paid.push({ cuota: h.cuota, outcome: "written", detail: "refused: other differences in the reading" });
        continue;
      }
      const committed = commitMortgagePayment(loanId, input, { origin: "import" });
      details.paid.push({
        cuota: h.cuota,
        outcome: "written",
        detail: `movement ${committed.mortgage_movement_id}, ${h.total_pesos} CLP on ${h.paid_on}, balance ${balanceAfter} UF${quote ? "" : " (no quote stored: min/max left empty)"}`,
      });
      ledger = deptoLedgerForLoan(loanId);
    }
    if (differences.length > 0) throw conflict(differences, details);
    return details;
  })();
}
