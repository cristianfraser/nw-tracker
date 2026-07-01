import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { postCloseLiveBalanceAdjustmentClp } from "./ccBillingBalances.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "./test/vitestDbSeed.js";

/**
 * Live end-of-month balance: activity dated AFTER a statement close and ON/BEFORE the calendar
 * month-end (billed on a later statement) adjusts that month's balance. Payments are negative CLP
 * so a card paid off within its own closing cycle drops that month, not the next.
 */
describe("postCloseLiveBalanceAdjustmentClp", () => {
  const created: number[] = [];

  afterEach(() => {
    for (const sid of created.splice(0)) {
      db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id = ?`).run(sid);
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(sid);
    }
  });

  function masterId(): number | null {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes = ?`)
      .get(VITEST_SANTANDER_CC_MASTER_NOTES) as { id: number } | undefined;
    return row?.id ?? null;
  }

  function newStatement(accountId: number, statementDate: string): number {
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to)
       VALUES (?, 'vitest', 'vitest-postclose.pdf', ?, '27/07/2026', ?)`
    ).run(accountId, statementDate, statementDate);
    const sid = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(sid);
    return sid;
  }

  function addLine(statementId: number, txnIso: string, merchant: string, amountClp: number): void {
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, merchant, amount_clp, installment_flag, transaction_date, dedupe_key)
       VALUES (?, ?, ?, 0, ?, ?)`
    ).run(statementId, merchant, amountClp, txnIso, `vitest-pc-${statementId}-${txnIso}-${amountClp}`);
  }

  it("nets post-close charges and payments dated within the month-end window", () => {
    const id = masterId();
    if (id == null) return;
    // A later statement carries transactions dated in the prior billing month's post-close gap.
    const sid = newStatement(id, "20/08/2026");
    addLine(sid, "2026-07-30", "PAGO", -500_000); // early payoff, dated after the 26-Jul close
    addLine(sid, "2026-07-29", "SUPERMERCADO", 30_000); // late-month charge
    addLine(sid, "2026-07-10", "IGNORED PRE-CLOSE", 99_999); // before close → excluded
    addLine(sid, "2026-08-02", "IGNORED NEXT MONTH", 88_888); // after month-end → excluded

    const adj = postCloseLiveBalanceAdjustmentClp(id, "2026-07-26", "2026-07-31");
    expect(adj).toBe(30_000 - 500_000);
  });

  it("returns 0 when the window is empty or inverted", () => {
    const id = masterId();
    if (id == null) return;
    expect(postCloseLiveBalanceAdjustmentClp(id, "2026-07-31", "2026-07-26")).toBe(0);
    expect(postCloseLiveBalanceAdjustmentClp(id, "", "2026-07-31")).toBe(0);
  });
});
