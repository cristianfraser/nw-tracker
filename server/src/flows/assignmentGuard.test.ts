import { describe, expect, it } from "vitest";
import { db } from "../db.js";

/**
 * Assignments hang off flows (docs/untangle-flow-identity.md, F9 step 5): a category, «Único», note,
 * big group, piece, link, refund mark or income classification is a `flow_*` row, so adoption on
 * arrival carries it by keeping the flow. This fails when a table outside `flow_*` stores an expense
 * key, or names a movement or a card line by id without being listed here as what it is — a
 * document's own record about that row (evidence, a pairing, a booking), never a user's assignment,
 * which a re-import would strand on a deleted row.
 */
const ROW_ID_REFERENCES: Record<string, string> = {
  cc_expense_line_categories: "a line's own category override: names one line, not its purchase (cuota lines share a plan's flow)",
  cc_installment_purchases: "a plan's source line (conversion keeps the line, F11)",
  cc_manual_payments: "the transfer and planted line a hand-recorded card payment wrote",
  cc_planted_payment_lines: "a planted payment line's registry, until the bank's line replaces it",
  cc_traspaso_deuda_links: "the two legs of one debt reclassification (derived per import)",
  checking_gap_deposit_mirrors: "a mirror's deposit (the row it mirrors)",
  crypto_movement_kinds: "a coin row's kind (structured state of that row)",
  crypto_trade_details: "the exchange's record of that trade",
  cuenta_ahorro_deposit_splits: "how a deposit was funded (the deposit row's facts)",
  f22_settlements: "the bank row a tax settlement was paid with (evidence)",
  fintual_synthetic_retiro_transfers: "the transfer a retiro mail wrote",
  grocery_branch_merchants: "the card line a branch name was learned from (provenance)",
  incoming_wire_bookings: "the transfer and fee a wire booking wrote",
  loan_payments: "the mortgage payment rows (the ledger's own movements)",
  movement_bank_postings: "the day a bank document filed a movement",
  movement_dividend_details: "a dividend's breakdown from its documents",
  movement_event_times: "a movement's timestamp from a broker mail",
  movement_mirror_merges: "the legs a mirror conversion merged (undo record)",
  movement_mirror_pair_rejections: "a refused mirror pairing",
  movement_transfer_notices: "a transfer notice paired with its bank row (rebuilt on every apply)",
  payroll_work_earnings: "the deposit that paid a payslip (a payslip is not a flow yet, F20)",
  payslip_advances: "the deposit that paid an advance",
  pension_contribution_periods: "the payroll month a contribution paid",
  santander_synthetic_cc_payment_transfers: "the transfer a payment receipt wrote",
  transfer_notice_movements: "the movement a transfer mail wrote",
};

const KEY_COLUMN = /purchase_key$/;
const ROW_ID_COLUMN = /^(movement_id|statement_line_id|line_id)$|_movement_id$|_line_id$/;

function columnsByTable(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db
    .prepare(
      `SELECT m.name AS t, p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name`
    )
    .all() as { t: string; c: string }[];
  for (const r of rows) out.set(r.t, [...(out.get(r.t) ?? []), r.c]);
  return out;
}

describe("assignments live on flows", () => {
  it("no table outside flow_* stores an expense key", () => {
    const hits = [...columnsByTable()]
      .filter(([t, cols]) => !t.startsWith("flow_") && cols.some((c) => KEY_COLUMN.test(c)))
      .map(([t]) => t);
    expect(hits).toEqual([]);
  });

  it("every table naming a movement or a card line by id is a document's record, listed with why", () => {
    const hits = [...columnsByTable()]
      .filter(([t, cols]) => !t.startsWith("flow_") && cols.some((c) => ROW_ID_COLUMN.test(c)))
      .map(([t]) => t);
    expect(hits.filter((t) => !(t in ROW_ID_REFERENCES))).toEqual([]);
    // An entry whose table no longer names a row goes (the list only shrinks).
    expect(Object.keys(ROW_ID_REFERENCES).filter((t) => !hits.includes(t))).toEqual([]);
  });
});
