/**
 * A flow's parts (`flow_parts`, migrations 283, 293 and 316; F20 «Parts»): pieces with their own
 * kind, amount and — for a user's piece — category. A part's `amount` is in the currency of the
 * flow it is of (`flows.currency`): a piece of a dollar line is dollars to the cent, a loan
 * payment's parts are pesos. Two families:
 * - `piece`: a user's division of a card or checking line («Desglosar»), read by the line it
 *   breaks down through its flow ({@link FLOW_PARTS_BY_LINE_SQL}); pieces need not cover the line.
 * - the loan payment parts (`flows/loanPaymentParts.ts`): what a mortgage dividendo or a prepago
 *   was made of, on the property leg's flow, adding up to the flow (± 1 peso) unless the user
 *   declared the difference; and the bank fee a prepago's cash leg carried.
 */
import type { FlowKindClass } from "nw-tracker-contracts";

/** Every part kind and the class its pesos belong to (a piece is spending, as its line is). */
export const FLOW_PART_KINDS = {
  piece: "spending",
  principal: "internal",
  extra_principal: "internal",
  interest: "spending",
  insurance_fire: "spending",
  insurance_life: "spending",
  prepayment_charge: "cost",
  bank_fee: "cost",
} as const satisfies Record<string, FlowKindClass>;

export type FlowPartKind = keyof typeof FLOW_PART_KINDS;

export function isFlowPartKind(value: unknown): value is FlowPartKind {
  return typeof value === "string" && Object.hasOwn(FLOW_PART_KINDS, value);
}

/** SQL list of the kinds, for a CHECK constraint. */
export const FLOW_PART_KINDS_SQL = Object.keys(FLOW_PART_KINDS)
  .map((k) => `'${k}'`)
  .join(", ");

/**
 * The kinds a loan payment's flow carries. Principal and extra principal are internal (into the
 * property); interest and the insurances are spending; the prepayment charge is a cost.
 */
export const LOAN_PAYMENT_PART_KINDS = [
  "principal",
  "extra_principal",
  "interest",
  "insurance_fire",
  "insurance_life",
  "prepayment_charge",
] as const satisfies readonly FlowPartKind[];
export type LoanPaymentPartKind = (typeof LOAN_PAYMENT_PART_KINDS)[number];

/** The parts of a dividendo that are its amortization (what the property gains). */
export const LOAN_PRINCIPAL_PART_KINDS_SQL = `('principal', 'extra_principal')`;
/** The parts of a dividendo that are its carrying (interest + insurances), the Expenses page's cost of the cuota. */
export const LOAN_CARRYING_PART_KINDS_SQL = `('interest', 'insurance_fire', 'insurance_life')`;

/**
 * A line's pieces, read by the line they break down: a card line or a checking movement, through
 * its flow. The old `(source, line_id, seq)` shape is what the pieces readers speak.
 */
export const FLOW_PARTS_BY_LINE_SQL = `(
  SELECT 'cc' AS source, l.id AS line_id, p.flow_id, p.seq, p.category_id, p.amount, f.currency, p.note, p.spent_on
  FROM flow_parts p JOIN flows f ON f.id = p.flow_id JOIN cc_statement_lines l ON l.flow_id = p.flow_id WHERE p.kind = 'piece'
  UNION ALL
  SELECT 'checking' AS source, m.id AS line_id, p.flow_id, p.seq, p.category_id, p.amount, f.currency, p.note, p.spent_on
  FROM flow_parts p JOIN flows f ON f.id = p.flow_id JOIN movements m ON m.flow_id = p.flow_id WHERE p.kind = 'piece'
)`;

/** The row table of a piece source. */
export function pieceSourceTable(source: "cc" | "checking"): "cc_statement_lines" | "movements" {
  return source === "cc" ? "cc_statement_lines" : "movements";
}

/** SQL for the flow of a line (one parameter: the line id). */
export function lineFlowSql(source: "cc" | "checking"): string {
  return `(SELECT flow_id FROM ${pieceSourceTable(source)} WHERE id = ?)`;
}

/** The seq each loan payment part takes on its flow (a piece never shares a flow with them). */
export const LOAN_PAYMENT_PART_SEQ: Readonly<Record<LoanPaymentPartKind, number>> = {
  principal: 0,
  extra_principal: 1,
  interest: 2,
  insurance_fire: 3,
  insurance_life: 4,
  prepayment_charge: 5,
};

/** The `loan_payments` column each loan payment part is read from. */
export const LOAN_PAYMENT_PART_COLUMN: Readonly<Record<LoanPaymentPartKind, string>> = {
  principal: "principal",
  extra_principal: "extra_principal",
  interest: "interest",
  insurance_fire: "insurance_fire",
  insurance_life: "insurance_life",
  prepayment_charge: "prepayment_charge",
};

/**
 * The parts a `loan_payments` property-leg row states, as SQL rows `(flow_id, seq, kind,
 * amount_clp)` — pesos, the property leg's flow being in pesos — one per part column above zero, the pie left out (it is capital, not a
 * payment). `where` narrows the rows (an alias `p` for `loan_payments`, `m` for the movement).
 * Shared by the migration hook that seeds them and the runtime writer that keeps them.
 */
export function loanPaymentPartRowsSql(where = "1"): string {
  return LOAN_PAYMENT_PART_KINDS.map(
    (kind) =>
      `SELECT m.flow_id AS flow_id, ${LOAN_PAYMENT_PART_SEQ[kind]} AS seq, '${kind}' AS kind,
              CAST(round(p.${LOAN_PAYMENT_PART_COLUMN[kind]}) AS INTEGER) AS amount_clp, p.cuota AS cuota
       FROM loan_payments p JOIN movements m ON m.id = p.movement_id
       WHERE p.leg = 'property' AND lower(trim(p.cuota)) <> 'pie' AND m.flow_id IS NOT NULL
         AND round(p.${LOAN_PAYMENT_PART_COLUMN[kind]}) > 0 AND (${where})`
  ).join("\n UNION ALL\n");
}
