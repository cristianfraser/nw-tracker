/**
 * The loan payments' parts (docs/untangle-flow-model.md A2–A3; F20 «Parts»): what each mortgage
 * payment was made of, on the PROPERTY leg's flow — a regular cuota's principal and extra principal
 * (internal, into the property), interest and the two insurances (spending); a prepago's principal
 * (`extra_principal`), accrued interest and the lender's prepayment charge (a cost). The pie carries
 * none (it is capital). Written from `loan_payments` — the bank's statement of the payment — by every
 * writer of that table (the sheet import, the payment form, the cross-check script); the readers
 * (`mortgage_parts` on the real-estate page, the carrying the Expenses page and the flows overview
 * take out of the card line) read the parts, never the columns' arithmetic.
 *
 * Σ parts = the payment ± 1 peso, fail fast — unless the user declared the difference: the
 * lender's own row can be short of its total. A declaration is the payment's
 * `loan_payments.parts_difference_reason` (migration 309), or an `accepted` entry
 * `{label, field: "parts_sum"}` a caller passes (the history cross-check's plan).
 */
import { db } from "../db.js";
import { withoutChurn } from "../rederivation.js";
import {
  LOAN_CARRYING_PART_KINDS_SQL,
  LOAN_PAYMENT_PART_KINDS,
  LOAN_PRINCIPAL_PART_KINDS_SQL,
  loanPaymentPartRowsSql,
  type LoanPaymentPartKind,
} from "./flowParts.js";

/** The field an accepted difference names when a payment's parts do not add up to it. */
export const PARTS_SUM_FIELD = "parts_sum";

export type AcceptedPaymentDifference = { label: string; field: string };

/** A payment's parts by kind, in pesos (a kind absent = 0). */
export type LoanPaymentParts = Partial<Record<LoanPaymentPartKind, number>>;

type PaymentRow = { flow_id: number; cuota: string; pago_clp: number; loan_account_id: number; parts_difference_reason: string | null };

function propertyPaymentRows(): PaymentRow[] {
  return db
    .prepare(
      `SELECT m.flow_id, p.cuota, CAST(round(abs(m.amount)) AS INTEGER) AS pago_clp, p.loan_account_id, p.parts_difference_reason
       FROM loan_payments p JOIN movements m ON m.id = p.movement_id
       WHERE p.leg = 'property' AND lower(trim(p.cuota)) <> 'pie'
       ORDER BY m.occurred_on, p.cuota`
    )
    .all() as PaymentRow[];
}

/** Each payment's stated parts, keyed by its flow (what the writer derives from `loan_payments`). */
function statedPartsByFlow(): Map<number, { cuota: string; parts: { kind: LoanPaymentPartKind; seq: number; amount_clp: number }[] }> {
  const rows = db.prepare(`SELECT flow_id, seq, kind, amount_clp, cuota FROM (${loanPaymentPartRowsSql()}) ORDER BY flow_id, seq`).all() as {
    flow_id: number;
    seq: number;
    kind: LoanPaymentPartKind;
    amount_clp: number;
    cuota: string;
  }[];
  const out = new Map<number, { cuota: string; parts: { kind: LoanPaymentPartKind; seq: number; amount_clp: number }[] }>();
  for (const r of rows) {
    const entry = out.get(r.flow_id) ?? { cuota: r.cuota, parts: [] };
    entry.parts.push({ kind: r.kind, seq: r.seq, amount_clp: r.amount_clp });
    out.set(r.flow_id, entry);
  }
  return out;
}

/**
 * Rewrites every loan payment's parts from `loan_payments`; a rewrite that changes nothing writes
 * nothing. Throws, naming the payment, when its parts do not add up to it (± 1 peso) and no accepted
 * difference names the row — nothing is written then. The accepted differences are one loan's
 * (`acceptedLoanAccountId`, the loan its sheet is of): two loans number their cuotas alike.
 */
export function syncLoanPaymentFlowParts(
  accepted: readonly AcceptedPaymentDifference[],
  acceptedLoanAccountId?: number
): void {
  if (accepted.length > 0 && acceptedLoanAccountId == null) {
    throw new Error("loan payment parts: accepted differences need the loan they are of");
  }
  const acceptedLabels = new Set(accepted.filter((a) => a.field === PARTS_SUM_FIELD).map((a) => a.label));
  const payments = propertyPaymentRows();
  const shared = db
    .prepare(
      `SELECT p.cuota FROM loan_payments p JOIN movements m ON m.id = p.movement_id
       WHERE p.leg = 'property' AND (m.flow_id IS NULL OR (SELECT COUNT(*) FROM movements x WHERE x.flow_id = m.flow_id) <> 1) LIMIT 1`
    )
    .get() as { cuota: string } | undefined;
  if (shared) throw new Error(`loan payment parts: the property leg of cuota ${shared.cuota} has no flow of its own`);
  const stated = statedPartsByFlow();
  for (const p of payments) {
    const sum = (stated.get(p.flow_id)?.parts ?? []).reduce((s, x) => s + x.amount_clp, 0);
    const accepted = p.parts_difference_reason != null || (p.loan_account_id === acceptedLoanAccountId && acceptedLabels.has(p.cuota));
    if (Math.abs(sum - p.pago_clp) > 1 && !accepted) {
      throw new Error(
        `loan payment parts: cuota ${p.cuota} of loan ${p.loan_account_id} states parts adding up to ${sum} against a payment of ${p.pago_clp} — fix loan_payments or declare the difference (loan_payments.parts_difference_reason)`
      );
    }
  }
  withoutChurn(["flow_parts"], [], () => {
    const del = db.prepare(`DELETE FROM flow_parts WHERE flow_id = ? AND kind <> 'piece'`);
    const ins = db.prepare(`INSERT INTO flow_parts (flow_id, seq, kind, amount) VALUES (?, ?, ?, ?)`);
    for (const p of payments) {
      del.run(p.flow_id);
      for (const part of stated.get(p.flow_id)?.parts ?? []) ins.run(p.flow_id, part.seq, part.kind, part.amount_clp);
    }
  });
}

/** The stored parts of every loan payment, keyed by the property leg's flow. */
export function loanPaymentPartsByFlow(): Map<number, LoanPaymentParts> {
  const rows = db
    .prepare(
      `SELECT f.flow_id, f.kind, f.amount AS amount_clp FROM flow_parts f
       WHERE f.kind IN (${LOAN_PAYMENT_PART_KINDS.map((k) => `'${k}'`).join(", ")})`
    )
    .all() as { flow_id: number; kind: LoanPaymentPartKind; amount_clp: number }[];
  const out = new Map<number, LoanPaymentParts>();
  for (const r of rows) {
    const parts = out.get(r.flow_id) ?? {};
    parts[r.kind] = (parts[r.kind] ?? 0) + r.amount_clp;
    out.set(r.flow_id, parts);
  }
  return out;
}

/**
 * The stored parts of each payment against what `loan_payments` states today: a payment whose parts
 * were not rewritten after its row changed (a writer that skipped {@link syncLoanPaymentFlowParts})
 * is a data error the readers refuse, not a figure to prefer.
 */
export function assertLoanPaymentPartsCurrent(): void {
  const stored = loanPaymentPartsByFlow();
  for (const [flowId, s] of statedPartsByFlow()) {
    const have = stored.get(flowId) ?? {};
    for (const kind of LOAN_PAYMENT_PART_KINDS) {
      const want = s.parts.find((p) => p.kind === kind)?.amount_clp ?? 0;
      if ((have[kind] ?? 0) !== want) {
        throw new Error(`loan payment parts: cuota ${s.cuota} stores ${kind} ${have[kind] ?? 0} while loan_payments states ${want} — run the parts sync`);
      }
    }
  }
  for (const [flowId] of stored) {
    if (!statedPartsByFlow().has(flowId)) throw new Error(`loan payment parts: flow ${flowId} carries loan payment parts but no property-leg payment`);
  }
}

/** SQL: Σ of a flow's principal parts (the dividendo's amortization), NULL when it carries none. */
export function loanPrincipalPartsSql(flowCol: string): string {
  return `(SELECT SUM(x.amount) FROM flow_parts x WHERE x.flow_id = ${flowCol} AND x.kind IN ${LOAN_PRINCIPAL_PART_KINDS_SQL})`;
}

/** SQL: Σ of a flow's carrying parts (interest + insurances), NULL when it carries none. */
export function loanCarryingPartsSql(flowCol: string): string {
  return `(SELECT SUM(x.amount) FROM flow_parts x WHERE x.flow_id = ${flowCol} AND x.kind IN ${LOAN_CARRYING_PART_KINDS_SQL})`;
}
